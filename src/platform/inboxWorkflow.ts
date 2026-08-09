import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ClassifyInboxAttachmentParams, ProcessInboxBatchParams, ProcessInboxItemParams, ReviewPartialInboxExtractionParams } from "../api/types.js";
import { discoverInstances, discoverModulesForVault, type DiscoveredDocument } from "../core/discovery.js";
import { PkbError } from "../core/errors.js";
import { ensureDir, exists, fromVaultPath, sha256File, writeJsonAtomic } from "../core/files.js";
import { createGitSnapshot } from "../core/git.js";
import { allocateId } from "../core/ids.js";
import { writeRunLog } from "../core/logs.js";
import { executeOperationPlan } from "../core/operationExecutor.js";
import type { JsonObject, JsonValue, OperationPlan, RunLog } from "../core/types.js";
import { assertMoveSourceNotOpen } from "./obsidianCoordination.js";
import { rebuildTodayDashboard } from "./dashboard.js";
import { discoverInboxItems, type InboxItemView, type InboxRequiredUserAction, type InboxStateRecord, writeInboxState } from "./inboxDiscovery.js";
import { RuntimeRepository } from "../runtime/repository.js";
import type { RuntimeTask } from "../runtime/domain.js";
import { resolveWorkflowResourceRequirements } from "../modules/workflowResources.js";
import { effectivePdfUsePolicy, formatForExtension, ingestAsset, isAcceptedInput, parsePdfUsePolicy, pdfExtractionDecision, pdfExtractionStatus, readCaptureEnvelope, updateAssetAccessPolicy } from "../core/ingestion.js";
import { assertRepresentationLevel, assertSensitivityClass, representationPermits, type RepresentationLevel } from "../core/readLevels.js";
import { QualityRepository } from "../quality/repository.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function normalizedOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

interface AssetPolicySuggestion {
  sensitivityClass: number;
  maxRepresentation: RepresentationLevel;
  classificationState: "inherited";
  source: "instance-policy" | "module-policy" | "asset-role";
}

interface InboxAssetRole {
  id: string;
  inboxSubpath: string;
  policy: AssetPolicySuggestion;
  entrypoint: string | null;
  requiredUserAction: InboxRequiredUserAction | null;
}

const INBOX_REQUIRED_USER_ACTIONS = new Set<InboxRequiredUserAction>([
  "select-route",
  "classify-attachment",
  "review-partial-extraction",
  "close-open-file",
  "resolve-review",
]);

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function assetAccessPolicy(value: unknown, source: AssetPolicySuggestion["source"]): AssetPolicySuggestion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const policy = value as JsonObject;
  const sensitivity = policy.sensitivity_class;
  const representation = policy.max_representation;
  if (!Number.isInteger(sensitivity) || Number(sensitivity) < 0 || Number(sensitivity) > 3) return null;
  if (representation !== "metadata" && representation !== "summary" && representation !== "full" && representation !== "sensitive-original") return null;
  return { sensitivityClass: Number(sensitivity), maxRepresentation: representation, classificationState: "inherited", source };
}

async function inboxAssetPolicy(vaultRoot: string, module: JsonObject, instanceId: string): Promise<AssetPolicySuggestion | null> {
  const instance = (await discoverInstances(vaultRoot)).find((candidate) => candidate.data.instance_id === instanceId);
  const instancePolicy = assetAccessPolicy(instance?.data.inbox_asset_policy ?? instance?.data.asset_access_policy, "instance-policy");
  if (instancePolicy) return instancePolicy;
  const inbox = module.inbox;
  return assetAccessPolicy(inbox && typeof inbox === "object" && !Array.isArray(inbox) ? (inbox as JsonObject).asset_access_policy : null, "module-policy");
}

function inboxRole(value: unknown, id: string): InboxAssetRole | null {
  const role = object(value);
  if (!role || typeof role.inbox_subpath !== "string" || !role.inbox_subpath.trim()) return null;
  const policy = assetAccessPolicy(role.asset_access_policy, "asset-role");
  if (!policy) return null;
  const entrypoint = typeof role.entrypoint === "string" && role.entrypoint.trim() ? role.entrypoint.trim() : null;
  const rawAction = role.required_user_action;
  const requiredUserAction = typeof rawAction === "string" && INBOX_REQUIRED_USER_ACTIONS.has(rawAction as InboxRequiredUserAction)
    ? rawAction as InboxRequiredUserAction
    : null;
  if (rawAction !== undefined && !requiredUserAction) {
    throw new PkbError("INBOX_ROLE_ACTION_INVALID", `Inbox role ${id} declares an unsupported required_user_action.`);
  }
  if (!entrypoint && !requiredUserAction) {
    throw new PkbError("INBOX_ROLE_ACTION_REQUIRED", `Inbox role ${id} has no automatic entrypoint and must declare a valid required_user_action.`);
  }
  return {
    id,
    inboxSubpath: role.inbox_subpath.trim(),
    policy,
    entrypoint,
    requiredUserAction,
  };
}

