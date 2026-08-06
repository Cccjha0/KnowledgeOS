import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProcessInboxBatchParams, ProcessInboxItemParams } from "../api/types.js";
import { discoverInstances, discoverModulesForVault } from "../core/discovery.js";
import { PkbError } from "../core/errors.js";
import { ensureDir, exists, fromVaultPath, sha256File, writeJsonAtomic } from "../core/files.js";
import { createGitSnapshot } from "../core/git.js";
import { allocateId } from "../core/ids.js";
import { writeRunLog } from "../core/logs.js";
import { executeOperationPlan } from "../core/operationExecutor.js";
import type { JsonObject, JsonValue, OperationPlan, RunLog } from "../core/types.js";
import { assertMoveSourceNotOpen } from "./obsidianCoordination.js";
import { rebuildTodayDashboard } from "./dashboard.js";
import { discoverInboxItems, type InboxItemView, type InboxStateRecord, writeInboxState } from "./inboxDiscovery.js";
import { RuntimeRepository } from "../runtime/repository.js";
import type { RuntimeTask } from "../runtime/domain.js";
import { resolveWorkflowResourceRequirements } from "../modules/workflowResources.js";
import { formatForExtension, ingestAsset, isAcceptedInput, pdfExtractionDecision, pdfExtractionStatus, type PdfExtractionStatus, type PdfUsePolicy } from "../core/ingestion.js";
import type { RepresentationLevel } from "../core/readLevels.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function normalizedOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function pdfUsePolicy(module: JsonObject): PdfUsePolicy | null {
  const raw = module.pdf_policy;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const policy = raw as JsonObject;
  const statuses = policy.accepted_statuses;
  const accepted = Array.isArray(statuses)
    ? statuses.filter((value): value is PdfExtractionStatus => typeof value === "string" && ["completed", "partial", "empty", "scanned", "encrypted", "corrupted", "unsupported", "failed", "pending"].includes(value))
    : undefined;
  const partial = policy.partial_policy;
  return { ...(accepted ? { accepted_statuses: accepted } : {}), ...(partial === "allow" || partial === "review" ? { partial_policy: partial } : {}) };
}

function assetAccessPolicy(value: unknown): { sensitivityClass: number; maxRepresentation: RepresentationLevel; classificationState: "inherited" } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const policy = value as JsonObject;
  const sensitivity = policy.sensitivity_class;
  const representation = policy.max_representation;
  if (!Number.isInteger(sensitivity) || Number(sensitivity) < 0 || Number(sensitivity) > 3) return null;
  if (representation !== "metadata" && representation !== "summary" && representation !== "full" && representation !== "sensitive-original") return null;
  return { sensitivityClass: Number(sensitivity), maxRepresentation: representation, classificationState: "inherited" };
}

async function inboxAssetPolicy(vaultRoot: string, module: JsonObject, instanceId: string): Promise<{ sensitivityClass: number; maxRepresentation: RepresentationLevel; classificationState: "inherited" } | null> {
  const instance = (await discoverInstances(vaultRoot)).find((candidate) => candidate.data.instance_id === instanceId);
  const instancePolicy = assetAccessPolicy(instance?.data.inbox_asset_policy ?? instance?.data.asset_access_policy);
  if (instancePolicy) return instancePolicy;
  const inbox = module.inbox;
  return assetAccessPolicy(inbox && typeof inbox === "object" && !Array.isArray(inbox) ? (inbox as JsonObject).asset_access_policy : null);
}

async function findItem(vaultRoot: string, itemId: string): Promise<InboxItemView> {
  const item = (await discoverInboxItems(vaultRoot)).find((candidate) => candidate.item_id === itemId);
  if (!item) throw new PkbError("INBOX_ITEM_NOT_FOUND", `Inbox item ${itemId} was not found in a managed Inbox.`);
  return item;
}