async function inboxAssetRole(vaultRoot: string, module: JsonObject, instanceId: string, item: InboxItemView): Promise<InboxAssetRole | null> {
  const inbox = object(module.inbox);
  const roles = object(inbox?.asset_roles);
  if (!roles) return null;
  const instance = (await discoverInstances(vaultRoot)).find((candidate) => candidate.data.instance_id === instanceId);
  const inboxPath = typeof instance?.data.inbox_path === "string" ? instance.data.inbox_path.replace(/\\/g, "/").replace(/\/+$/, "") : null;
  const relative = inboxPath && item.path.startsWith(`${inboxPath}/`) ? item.path.slice(inboxPath.length + 1) : "";
  const firstSegment = relative.split("/")[0]?.toLocaleLowerCase();
  for (const [id, raw] of Object.entries(roles)) {
    const role = inboxRole(raw, id);
    if (role && firstSegment === role.inboxSubpath.toLocaleLowerCase()) return role;
  }
  const defaultRoleId = typeof inbox?.default_asset_role === "string" ? inbox.default_asset_role : null;
  if (!defaultRoleId) throw new PkbError("INBOX_ROLE_UNRESOLVED", "This module declares Inbox asset roles but no default_asset_role for this Inbox path.");
  if (!Object.prototype.hasOwnProperty.call(roles, defaultRoleId)) {
    throw new PkbError("INBOX_DEFAULT_ROLE_MISSING", `Inbox default asset role ${defaultRoleId} is not declared.`);
  }
  return inboxRole(roles[defaultRoleId], defaultRoleId);
}

function inboxRoleActionMessage(role: InboxAssetRole): string {
  switch (role.requiredUserAction) {
    case "select-route": return `Choose the destination module or instance for this ${role.id} file before processing continues.`;
    case "classify-attachment": return `Classify this ${role.id} attachment's privacy level and permitted representation before processing continues.`;
    case "review-partial-extraction": return `Review the extracted content for this ${role.id} attachment before it can be used.`;
    case "close-open-file": return `Close this ${role.id} file in Obsidian before the requested operation can continue.`;
    case "resolve-review": return `Resolve the required Review for this ${role.id} file before processing continues.`;
    default: return `This ${role.id} file requires an explicit user action before processing continues.`;
  }
}

async function enabledInboxModule(vaultRoot: string, moduleId: string): Promise<DiscoveredDocument | null> {
  return (await discoverModulesForVault(ENGINE_ROOT, vaultRoot)).find((entry) => entry.data.id === moduleId && entry.data.status === "enabled") ?? null;
}

function moduleMaxSensitivity(module: JsonObject): number {
  const permissions = module.permissions;
  const value = permissions && typeof permissions === "object" && !Array.isArray(permissions)
    ? (permissions as JsonObject).max_sensitivity_class
    : null;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3 ? value : 0;
}

function attachmentClassificationDetails(
  item: InboxItemView,
  taskId: string,
  ingestion: Awaited<ReturnType<typeof ingestAsset>>,
  suggestion: AssetPolicySuggestion | null,
  module: JsonObject,
  extractionStatus: string | null,
): JsonObject {
  return {
    task_id: taskId,
    capture_path: ingestion.capture_path,
    classification_state: ingestion.classification_state,
    current_policy: { sensitivity_class: ingestion.sensitivity_class, max_representation: ingestion.access_policy.max_representation },
    suggested_policy: suggestion ? { sensitivity_class: suggestion.sensitivityClass, max_representation: suggestion.maxRepresentation } : null,
    source_of_suggestion: suggestion?.source ?? null,
    requested_representation: item.required_representation,
    module_max_sensitivity: moduleMaxSensitivity(module),
    pdf_extraction_status: extractionStatus,
  };
}

async function findItem(vaultRoot: string, itemId: string): Promise<InboxItemView> {
  const item = (await discoverInboxItems(vaultRoot)).find((candidate) => candidate.item_id === itemId);
  if (!item) throw new PkbError("INBOX_ITEM_NOT_FOUND", `Inbox item ${itemId} was not found in a managed Inbox.`);
  return item;
}

function preview(item: InboxItemView, overrides: { moduleId: string | null; instanceId: string | null } = { moduleId: null, instanceId: null }): JsonObject {
  const moduleId = overrides.moduleId ?? item.suggested_module_id;
  const instanceId = overrides.instanceId ?? item.suggested_instance_id;
  const descriptor = item.processor_descriptor;
  if (item.state === "empty") {
    return {
      status: "preview", item_id: item.item_id, path: item.path, current_state: item.state,
      suggested_ownership: { module_id: moduleId, instance_id: instanceId },
      content_type: item.content_type, confidence: item.confidence, reasons: item.reasons,
      required_representation: "metadata", requires_codex: false, can_auto_process: false, processor: item.processor,
      operation_summary: { kind: "quarantine-empty-inbox-file", estimated_operations: 1, target: "Inbox 恢复区（可通过运行记录撤销）" },
      risk: "green",
    };
  }
  return {
    status: "preview", item_id: item.item_id, path: item.path, current_state: item.state,
    suggested_ownership: { module_id: moduleId, instance_id: instanceId },
    content_type: item.content_type, confidence: item.confidence, reasons: item.reasons,
    required_representation: item.required_representation, requires_codex: item.requires_ai,
    can_auto_process: item.confidence >= item.auto_route_threshold && !item.requires_ai,
    processor: item.processor,
    operation_summary: descriptor
      ? { kind: descriptor.preview_kind ?? "module-processing", estimated_operations: null, target: descriptor.preview_target ?? null, label: descriptor.label ?? null }
      : item.scope === "global" && moduleId
        ? { kind: "route", estimated_operations: 1, target: instanceId ? `${instanceId} Inbox` : `${moduleId} Inbox` }
        : { kind: "handoff", estimated_operations: 0, target: null },
    risk: typeof descriptor?.risk === "string" ? descriptor.risk : "green",
  };
}

function stateFor(item: InboxItemView, state: InboxStateRecord["state"], overrides: Partial<InboxStateRecord> = {}): InboxStateRecord {
  return {
    schema_version: 1, item_id: item.item_id, path: item.path, state,
    attempts: Number(overrides.attempts ?? 0), review_after: overrides.review_after ?? null,
    error: overrides.error ?? null, run_id: overrides.run_id ?? null, plan_id: overrides.plan_id ?? null, task_id: overrides.task_id ?? null,
    result: overrides.result ?? null, updated_at: new Date().toISOString(),
  };
}