function preview(item: InboxItemView, overrides: { moduleId: string | null; instanceId: string | null } = { moduleId: null, instanceId: null }): JsonObject {
  const moduleId = overrides.moduleId ?? item.suggested_module_id;
  const instanceId = overrides.instanceId ?? item.suggested_instance_id;
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
    operation_summary: item.processor === "application-research-report"
      ? { kind: "module-processing", estimated_operations: null, target: "Application Record and Research archive" }
      : item.scope === "global" && moduleId
        ? { kind: "route", estimated_operations: 1, target: instanceId ? `${instanceId} Inbox` : `${moduleId} Inbox` }
        : { kind: "handoff", estimated_operations: 0, target: null },
    risk: item.processor === "application-research-report" ? "mixed-by-module-plan" : "green",
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

async function inboxAiWorkflow(vaultRoot: string, moduleId: string): Promise<{ workflow: string; workflowId: string; workflowVersion: string; entrypoint?: string; resources: RuntimeTask["resources"]; module: JsonObject } | null> {
  const module = (await discoverModulesForVault(ENGINE_ROOT, vaultRoot)).find((entry) => entry.data.id === moduleId && entry.data.status === "enabled");
  if (!module) return null;
  const entryWorkflows = module.data.entry_workflows as JsonObject | undefined;
  if (typeof entryWorkflows?.capture !== "string") return null;
  return {
    workflow: `module:${moduleId}:capture`, workflowId: "capture", workflowVersion: "active", entrypoint: "capture",
    resources: resolveWorkflowResourceRequirements(module, null, "capture"), module: module.data,
  };
}

async function enqueueInboxAiTask(vaultRoot: string, item: InboxItemView, moduleId: string, instanceId: string | null, wake = false, codexModel?: string, codexReasoningEffort?: string): Promise<RuntimeTask | null> {
  const workflow = await inboxAiWorkflow(vaultRoot, moduleId);
  if (!workflow || !instanceId) return null;
  const format = formatForExtension(item.extension);
  if (!format || !isAcceptedInput(workflow.module, format)) return null;
  const assetPolicy = await inboxAssetPolicy(vaultRoot, workflow.module, instanceId);
  const ingestion = format === "markdown" ? null : await ingestAsset(vaultRoot, item.path, assetPolicy ?? {});
  const extractionDecision = ingestion?.format === "pdf" ? pdfExtractionDecision(ingestion, pdfUsePolicy(workflow.module)) : null;
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
      max_attempts: 3, payload: {
        item_id: item.item_id, source_file: item.path, source_hash: sourceHash, module_id: moduleId, instance_id: instanceId,
        ...(effectiveModel ? { codex_model: effectiveModel } : {}),
        ...(effectiveReasoningEffort ? { codex_reasoning_effort: effectiveReasoningEffort } : {}),
        ...(ingestion ? { ingestion: { capture_path: ingestion.capture_path, sidecar_path: ingestion.sidecar_path, format: ingestion.format, content_hash: ingestion.content_hash, original_asset_ref: ingestion.original_asset_ref, extraction_status: extractionStatus, classification_state: ingestion.classification_state } } : {}),
      },
      concurrency_key: `inbox:${item.item_id}`, concurrency_policy: "forbid",
    });
    let task = result.task;
    if (requiresClassification || requiresExtractionAction) {
      if (task.status === "queued") task = repository.transitionTask(task.task_id, "waiting-for-user", { completionReason: null });
    } else if ((wake || previousWasUnclassified) && ["failed", "waiting-for-network", "waiting-for-ai", "waiting-for-user", "deferred", "interrupted"].includes(task.status)) {
      task = repository.retryTask(task.task_id);
    }
    const itemState = requiresClassification || requiresExtractionAction ? "waiting-for-user" : task.status === "running" ? "processing" : task.status === "failed" ? "failed" : task.resources.codex === "required" ? "waiting-for-ai" : "pending";
    await writeInboxState(vaultRoot, stateFor(item, itemState, {
      attempts: task.attempt_count, task_id: task.task_id, error: requiresClassification ? "附件尚未分类；请先确认其隐私等级和允许的读取范围，系统不会将正文交给 AI。" : requiresExtractionAction ? extractionDecision?.requires_review ? "PDF extraction is partial; this module requires a user review before it may be used." : `PDF extraction is ${extractionStatus}; OCR or a text-based PDF is required before AI processing.` : task.last_error?.message ?? null,
      result: { status: requiresClassification || requiresExtractionAction ? "waiting-for-user" : task.status, task_id: task.task_id, workflow: task.workflow, deduplicated: result.deduplicated, ...(requiresClassification ? { classification_state: "unclassified", action_required: "Confirm attachment privacy classification" } : {}), ...(requiresExtractionAction ? { extraction_status: extractionStatus, action_required: extractionDecision?.requires_review ? "Review the partial PDF extraction before processing" : "OCR or a text-based PDF" } : {}) },
    }));
    return task;
  } finally { repository.close(); }
}

export async function materializeInboxAiTasks(vaultRoot: string, codexModel?: string, codexReasoningEffort?: string): Promise<{ created: string[]; deduplicated: number; checked: number }> {
  const output = { created: [] as string[], deduplicated: 0, checked: 0 };
  for (const item of await discoverInboxItems(vaultRoot)) {
    if (item.scope !== "instance" || item.state === "empty" || item.blocked_by_open_editor || item.state === "deferred" || item.state === "ignored" || item.state === "unmanaged" || item.state === "processed") continue;
    const moduleId = item.suggested_module_id; const instanceId = item.suggested_instance_id;
    if (!moduleId || !instanceId || !(await inboxAiWorkflow(vaultRoot, moduleId))) continue;
    output.checked += 1;
    const previousTaskId = item.task_id;
    const task = await enqueueInboxAiTask(vaultRoot, item, moduleId, instanceId, false, codexModel, codexReasoningEffort);
    if (!task) continue;
    if (previousTaskId === task.task_id) output.deduplicated += 1; else output.created.push(task.task_id);
  }
  return output;
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