async function inboxAiWorkflow(vaultRoot: string, moduleId: string, entrypoint = "capture"): Promise<{ workflow: string; workflowId: string; workflowVersion: string; entrypoint?: string; resources: RuntimeTask["resources"]; module: JsonObject } | null> {
  const module = await enabledInboxModule(vaultRoot, moduleId);
  if (!module) return null;
  const entryWorkflows = module.data.entry_workflows as JsonObject | undefined;
  if (typeof entryWorkflows?.[entrypoint] !== "string") return null;
  return {
    workflow: `module:${moduleId}:${entrypoint}`, workflowId: entrypoint, workflowVersion: "active", entrypoint,
    resources: resolveWorkflowResourceRequirements(module, null, entrypoint), module: module.data,
  };
}

async function holdRoleBoundInboxItem(vaultRoot: string, item: InboxItemView, module: JsonObject, instanceId: string, role: InboxAssetRole): Promise<JsonObject> {
  const format = formatForExtension(item.extension);
  if (!format || !isAcceptedInput(module, format)) return { status: "unsupported", item_id: item.item_id };
  const ingestion = format === "markdown" ? null : await ingestAsset(vaultRoot, item.path, role.policy);
  const extractionStatus = ingestion ? pdfExtractionStatus(ingestion) : null;
  const result: JsonObject = {
    status: "waiting-for-user",
    required_user_action: role.requiredUserAction,
    asset_role: role.id,
    asset_role_message: inboxRoleActionMessage(role),
    ...(ingestion ? { attachment_classification: attachmentClassificationDetails(item, item.task_id ?? "", ingestion, role.policy, module, extractionStatus) } : {}),
  };
  await writeInboxState(vaultRoot, stateFor(item, "waiting-for-user", {
    error: `The ${role.id} Inbox role does not permit generic AI processing. ${inboxRoleActionMessage(role)}`,
    result,
  }));
  return result;
}

async function enqueueInboxAiTask(vaultRoot: string, item: InboxItemView, moduleId: string, instanceId: string | null, wake = false, codexModel?: string, codexReasoningEffort?: string): Promise<RuntimeTask | null> {
  if (!instanceId) return null;
  const moduleDocument = await enabledInboxModule(vaultRoot, moduleId);
  if (!moduleDocument) return null;
  const module = moduleDocument.data;
  const role = await inboxAssetRole(vaultRoot, module, instanceId, item);
  if (role?.requiredUserAction) return null;
  const workflow = await inboxAiWorkflow(vaultRoot, moduleId, role?.entrypoint ?? "capture");
  if (!workflow) return null;
  const format = formatForExtension(item.extension);
  if (!format || !isAcceptedInput(workflow.module, format)) return null;
  const assetPolicy = role?.policy ?? await inboxAssetPolicy(vaultRoot, workflow.module, instanceId);
  const ingestion = format === "markdown" ? null : await ingestAsset(vaultRoot, item.path, assetPolicy ?? {});
  const declaredPdfPolicy = parsePdfUsePolicy(workflow.module.pdf_policy);
  const effectivePdfPolicy = effectivePdfUsePolicy(declaredPdfPolicy);
  const extractionDecision = ingestion?.format === "pdf" ? pdfExtractionDecision(ingestion, effectivePdfPolicy) : null;
  const requiresClassification = ingestion?.classification_state === "unclassified";
  const requiresExtractionAction = extractionDecision !== null && !extractionDecision.usable;
  const extractionStatus = ingestion ? pdfExtractionStatus(ingestion) : null;
  const resources = requiresClassification || requiresExtractionAction ? { ...workflow.resources, codex: "not-required" as const, user: "required" as const } : workflow.resources;
  const sourceHash = await sha256File(fromVaultPath(vaultRoot, item.path));
  const repository = await RuntimeRepository.open(vaultRoot);
  try {
    const previousTask = item.task_id ? repository.getTask(item.task_id) : null;
    const previousIngestion = previousTask?.payload.ingestion;
    const previousWasUnclassified = previousIngestion !== null && typeof previousIngestion === "object" && !Array.isArray(previousIngestion)
      && (previousIngestion as JsonObject).classification_state === "unclassified";
    const effectiveModel = codexModel?.trim() || (typeof previousTask?.payload.codex_model === "string" ? previousTask.payload.codex_model : undefined);
    const effectiveReasoningEffort = codexReasoningEffort?.trim() || (typeof previousTask?.payload.codex_reasoning_effort === "string" ? previousTask.payload.codex_reasoning_effort : undefined);
    const executionProfile = workflow.resources.codex === "required"
      ? `:${effectiveModel || "default"}:${effectiveReasoningEffort || "default"}`
      : ":deterministic";
    const taskPayload: JsonObject = {
      item_id: item.item_id, source_file: item.path, source_hash: sourceHash, module_id: moduleId, instance_id: instanceId,
      ...(role ? { asset_role: role.id } : {}),
      ...(effectiveModel ? { codex_model: effectiveModel } : {}),
      ...(effectiveReasoningEffort ? { codex_reasoning_effort: effectiveReasoningEffort } : {}),
      ...(ingestion ? { ingestion: { capture_path: ingestion.capture_path, sidecar_path: ingestion.sidecar_path, format: ingestion.format, content_hash: ingestion.content_hash, original_asset_ref: ingestion.original_asset_ref, extraction_status: extractionStatus, classification_state: ingestion.classification_state } } : {}),
      ...(ingestion?.format === "pdf" ? { pdf_policy: effectivePdfPolicy, pdf_policy_source: declaredPdfPolicy ? "module-manifest" : "core-default", pdf_extraction_decision: extractionDecision } : {}),
    };
    const result = repository.createTask({
      job_id: `${moduleId}.inbox-processing`, module: moduleId, instance_id: instanceId,
      task_type: "workflow", workflow: workflow.workflow, priority: "normal", scheduled_for: new Date().toISOString(),
      resources,
      trigger: {
        type: "inbox", item_id: item.item_id, source_file: item.path,
        workflow_id: workflow.workflowId, workflow_version: workflow.workflowVersion,
        ...(workflow.entrypoint ? { entrypoint: workflow.entrypoint } : {}),
      },
      catch_up_policy: "latest", idempotency_key: `inbox:${item.item_id}:${sourceHash}:${item.lifecycle_revision}${executionProfile}`,
      max_attempts: 3, payload: taskPayload,
      concurrency_key: `inbox:${item.item_id}`, concurrency_policy: "forbid",
    });
    let task = result.task;
    if (requiresClassification || requiresExtractionAction) {
      if (task.status === "queued") task = repository.transitionTask(task.task_id, "waiting-for-user", { completionReason: null });
    } else if ((wake || previousWasUnclassified) && ["failed", "waiting-for-network", "waiting-for-ai", "waiting-for-user", "deferred", "interrupted"].includes(task.status)) {
      if (previousWasUnclassified) task = repository.refreshWaitingTask(task.task_id, resources, taskPayload);
      task = repository.retryTask(task.task_id);
    }
    const itemState = requiresClassification || requiresExtractionAction ? "waiting-for-user" : task.status === "running" ? "processing" : task.status === "failed" ? "failed" : task.resources.codex === "required" ? "waiting-for-ai" : "pending";
    await writeInboxState(vaultRoot, stateFor(item, itemState, {
      attempts: task.attempt_count, task_id: task.task_id, error: requiresClassification ? "附件尚未分类；请先确认其隐私等级和允许的读取范围，系统不会将正文交给 AI。" : requiresExtractionAction ? extractionDecision?.requires_review ? "PDF extraction is partial; this module requires a user review before it may be used." : `PDF extraction is ${extractionStatus}; OCR or a text-based PDF is required before AI processing.` : task.last_error?.message ?? null,
      result: {
        status: requiresClassification || requiresExtractionAction ? "waiting-for-user" : task.status,
        task_id: task.task_id,
        workflow: task.workflow,
        deduplicated: result.deduplicated,
        ...(ingestion?.format === "pdf" ? { pdf_policy: effectivePdfPolicy, pdf_policy_source: declaredPdfPolicy ? "module-manifest" : "core-default", pdf_extraction_decision: extractionDecision } : {}),
        ...(requiresClassification && ingestion ? {
          required_user_action: "classify-attachment",
          attachment_classification: attachmentClassificationDetails(item, task.task_id, ingestion, assetPolicy, workflow.module, extractionStatus),
        } : {}),
        ...(requiresExtractionAction ? {
          required_user_action: extractionDecision?.requires_review ? "review-partial-extraction" : "resolve-review",
          extraction_status: extractionStatus,
          attachment_classification: ingestion ? attachmentClassificationDetails(item, task.task_id, ingestion, assetPolicy, workflow.module, extractionStatus) : null,
        } : {}),
      },
    }));
    return task;
  } finally { repository.close(); }
}

export async function materializeInboxAiTasks(vaultRoot: string, codexModel?: string, codexReasoningEffort?: string): Promise<{ created: string[]; deduplicated: number; checked: number }> {
  const output = { created: [] as string[], deduplicated: 0, checked: 0 };
  for (const item of await discoverInboxItems(vaultRoot)) {
    if (item.scope !== "instance" || item.state === "empty" || item.blocked_by_open_editor || item.state === "deferred" || item.state === "ignored" || item.state === "unmanaged" || item.state === "processed") continue;
    const moduleId = item.suggested_module_id; const instanceId = item.suggested_instance_id;
    if (!moduleId || !instanceId) continue;
    const moduleDocument = await enabledInboxModule(vaultRoot, moduleId);
    if (!moduleDocument) continue;
    const module = moduleDocument.data;
    output.checked += 1;
    const role = await inboxAssetRole(vaultRoot, module, instanceId, item);
    if (role?.requiredUserAction) {
      await holdRoleBoundInboxItem(vaultRoot, item, module, instanceId, role);
      continue;
    }
    if (!(await inboxAiWorkflow(vaultRoot, moduleId, role?.entrypoint ?? "capture"))) continue;
    const previousTaskId = item.task_id;
    const task = await enqueueInboxAiTask(vaultRoot, item, moduleId, instanceId, false, codexModel, codexReasoningEffort);
    if (!task) continue;
    if (previousTaskId === task.task_id) output.deduplicated += 1; else output.created.push(task.task_id);
  }
  return output;
}

/**
 * The Inbox-safe completion of attachment classification. This keeps the
 * policy mutation, wait-task refresh, requeue, Inbox state, and Today refresh
 * inside one Core command instead of asking the plugin to coordinate them.
 */
export async function classifyInboxAttachment(vaultRoot: string, params: ClassifyInboxAttachmentParams): Promise<JsonObject> {
  if (!params.item_id?.trim()) throw new PkbError("INVALID_REQUEST", "item_id is required.");
  const item = await findItem(vaultRoot, params.item_id);
  const moduleId = item.suggested_module_id;
  const instanceId = item.suggested_instance_id;
  if (!moduleId || !instanceId) throw new PkbError("INBOX_ROUTE_REQUIRED", "Choose a module and instance before classifying this attachment.");
  const workflow = await inboxAiWorkflow(vaultRoot, moduleId);
  if (!workflow) throw new PkbError("INBOX_WORKFLOW_NOT_FOUND", `The ${moduleId} Inbox workflow is not available.`);
  const taskId = item.task_id;
  if (!taskId) throw new PkbError("INBOX_CLASSIFICATION_NOT_READY", "This Inbox attachment has not yet created a managed task.");
  const repository = await RuntimeRepository.open(vaultRoot);
  try {
    const task = repository.getTask(taskId);
    const ingestion = task?.payload.ingestion;
    if (!ingestion || typeof ingestion !== "object" || Array.isArray(ingestion) || typeof (ingestion as JsonObject).capture_path !== "string") {
      throw new PkbError("INBOX_CLASSIFICATION_NOT_READY", "This Inbox item has no managed attachment capture to classify.");
    }
    const capturePath = String((ingestion as JsonObject).capture_path);
    const before = await readCaptureEnvelope(vaultRoot, capturePath);
    if (before.classification_state !== "unclassified") {
      throw new PkbError("INBOX_ATTACHMENT_ALREADY_CLASSIFIED", "This attachment is already classified. Refresh Inbox before continuing.");
    }
    const sensitivity = assertSensitivityClass(params.sensitivity_class, "sensitivity_class");
    const representation = assertRepresentationLevel(params.max_representation, "max_representation");
    const permittedSensitivity = moduleMaxSensitivity(workflow.module);
    if (sensitivity > permittedSensitivity) {
      throw new PkbError("MODULE_SENSITIVITY_DENIED", `This module may only read up to sensitivity class ${permittedSensitivity}. Choose a lower privacy class or route the file to another module.`);
    }
    if (!representationPermits(representation, item.required_representation)) {
      throw new PkbError("ATTACHMENT_REPRESENTATION_TOO_RESTRICTIVE", `This workflow requires ${item.required_representation}, but the selected attachment policy only permits ${representation}.`);
    }
    const updated = await updateAssetAccessPolicy(vaultRoot, capturePath, { sensitivity_class: sensitivity, max_representation: representation });
    const quality = await QualityRepository.open(vaultRoot);
    try {
      quality.recordChange({
        entity_ref: `[[${updated.companion_note_path}]]`, field: "access_policy",
        old_value: { sensitivity_class: before.sensitivity_class, max_representation: before.access_policy.max_representation },
        new_value: { sensitivity_class: updated.sensitivity_class, max_representation: updated.access_policy.max_representation },
        reason: "User classified an Inbox attachment and resumed its managed task.", evidence_refs: [], generation: null,
        review: { status: "user-direct", reviewed_by: "user", reviewed_at: new Date().toISOString() }, changed_at: new Date().toISOString(),
      });
    } finally { quality.close(); }
    const refreshedItem = await findItem(vaultRoot, item.item_id);
    const resumed = await enqueueInboxAiTask(vaultRoot, refreshedItem, moduleId, instanceId, true);
    await rebuildTodayDashboard(vaultRoot);
    if (!resumed) throw new PkbError("INBOX_WORKFLOW_NOT_FOUND", `The ${moduleId} Inbox workflow could not be resumed.`);
    return {
      status: resumed.status,
      ui_state: resumed.status === "queued" && resumed.resources.codex === "required" ? "waiting-for-ai" : resumed.status,
      item_id: item.item_id,
      task_id: resumed.task_id,
      capture_path: updated.capture_path,
      classification_state: updated.classification_state,
      access_policy: updated.access_policy,
      companion_note_path: updated.companion_note_path,
      resumed: resumed.status !== "waiting-for-user",
    };
  } finally { repository.close(); }
}

/**
 * Records an explicit user inspection of partial PDF text before requeueing
 * the same task. The module policy still gates this path: only a policy that
 * says `partial_policy: review` can be acknowledged here.
 */
export async function reviewPartialInboxExtraction(vaultRoot: string, params: ReviewPartialInboxExtractionParams): Promise<JsonObject> {
  if (!params.item_id?.trim()) throw new PkbError("INVALID_REQUEST", "item_id is required.");
  if (params.decision !== "approve-extracted-text" && params.decision !== "keep-waiting") throw new PkbError("INVALID_REQUEST", "A partial PDF review decision is required.");
  const item = await findItem(vaultRoot, params.item_id);
  if (params.decision === "keep-waiting") return { status: "waiting-for-user", item_id: item.item_id, kept_waiting: true };
  if (!item.task_id || !item.suggested_module_id) throw new PkbError("INBOX_PARTIAL_REVIEW_NOT_READY", "This Inbox item has no managed partial-PDF task to review.");
  const workflow = await inboxAiWorkflow(vaultRoot, item.suggested_module_id);
  if (!workflow) throw new PkbError("INBOX_WORKFLOW_NOT_FOUND", `The ${item.suggested_module_id} Inbox workflow is not available.`);
  const repository = await RuntimeRepository.open(vaultRoot);
  try {
    const task = repository.getTask(item.task_id);
    const decision = task?.payload.pdf_extraction_decision;
    const ingestion = task?.payload.ingestion;
    if (!task || !decision || typeof decision !== "object" || Array.isArray(decision) || (decision as JsonObject).status !== "partial" || (decision as JsonObject).requires_review !== true) {
      throw new PkbError("INBOX_PARTIAL_REVIEW_NOT_READY", "This task is not waiting for a partial PDF extraction review.");
    }
    if (!ingestion || typeof ingestion !== "object" || Array.isArray(ingestion) || typeof (ingestion as JsonObject).capture_path !== "string") {
      throw new PkbError("INBOX_PARTIAL_REVIEW_NOT_READY", "This partial PDF has no managed Capture Envelope.");
    }
    const capturePath = String((ingestion as JsonObject).capture_path);
    const envelope = await readCaptureEnvelope(vaultRoot, capturePath);
    const approvedAt = new Date().toISOString();
    const userReview: JsonObject = { decision: "approve-extracted-text", reviewed_by: "user", reviewed_at: approvedAt, capture_path: capturePath };
    const payload: JsonObject = {
      ...task.payload,
      pdf_user_review: userReview,
    };
    let refreshed = repository.refreshWaitingTask(task.task_id, workflow.resources, payload);
    refreshed = repository.retryTask(refreshed.task_id);
    const itemState = refreshed.resources.codex === "required" ? "waiting-for-ai" : "pending";
    await writeInboxState(vaultRoot, stateFor(item, itemState, {
      attempts: refreshed.attempt_count,
      task_id: refreshed.task_id,
      error: null,
      result: { status: refreshed.status, task_id: refreshed.task_id, workflow: refreshed.workflow, pdf_extraction_review: userReview },
    }));
    const quality = await QualityRepository.open(vaultRoot);
    try {
      quality.recordChange({
        entity_ref: `[[${envelope.companion_note_path}]]`, field: "pdf_extraction_review",
        old_value: null, new_value: userReview,
        reason: "User reviewed a partial PDF extraction and approved the extracted text for this managed workflow.", evidence_refs: [], generation: null,
        review: { status: "user-direct", reviewed_by: "user", reviewed_at: approvedAt }, changed_at: approvedAt,
      });
    } finally { quality.close(); }
    await rebuildTodayDashboard(vaultRoot);
    return { status: refreshed.status, ui_state: refreshed.resources.codex === "required" ? "waiting-for-ai" : refreshed.status, item_id: item.item_id, task_id: refreshed.task_id, resumed: true };
  } finally { repository.close(); }
}

async function acquireItemLock(vaultRoot: string, itemId: string): Promise<FileHandle> {
  const file = path.join(vaultRoot, "90-System", "State", "Locks", `inbox-${itemId}.lock`);
  await ensureDir(path.dirname(file));
  try {
    const handle = await fs.open(file, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, item_id: itemId, acquired_at: new Date().toISOString() }));
    return handle;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      let pid: number | null = null;
      try { pid = Number(JSON.parse(await fs.readFile(file, "utf8")).pid); } catch { pid = null; }
      if (pid && Number.isInteger(pid)) {
        try { process.kill(pid, 0); throw new PkbError("INBOX_ITEM_IN_PROGRESS", `Inbox item ${itemId} is already being processed.`); }
        catch (lockError) { if (lockError instanceof PkbError) throw lockError; }
      }
      await fs.unlink(file).catch(() => undefined);
      const handle = await fs.open(file, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, item_id: itemId, acquired_at: new Date().toISOString(), recovered_stale_lock: true }));
      return handle;
    }
    throw error;
  }
}

async function releaseItemLock(vaultRoot: string, itemId: string, handle: FileHandle): Promise<void> {
  await handle.close().catch(() => undefined);
  await fs.unlink(path.join(vaultRoot, "90-System", "State", "Locks", `inbox-${itemId}.lock`)).catch(() => undefined);
}

async function routeDestination(vaultRoot: string, item: InboxItemView, moduleId: string, instanceId: string | null): Promise<string> {
  const modules = (await discoverModulesForVault(ENGINE_ROOT, vaultRoot)).filter((entry) => entry.data.status === "enabled");
  const module = modules.find((entry) => entry.data.id === moduleId);
  if (!module) throw new PkbError("INBOX_ROUTE_INVALID", `Module ${moduleId} is not enabled.`);
  if (instanceId) {
    const instance = (await discoverInstances(vaultRoot)).find((entry) => entry.data.instance_id === instanceId && entry.data.status === "active");
    if (!instance || instance.data.module_id !== moduleId || typeof instance.data.inbox_path !== "string") {
      throw new PkbError("INBOX_ROUTE_INVALID", `Instance ${instanceId} is not an active ${moduleId} instance.`);
    }
    return `${String(instance.data.inbox_path).replace(/\/$/, "")}/${item.filename}`;
  }
  const inbox = module.data.inbox as JsonObject | undefined;
  const level = inbox?.module_level as JsonObject | undefined;
  if (level?.enabled !== true || typeof level.path !== "string") throw new PkbError("INBOX_ROUTE_INVALID", `Module ${moduleId} has no module Inbox.`);
  return `${level.path.replace(/\/$/, "")}/${item.filename}`;
}

async function executeRoute(vaultRoot: string, item: InboxItemView, moduleId: string, instanceId: string | null): Promise<JsonObject> {
  const destination = await routeDestination(vaultRoot, item, moduleId, instanceId);
  if (destination === item.path) return { status: "waiting-for-ai", ui_state: "waiting-for-ai", item_id: item.item_id, path: item.path, reason: "Item is already in the selected module Inbox; its module workflow requires Codex." };
  if (await exists(fromVaultPath(vaultRoot, destination))) throw new PkbError("DESTINATION_EXISTS", `Inbox destination already exists: ${destination}`);
  await assertMoveSourceNotOpen(vaultRoot, item.path);
  const runId = await allocateId(vaultRoot, "RUN");
  const taskId = await allocateId(vaultRoot, "TASK");
  const planId = await allocateId(vaultRoot, "PLAN");
  const plan: OperationPlan = {
    plan_id: planId, task_id: taskId, source_module: moduleId, instance_id: instanceId,
    summary: `Route Inbox item to ${instanceId ?? moduleId}`,
    operations: [{
      operation_id: "OP-001", type: "move-file", target: item.path, risk: "green", confidence: item.confidence,
      idempotency_key: `inbox-route:${createHash("sha256").update(`${item.item_id}:${destination}`).digest("hex")}`,
      payload: { destination }, requires_review_id: null,
    }], review_items: [],
  };
  await writeJsonAtomic(path.join(vaultRoot, "90-System", "State", "Plans", `${planId}.json`), plan);
  const startedAt = new Date().toISOString();
  const snapshot = await createGitSnapshot(vaultRoot, runId);
  await executeOperationPlan(vaultRoot, plan, { allowedTypes: ["move-file"], allowedTargets: [item.path], requiredReviewId: null, gitSnapshot: snapshot });
  const run: RunLog = {
    run_id: runId, task_id: taskId, plan_id: planId, source_module: moduleId, instance_id: instanceId,
    review_id: null, status: "completed", git_snapshot: snapshot, started_at: startedAt, completed_at: new Date().toISOString(), schema_version: 1,
  };
  await writeRunLog(vaultRoot, run, `# ${runId}\n\nRouted Inbox item.\n\n- From: ${item.path}\n- To: ${destination}\n`);
  await writeInboxState(vaultRoot, stateFor(item, "processed", { attempts: 1, run_id: runId, plan_id: planId, result: { destination } }));
  await rebuildTodayDashboard(vaultRoot);
  return { status: "routed", item_id: item.item_id, source: item.path, destination, module_id: moduleId, instance_id: instanceId, run_id: runId, plan_id: planId, snapshot };
}

async function quarantineEmptyItem(vaultRoot: string, item: InboxItemView): Promise<JsonObject> {
  const target = item.path;
  const destination = `90-System/State/Quarantine/Inbox/${item.item_id}-${item.filename}`;
  await assertMoveSourceNotOpen(vaultRoot, target);
  const runId = await allocateId(vaultRoot, "RUN");
  const taskId = await allocateId(vaultRoot, "TASK");
  const planId = await allocateId(vaultRoot, "PLAN");
  const plan: OperationPlan = {
    plan_id: planId, task_id: taskId, source_module: item.suggested_module_id ?? "core", instance_id: item.suggested_instance_id,
    summary: "Move an empty Inbox copy to the recovery area",
    operations: [{
      operation_id: "OP-001", type: "move-file", target, risk: "green", confidence: 1,
      idempotency_key: `inbox-quarantine-empty:${item.item_id}:${await sha256File(fromVaultPath(vaultRoot, target))}`,
      payload: { destination }, requires_review_id: null,
    }], review_items: [],
  };
  await writeJsonAtomic(path.join(vaultRoot, "90-System", "State", "Plans", `${planId}.json`), plan);
  const startedAt = new Date().toISOString();
  const snapshot = await createGitSnapshot(vaultRoot, runId);
  await executeOperationPlan(vaultRoot, plan, { allowedTypes: ["move-file"], allowedTargets: [target], requiredReviewId: null, gitSnapshot: snapshot });
  const run: RunLog = {
    run_id: runId, task_id: taskId, plan_id: planId, source_module: item.suggested_module_id ?? "core", instance_id: item.suggested_instance_id,
    review_id: null, status: "completed", git_snapshot: snapshot, started_at: startedAt, completed_at: new Date().toISOString(), schema_version: 1,
  };
  await writeRunLog(vaultRoot, run, `# ${runId}\n\nMoved an empty Inbox copy to the recovery area.\n\n- From: ${target}\n- To: ${destination}\n`);
  await writeInboxState(vaultRoot, stateFor(item, "ignored", {
    attempts: item.state === "empty" ? 0 : 1, run_id: runId, plan_id: planId,
    result: { status: "quarantined-empty-source", destination, snapshot },
  }));
  await rebuildTodayDashboard(vaultRoot);
  return { status: "quarantined-empty-source", item_id: item.item_id, source: target, destination, run_id: runId, plan_id: planId, snapshot };
}

export async function processInboxItem(vaultRoot: string, params: ProcessInboxItemParams): Promise<JsonObject> {
  if (!params.item_id?.trim()) throw new PkbError("INVALID_REQUEST", "item_id is required.");
  const action = params.action ?? "process";
  const item = await findItem(vaultRoot, params.item_id);
  const moduleId = normalizedOptional(params.module_id) ?? item.suggested_module_id;
  const instanceId = normalizedOptional(params.instance_id) ?? item.suggested_instance_id;
  if (action === "preview") return preview(item, { moduleId, instanceId });
  if (item.state === "empty") {
    if (action === "quarantine-empty") return quarantineEmptyItem(vaultRoot, item);
    if (action !== "ignore" && action !== "unmanage") {
      throw new PkbError("INBOX_EMPTY_SOURCE", "这个 Inbox 文件没有可处理的正文内容。请补充真实内容，或使用“移至恢复区”清理该空白副本。");
    }
  }
  if (action === "defer") {
    if (!params.review_after || !Number.isFinite(Date.parse(params.review_after)) || Date.parse(params.review_after) <= Date.now()) throw new PkbError("INVALID_REQUEST", "review_after must be a future ISO date-time.");
    await writeInboxState(vaultRoot, stateFor(item, "deferred", { review_after: new Date(params.review_after).toISOString() }));
    await rebuildTodayDashboard(vaultRoot);
    return { status: "deferred", item_id: item.item_id, review_after: new Date(params.review_after).toISOString() };
  }
  if (action === "ignore" || action === "unmanage") {
    await writeInboxState(vaultRoot, stateFor(item, action === "ignore" ? "ignored" : "unmanaged"));
    await rebuildTodayDashboard(vaultRoot);
    return { status: action === "ignore" ? "ignored" : "unmanaged", item_id: item.item_id, path: item.path };
  }
  if (item.state === "failed" && action !== "retry") throw new PkbError("INBOX_RETRY_REQUIRED", "Failed Inbox items must be retried explicitly.");
  if (!moduleId) return { status: "waiting-for-user", ui_state: "waiting-for-user", item_id: item.item_id, path: item.path, reason: "No reliable module route is available.", preview: preview(item) };

  const lock = await acquireItemLock(vaultRoot, item.item_id);
  try {
    await writeInboxState(vaultRoot, stateFor(item, "processing", { attempts: action === "retry" ? 2 : 1 }));
    if (item.scope === "global" || action === "route" || moduleId !== item.source_module || instanceId !== item.instance_id) {
      return await executeRoute(vaultRoot, item, moduleId, instanceId);
    }
    if (instanceId) {
      const moduleDocument = await enabledInboxModule(vaultRoot, moduleId);
      const module = moduleDocument?.data ?? null;
      const role = module ? await inboxAssetRole(vaultRoot, module, instanceId, item) : null;
      if (module && role?.requiredUserAction) {
        const waiting = await holdRoleBoundInboxItem(vaultRoot, item, module, instanceId, role);
        await rebuildTodayDashboard(vaultRoot);
        return { ...waiting, ui_state: "waiting-for-user", item_id: item.item_id, path: item.path, module_id: moduleId, instance_id: instanceId };
      }
    }
    const task = await enqueueInboxAiTask(
      vaultRoot,
      item,
      moduleId,
      instanceId,
      action === "retry" || item.state === "waiting-for-ai" || (item.state === "waiting-for-user" && item.blocked_by_open_editor),
      params.codex_model,
      params.codex_reasoning_effort,
    );
    if (task) {
      const requiresCodex = task.resources.codex === "required";
      return {
        status: task.status, ui_state: task.status === "queued" && requiresCodex ? "waiting-for-ai" : task.status,
        item_id: item.item_id, path: item.path, module_id: moduleId, instance_id: instanceId, task_id: task.task_id,
        reason: requiresCodex
          ? task.status === "queued" ? "AI Task is queued and will run when Codex is available." : "AI Task is waiting for Codex."
          : "Module workflow task is queued and will run without Codex.",
      };
    }
    const waiting = { status: "waiting-for-ai", ui_state: "waiting-for-ai", item_id: item.item_id, path: item.path, module_id: moduleId, instance_id: instanceId, reason: "This module workflow requires a Codex handoff, but no managed AI handler is available for this module." };
    await writeInboxState(vaultRoot, stateFor(item, "waiting-for-ai", { attempts: 1, result: waiting }));
    return waiting;
  } catch (error) {
    if (error instanceof PkbError && error.code === "OBSIDIAN_FILE_OPEN") {
      await writeInboxState(vaultRoot, stateFor(item, "waiting-for-user", {
        attempts: 1,
        error: error.message,
        result: { status: "waiting-for-user", coordination: "obsidian-file-open", source_file: item.path },
      })).catch(() => undefined);
      await rebuildTodayDashboard(vaultRoot).catch(() => undefined);
      return {
        status: "waiting-for-user", ui_state: "waiting-for-user", item_id: item.item_id, path: item.path,
        reason: "Close the open Obsidian note before it can be archived.",
      };
    }
    await writeInboxState(vaultRoot, stateFor(item, "failed", { attempts: 1, error: error instanceof Error ? error.message : String(error) })).catch(() => undefined);
    throw error;
  } finally {
    await releaseItemLock(vaultRoot, item.item_id, lock);
  }
}

export async function processInboxBatch(vaultRoot: string, params: ProcessInboxBatchParams): Promise<JsonObject> {
  if (params.mode !== "high-confidence") throw new PkbError("INVALID_REQUEST", "Batch mode must be high-confidence.");
  if (!Array.isArray(params.item_ids) || params.item_ids.length === 0) throw new PkbError("INVALID_REQUEST", "An explicit non-empty item_ids list is required.");
  if (params.item_ids.length > 50) throw new PkbError("INVALID_REQUEST", "A batch can contain at most 50 Inbox items.");
  const unique = [...new Set(params.item_ids)];
  const discovered = await discoverInboxItems(vaultRoot);
  const results: JsonObject[] = [];
  for (const id of unique) {
    const item = discovered.find((candidate) => candidate.item_id === id);
    if (!item) { results.push({ item_id: id, status: "skipped", reason: "not-found" }); continue; }
    if (item.confidence < item.auto_route_threshold) { results.push({ item_id: id, status: "skipped", reason: "below-auto-route-threshold" }); continue; }
    if (item.requires_ai) { results.push({ item_id: id, status: "skipped", reason: "requires-ai" }); continue; }
    try { results.push({ item_id: id, status: "completed", result: await processInboxItem(vaultRoot, { item_id: id, action: item.state === "failed" ? "retry" : "process" }) }); }
    catch (error) { results.push({ item_id: id, status: "failed", error: error instanceof Error ? error.message : String(error) }); }
  }
  return {
    status: "batch-completed", requested: unique.length,
    completed: results.filter((entry) => entry.status === "completed").length,
    skipped: results.filter((entry) => entry.status === "skipped").length,
    failed: results.filter((entry) => entry.status === "failed").length,
    results,
  };
}
