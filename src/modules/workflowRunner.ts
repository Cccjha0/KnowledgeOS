import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMarkdown, parseYaml, validateSchema } from "../core/bridge.js";
import { PkbError } from "../core/errors.js";
import { exists, fromVaultPath, listFilesRecursive, readJson, sha256File, toVaultPath, writeJsonAtomic } from "../core/files.js";
import { createGitSnapshot } from "../core/git.js";
import { allocateId } from "../core/ids.js";
import { executeOperationPlan } from "../core/operationExecutor.js";
import { writeReviewItems } from "../core/reviews.js";
import type { JsonObject, JsonValue, OperationPlan, ReviewItem } from "../core/types.js";
import { discoverInstances, discoverModulesForVault } from "../core/discovery.js";
import { ModuleSdk } from "./sdk.js";
import { getWorkflowStepDefinition } from "./workflowStepRegistry.js";
import { rebuildTodayDashboard } from "../platform/dashboard.js";
import { writeInboxState } from "../platform/inboxDiscovery.js";
import { runManagedCodexStep } from "../runtime/codexAdapter.js";
import { createCodexContextWorkspace, type CodexContextBudget, type CodexContextManifest } from "../runtime/codexContext.js";
import { executeCodexJson, resolveCodexModel, resolveCodexReasoningEffort } from "../runtime/codexCli.js";
import type { RuntimeHandler, WorkerResult } from "../runtime/worker.js";
import { effectivePdfUsePolicy, pdfExtractionDecision, readCaptureEnvelope, readExtractionCache } from "../core/ingestion.js";
import { assertRepresentationLevel, assertSensitivityClass, representationFromLegacyReadLevel, representationPermits, requireSafeSummary, resolveDocumentAccessPolicy, type DocumentAccessPolicy, type RepresentationLevel, type SensitivityClass } from "../core/readLevels.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
type CodexJsonExecutor = typeof executeCodexJson;

interface WorkflowStep extends JsonObject {
  id: string;
  uses: string;
  with: JsonObject;
}

interface ResolvedWorkflow {
  moduleRoot: string;
  manifest: JsonObject;
  instance: JsonObject | null;
  workflow: JsonObject;
  workflowId: string;
  workflowVersion: string;
}

interface DocumentInput extends JsonObject {
  path: string;
  data: JsonObject;
  content: string;
  format: string | null;
  /** The representation actually delivered to this Workflow step. */
  representation: RepresentationLevel;
  /** The representation declared by the Workflow before Core applies policy. */
  requested_representation: RepresentationLevel;
  /** The document's user-controlled sensitivity classification. */
  sensitivity_class: SensitivityClass;
  max_representation: RepresentationLevel;
  policy_source: DocumentAccessPolicy["policy_source"];
}

interface WorkflowState {
  resolved: ResolvedWorkflow;
  schedule: JsonObject;
  values: Map<string, JsonValue>;
  sourceFiles: Set<string>;
  outputFiles: Set<string>;
  planId: string | null;
  snapshot: string | null;
  codexCalls: number;
  eventIds: string[];
  pdfDecisions: Map<string, JsonObject>;
  sdk: ModuleSdk;
  codexContexts: CodexContextManifest[];
}

type RecordOperationMode = "create-record" | "update-record" | "append-record";

/** Maps the public Blueprint record contract onto Core's executable operations. */
export function operationPlanTypeForRecordMode(mode: string): "create-file" | "update-frontmatter" | "append-section" {
  if (mode === "create-record") return "create-file";
  if (mode === "update-record") return "update-frontmatter";
  if (mode === "append-record") return "append-section";
  throw new PkbError("MODULE_WORKFLOW_OPERATION_MODE_INVALID", `Unsupported Blueprint operation.type: ${mode}`);
}

function pendingReviewRequirements(state: WorkflowState): JsonObject[] {
  return [...state.values.values()].flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const result = value as JsonObject;
    return result.review_required === true && Array.isArray(result.matches)
      ? result.matches.filter((match): match is JsonObject => Boolean(match) && typeof match === "object" && !Array.isArray(match)) : [];
  });
}

/** A declared missing-field Review may hold an otherwise incomplete AI result
 * before any Operation is created or executed. It never makes that result
 * automatically writable. */
function hasMissingReviewRule(workflow: JsonObject, output: JsonObject): boolean {
  const declared = Array.isArray(workflow.review_when) ? workflow.review_when : [];
  const materialized = Array.isArray(workflow.steps) ? workflow.steps.flatMap((raw) => {
    const step = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as JsonObject : null;
    const withValue = step?.with && typeof step.with === "object" && !Array.isArray(step.with) ? step.with as JsonObject : null;
    return step?.uses === "core.require-review-if" && Array.isArray(withValue?.rules) ? withValue.rules : [];
  }) : [];
  const rules = declared.length ? declared : materialized;
  return rules.some((raw) => {
    const rule = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as JsonObject : null;
    const condition = rule?.condition;
    const field = typeof rule?.field === "string" ? rule.field.split(".").at(-1) : null;
    return field && (condition === "missing" || condition === "missing-or-conflicting")
      && (output[field] === undefined || output[field] === null || (typeof output[field] === "string" && !output[field].trim()));
  });
}

/** Enforces a role's Codex policy at the final execution boundary. */
export function assertCodexRolePermitted(taskPayload: JsonObject, manifest: JsonObject, workflowContract: JsonObject | null): void {
  const roleId = typeof taskPayload.asset_role === "string" ? taskPayload.asset_role : null;
  if (!roleId) return;
  const contractRoles = object(workflowContract?.role_policies);
  const contractRole = object(contractRoles?.[roleId]);
  const inboxRoles = object(object(manifest.inbox)?.asset_roles);
  const manifestRole = object(inboxRoles?.[roleId]);
  if (contractRole?.allow_codex === false || manifestRole?.allow_codex === false) {
    throw new PkbError("MODULE_WORKFLOW_CODEX_DENIED", `Asset role ${roleId} does not permit Codex for this Workflow.`, {
      asset_role: roleId,
      contract_allow_codex: contractRole?.allow_codex ?? null,
      manifest_allow_codex: manifestRole?.allow_codex ?? null,
    });
  }
}

function object(value: unknown, code = "MODULE_WORKFLOW_INVALID"): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PkbError(code, "Workflow data must be an object.");
  return value as JsonObject;
}

function string(value: unknown, label: string, code = "MODULE_WORKFLOW_INVALID"): string {
  if (typeof value !== "string" || !value.trim()) throw new PkbError(code, `${label} is required.`);
  return value.trim();
}

function relative(value: string, label: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").includes("..") || path.isAbsolute(normalized)) throw new PkbError("MODULE_WORKFLOW_PATH_INVALID", `${label} must be a Vault- or module-relative path.`);
  return normalized;
}

function instanceRoot(instance: JsonObject | null): string {
  const root = typeof instance?.content_root === "string" ? relative(instance.content_root, "instance.content_root") : "";
  if (!root) throw new PkbError("MODULE_WORKFLOW_INSTANCE_REQUIRED", "This workflow step requires an instance content root.");
  return root;
}

function workflowSdk(vaultRoot: string, task: Parameters<RuntimeHandler>[0]["task"], resolved: ResolvedWorkflow): ModuleSdk {
  const contentRoot = resolved.instance ? instanceRoot(resolved.instance) : null;
  const permissions = resolved.manifest.permissions && typeof resolved.manifest.permissions === "object" && !Array.isArray(resolved.manifest.permissions)
    ? resolved.manifest.permissions as JsonObject : {};
  const maxSensitivityClass = assertSensitivityClass(
    typeof permissions.max_sensitivity_class === "number" ? permissions.max_sensitivity_class
      : typeof permissions.max_read_level === "number" ? permissions.max_read_level : 0,
    "permissions.max_sensitivity_class",
  );
  return new ModuleSdk({
    vaultRoot, moduleId: task.module, moduleVersion: String(resolved.manifest.version ?? "unknown"), instanceId: task.instance_id,
    // Module prompts may see only the current instance's data. Module assets
    // are copied by Core into the isolated workspace, never mounted from disk.
    allowedReadRoots: contentRoot ? [contentRoot] : [], ownedWriteRoots: contentRoot ? [contentRoot] : [], maxSensitivityClass,
  });
}

function registry(moduleRoot: string, manifest: JsonObject, key: "schemas" | "prompts" | "workflows"): JsonObject {
  const descriptor = object(manifest[key]);
  const registryPath = relative(string(descriptor.registry, `${key}.registry`), `${key}.registry`);
  const parsed = parseYaml(ENGINE_ROOT, path.join(moduleRoot, ...registryPath.split("/")));
  return object(parsed[key]);
}

function findWorkflowEntry(task: Parameters<RuntimeHandler>[0]["task"], manifest: JsonObject, workflows: JsonObject): JsonObject {
  const triggerId = typeof task.trigger.workflow_id === "string" ? task.trigger.workflow_id : null;
  if (triggerId && workflows[triggerId]) return object(workflows[triggerId]);
  const marker = `module:${task.module}:`;
  if (task.workflow.startsWith(marker)) {
    const entrypoint = task.workflow.slice(marker.length);
    const declared = object(manifest.entry_workflows)[entrypoint];
    if (typeof declared === "string") return { path: declared };
  }
  const suffix = task.workflow.startsWith(`${task.module}:`) ? task.workflow.slice(task.module.length + 1) : task.workflow;
  if (workflows[suffix]) return object(workflows[suffix]);
  throw new PkbError("MODULE_WORKFLOW_UNREGISTERED", `Task ${task.workflow} does not reference a registered workflow for ${task.module}.`);
}

async function resolveWorkflow(task: Parameters<RuntimeHandler>[0]["task"], vaultRoot: string): Promise<ResolvedWorkflow> {
  const module = (await discoverModulesForVault(ENGINE_ROOT, vaultRoot)).find((candidate) => candidate.data.id === task.module && candidate.data.status === "enabled");
  if (!module) throw new PkbError("MODULE_WORKFLOW_MODULE_UNAVAILABLE", `Enabled module ${task.module} was not found.`);
  const instance = task.instance_id ? (await discoverInstances(vaultRoot)).find((candidate) => candidate.data.instance_id === task.instance_id && candidate.data.module_id === task.module) : null;
  if (task.instance_id && !instance) throw new PkbError("MODULE_WORKFLOW_INSTANCE_UNAVAILABLE", `Active ${task.module} instance ${task.instance_id} was not found.`);
  const moduleRoot = path.dirname(module.path);
  const workflows = registry(moduleRoot, module.data, "workflows");
  const entry = findWorkflowEntry(task, module.data, workflows);
  const workflowPath = relative(string(entry.path, "workflow.path"), "workflow.path");
  const workflow = parseYaml(ENGINE_ROOT, workflowPath.startsWith("workflows/")
    ? path.join(moduleRoot, ...workflowPath.split("/"))
    : path.join(moduleRoot, "workflows", ...workflowPath.split("/")));
  const workflowId = string(workflow.workflow_id ?? workflow.id, "workflow_id");
  const workflowVersion = string(workflow.workflow_version ?? workflow.version, "workflow_version");
  // A module entrypoint is an alias selected by Core (for example `capture`),
  // rather than the immutable workflow ID/version itself. Resolve and record
  // the concrete registry version instead of treating the alias as a contract.
  const entrypointAlias = task.workflow.startsWith(`module:${task.module}:`);
  const expectedId = !entrypointAlias && typeof task.trigger.workflow_id === "string" ? task.trigger.workflow_id : workflowId;
  const expectedVersion = !entrypointAlias && typeof task.trigger.workflow_version === "string" ? task.trigger.workflow_version : workflowVersion;
  if (workflowId !== expectedId || workflowVersion !== expectedVersion) throw new PkbError("MODULE_WORKFLOW_VERSION_MISMATCH", `Workflow ${workflowId}@${workflowVersion} does not match Task contract ${expectedId}@${expectedVersion}.`);
  return { moduleRoot, manifest: module.data, instance: instance?.data ?? null, workflow, workflowId, workflowVersion };
}

function dateParts(instant: string, timezone: string): { year: number; month: number; day: number } {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}

function isoWeek(parts: { year: number; month: number; day: number }): { iso_week: string; period_start: string; period_end: string; date: string } {
  const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const weekday = (utc.getUTCDay() + 6) % 7;
  const monday = new Date(utc); monday.setUTCDate(utc.getUTCDate() - weekday);
  const thursday = new Date(monday); thursday.setUTCDate(monday.getUTCDate() + 3);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((thursday.getTime() - yearStart.getTime()) / 86_400_000 - 3 + ((yearStart.getUTCDay() + 6) % 7)) / 7);
  const format = (value: Date) => value.toISOString().slice(0, 10);
  const sunday = new Date(monday); sunday.setUTCDate(monday.getUTCDate() + 6);
  return { iso_week: `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`, period_start: format(monday), period_end: format(sunday), date: format(utc) };
}

function scheduleFor(task: Parameters<RuntimeHandler>[0]["task"], instance: JsonObject | null): JsonObject {
  const timezone = typeof instance?.timezone === "string" ? instance.timezone : "Asia/Shanghai";
  return { timezone, ...isoWeek(dateParts(task.scheduled_for, timezone)), window: task.payload.window ?? task.trigger.window ?? null };
}

function businessDate(value: JsonValue | undefined, timezone: string): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const plainDate = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(value.trim())?.[1];
  if (plainDate && !value.includes("T")) return plainDate;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  const parts = dateParts(instant.toISOString(), timezone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function setScheduleAnchor(state: WorkflowState, task: Parameters<RuntimeHandler>[0]["task"], settings: JsonObject, data: JsonObject): void {
  const anchor = object(settings.time_anchor, "MODULE_WORKFLOW_TIME_ANCHOR_INVALID");
  if (string(anchor.unit, "time_anchor.unit") !== "day") throw new PkbError("MODULE_WORKFLOW_TIME_ANCHOR_INVALID", "Only a day time_anchor is supported.");
  const timezone = String(state.schedule.timezone ?? "Asia/Shanghai");
  const value = businessDate(lookup(data, string(anchor.field, "time_anchor.field")), timezone);
  if (!value) {
    if (anchor.required === false) return;
    throw new PkbError("MODULE_WORKFLOW_TIME_ANCHOR_MISSING", `Capture is missing a valid ${String(anchor.field)} time anchor.`);
  }
  const [year, month, day] = value.split("-").map(Number);
  state.schedule = { timezone, ...isoWeek({ year: year!, month: month!, day: day! }), window: task.payload.window ?? task.trigger.window ?? null };
  state.values.set("schedule", state.schedule);
}

function lookup(root: JsonValue | undefined, dotted: string): JsonValue | undefined {
  let current = root;
  for (const part of dotted.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as JsonObject)[part];
  }
  return current;
}

function interpolate(template: string, state: WorkflowState, task: Parameters<RuntimeHandler>[0]["task"]): string {
  return template.replace(/\{([^}]+)\}/g, (_match, key) => {
    const value = key.startsWith("instance.") ? lookup(state.resolved.instance, key.slice("instance.".length))
      : key.startsWith("schedule.") ? lookup(state.schedule, key.slice("schedule.".length))
        : key.startsWith("task.payload.") ? lookup(task.payload, key.slice("task.payload.".length))
          : key === "task.task_id" ? task.task_id
            : key === "module.id" ? task.module
          : key === "instance_id" ? task.instance_id : undefined;
    if (typeof value !== "string" && typeof value !== "number") throw new PkbError("MODULE_WORKFLOW_TEMPLATE_VALUE_MISSING", `No template value is available for {${key}}.`);
    return String(value);
  });
}

function fixedValue(value: JsonValue, state: WorkflowState, task: Parameters<RuntimeHandler>[0]["task"]): JsonValue {
  if (typeof value === "string") return interpolate(value, state, task);
  if (Array.isArray(value)) return value.map((item) => fixedValue(item, state, task));
  if (!value || typeof value !== "object") return value;
  const objectValue = value as JsonObject;
  if (typeof objectValue.task_id_prefix === "string") {
    const match = /^TASK-(\d{4})-(\d{6,})$/.exec(task.task_id);
    if (!match) throw new PkbError("MODULE_WORKFLOW_TASK_ID_INVALID", `Cannot derive a fixed ID from ${task.task_id}.`);
    return `${objectValue.task_id_prefix}-${match[1]}-${match[2]}`;
  }
  return Object.fromEntries(Object.entries(objectValue).map(([key, item]) => [key, fixedValue(item, state, task)]));
}

function schemaId(moduleRoot: string, manifest: JsonObject, value: string): string {
  if (/^https:\/\//.test(value)) return value;
  const schemas = registry(moduleRoot, manifest, "schemas");
  const entry = schemas[value] ? object(schemas[value]) : Object.values(schemas)
    .map((raw) => object(raw))
    .find((candidate) => `schemas/${String(candidate.path)}` === value || String(candidate.path) === value);
  if (!entry) throw new PkbError("MODULE_WORKFLOW_SCHEMA_UNREGISTERED", `Schema ${value} is not registered.`);
  const file = path.join(moduleRoot, "schemas", ...relative(string(entry.path, "schema.path"), "schema.path").split("/"));
  try { return string(JSON.parse(requireText(file)).$id, "schema.$id"); }
  catch { throw new PkbError("MODULE_WORKFLOW_SCHEMA_INVALID", `Unable to read schema ${value}.`); }
}

function requireText(file: string): string {
  // This helper is intentionally synchronous only for small immutable module assets.
  return readFileSync(file, "utf8");
}

function requestedRepresentation(settings: JsonObject | undefined, label: string): RepresentationLevel {
  const read = settings?.read;
  if (read && typeof read === "object" && !Array.isArray(read)) {
    return assertRepresentationLevel((read as JsonObject).representation, `${label}.read.representation`);
  }
  if (settings?.read_level !== undefined) return representationFromLegacyReadLevel(Number(settings.read_level), `${label}.read_level`);
  return "metadata";
}

function assertDocumentReadable(state: WorkflowState, sourcePath: string, requested: RepresentationLevel, policy: DocumentAccessPolicy): asserts policy is DocumentAccessPolicy & { sensitivity_class: SensitivityClass } {
  if (policy.sensitivity_class === "unknown" || policy.classification_state === "unclassified") {
    throw new PkbError("DOCUMENT_CLASSIFICATION_REQUIRED", `Workflow cannot read ${sourcePath} until its attachment privacy classification is confirmed.`, {
      source_path: sourcePath, requested_representation: requested, classification_state: policy.classification_state,
      document_max_representation: policy.max_representation,
    });
  }
  state.sdk.assertReadable(sourcePath, policy.sensitivity_class);
  if (!representationPermits(policy.max_representation, requested)) {
    throw new PkbError("DOCUMENT_REPRESENTATION_DENIED", `Workflow requested ${requested} for ${sourcePath}, but its policy allows at most ${policy.max_representation}.`, {
      source_path: sourcePath,
      requested_representation: requested,
      document_max_representation: policy.max_representation,
      source_sensitivity_class: policy.sensitivity_class,
      policy_source: policy.policy_source,
    });
  }
}

function materializeDocument(input: { path: string; data: JsonObject; content: string; format: string | null; requested: RepresentationLevel; policy: DocumentAccessPolicy & { sensitivity_class: SensitivityClass } }): DocumentInput {
  return {
    path: input.path,
    data: input.data,
    content: input.requested === "metadata" ? "" : input.requested === "summary" ? requireSafeSummary(input.data, input.path) : input.content,
    format: input.format,
    representation: input.requested,
    requested_representation: input.requested,
    sensitivity_class: input.policy.sensitivity_class,
    max_representation: input.policy.max_representation,
    policy_source: input.policy.policy_source,
  };
}

async function sourceDocument(vaultRoot: string, state: WorkflowState, task: Parameters<RuntimeHandler>[0]["task"], settings?: JsonObject): Promise<DocumentInput> {
  const source = typeof task.payload.source_file === "string" ? task.payload.source_file : typeof task.payload.capture_path === "string" ? task.payload.capture_path : null;
  if (!source) throw new PkbError("MODULE_WORKFLOW_SOURCE_REQUIRED", "The workflow needs payload.source_file or payload.capture_path.");
  if (!state.resolved.instance) throw new PkbError("MODULE_WORKFLOW_INSTANCE_REQUIRED", "This workflow step requires an instance.");
  const normalized = relative(source, "source_file");
  const requested = requestedRepresentation(settings, "source document");
  const ingestion = task.payload.ingestion;
  if (ingestion && typeof ingestion === "object" && !Array.isArray(ingestion) && typeof (ingestion as JsonObject).capture_path === "string") {
    const envelope = await readCaptureEnvelope(vaultRoot, relative(String((ingestion as JsonObject).capture_path), "ingestion.capture_path"));
    if (envelope.source_path !== normalized) throw new PkbError("CAPTURE_ENVELOPE_SOURCE_MISMATCH", "Capture Envelope does not belong to this Inbox source.");
    const policy: DocumentAccessPolicy = { sensitivity_class: envelope.sensitivity_class, classification_state: envelope.classification_state, max_representation: envelope.access_policy.max_representation, policy_source: envelope.policy_source, ...(envelope.legacy_read_level === null ? {} : { legacy_read_level: envelope.legacy_read_level }) };
    assertDocumentReadable(state, normalized, requested, policy);
    const pdfPolicy = effectivePdfUsePolicy(task.payload.pdf_policy ?? state.resolved.manifest.pdf_policy);
    const pdfDecision = pdfExtractionDecision(envelope, pdfPolicy);
    const partialApprovedByUser = Boolean(pdfDecision.status === "partial" && pdfDecision.requires_review
      && task.payload.pdf_user_review && typeof task.payload.pdf_user_review === "object" && !Array.isArray(task.payload.pdf_user_review)
      && (task.payload.pdf_user_review as JsonObject).decision === "approve-extracted-text"
      && (task.payload.pdf_user_review as JsonObject).capture_path === envelope.capture_path);
    if (envelope.format === "pdf") state.pdfDecisions.set(envelope.source_path, {
      source_path: envelope.source_path, capture_path: envelope.capture_path, extraction_status: pdfDecision.status,
      usable: pdfDecision.usable || partialApprovedByUser, requires_review: pdfDecision.requires_review, user_approved: partialApprovedByUser, policy: pdfPolicy,
      policy_source: task.payload.pdf_policy ? String(task.payload.pdf_policy_source ?? "task-payload") : "workflow-resolution",
    });
    if (!pdfDecision.usable && !partialApprovedByUser) {
      throw new PkbError("CAPTURE_EXTRACTION_UNAVAILABLE", `PDF extraction is ${pdfDecision.status}; this Workflow policy does not permit it without user action.`, {
        source_path: envelope.source_path,
        extraction_status: pdfDecision.status,
        capture_path: envelope.capture_path,
        pdf_policy: pdfPolicy,
        requires_review: pdfDecision.requires_review,
      });
    }
    const extraction = await readExtractionCache(vaultRoot, envelope);
    state.sourceFiles.add(normalized); state.sourceFiles.add(envelope.sidecar_path);
    state.sourceFiles.add(envelope.extraction_cache_path);
    return materializeDocument({ path: normalized, data: extraction.structured_data ?? {}, content: extraction.extracted_text, format: envelope.format, requested, policy });
  }
  const document = parseMarkdown(vaultRoot, fromVaultPath(vaultRoot, normalized));
  const policy = resolveDocumentAccessPolicy(document.data);
  assertDocumentReadable(state, normalized, requested, policy);
  state.sourceFiles.add(normalized);
  return materializeDocument({ path: normalized, data: document.data, content: document.content, format: "markdown", requested, policy });
}

function queryValue(value: JsonValue, state: WorkflowState, task: Parameters<RuntimeHandler>[0]["task"]): JsonValue {
  return typeof value === "string" && /^\{[^}]+\}$/.test(value) ? interpolate(value, state, task) : value;
}

function matchesFilters(data: JsonObject, filters: JsonObject, state: WorkflowState, task: Parameters<RuntimeHandler>[0]["task"]): boolean {
  return Object.entries(filters).every(([field, raw]) => {
    const rule = object(raw, "MODULE_QUERY_FILTER_INVALID");
    if (!("equals" in rule) || rule.equals === undefined) throw new PkbError("MODULE_QUERY_FILTER_INVALID", `Filter ${field} requires equals.`);
    return JSON.stringify(lookup(data, field)) === JSON.stringify(queryValue(rule.equals, state, task));
  });
}

function matchesTimeWindow(data: JsonObject, settings: JsonObject, state: WorkflowState, task: Parameters<RuntimeHandler>[0]["task"], relativePath: string): boolean {
  if (settings.time_window === null || settings.time_window === undefined) return true;
  const window = object(settings.time_window, "MODULE_QUERY_TIME_WINDOW_INVALID");
  const field = string(window.field, "time_window.field");
  const unit = string(window.unit, "time_window.unit");
  if (window.reference === undefined) throw new PkbError("MODULE_QUERY_TIME_WINDOW_INVALID", "time_window.reference is required.");
  const reference = string(queryValue(window.reference, state, task), "time_window.reference");
  const timezone = String(state.schedule.timezone ?? "Asia/Shanghai");
  const date = businessDate(lookup(data, field), timezone);
  if (!date) {
    const policy = typeof settings.missing_time === "string" ? settings.missing_time : "fail";
    if (policy === "exclude") return false;
    if (policy !== "fail") throw new PkbError("MODULE_QUERY_TIME_POLICY_INVALID", `Unsupported missing_time policy ${policy}.`);
    throw new PkbError("MODULE_QUERY_TIME_MISSING", `${relativePath} is missing a valid ${field} required by this query.`);
  }
  if (unit === "day") return date === reference;
    if (unit === "week") {
      const [year, month, day] = date.split("-").map(Number);
      return isoWeek({ year: year!, month: month!, day: day! }).iso_week === reference;
    }
    if (unit === "on-or-after") return date >= reference;
  throw new PkbError("MODULE_QUERY_TIME_WINDOW_INVALID", `Unsupported time_window unit ${unit}.`);
}

async function queryDocuments(vaultRoot: string, state: WorkflowState, task: Parameters<RuntimeHandler>[0]["task"], settings: JsonObject): Promise<DocumentInput[]> {
  if (!state.resolved.instance) throw new PkbError("MODULE_WORKFLOW_INSTANCE_REQUIRED", "This workflow step requires an instance.");
  const root = relative(interpolate(string(settings.root, "query-documents.root"), state, task), "query-documents.root");
  const requested = requestedRepresentation(settings, "query-documents");
  state.sdk.assertReadable(root, 0);
  const filters = settings.filters === undefined ? {} : object(settings.filters, "MODULE_QUERY_FILTERS_INVALID");
  const schema = typeof settings.schema === "string" ? schemaId(state.resolved.moduleRoot, state.resolved.manifest, settings.schema) : null;
  const output: DocumentInput[] = [];
  for (const file of await listFilesRecursive(fromVaultPath(vaultRoot, root), ".md")) {
    const relativePath = toVaultPath(vaultRoot, file);
    const parsed = parseMarkdown(vaultRoot, file);
    if (!matchesFilters(parsed.data, filters, state, task)) continue;
    if (!matchesTimeWindow(parsed.data, settings, state, task, relativePath)) continue;
    if (schema) validateSchema(vaultRoot, schema, parsed.data);
    const policy = resolveDocumentAccessPolicy(parsed.data);
    assertDocumentReadable(state, relativePath, requested, policy);
    output.push(materializeDocument({ path: relativePath, data: parsed.data, content: parsed.content, format: "markdown", requested, policy }));
    state.sourceFiles.add(relativePath);
  }
  return output;
}

function documentBody(template: string, data: JsonObject): string {
  const body = template.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  return body.replace(/\{\{([^}]+)\}\}/g, (_match, key) => String(lookup(data, key.trim()) ?? ""));
}

function promptEntry(moduleRoot: string, manifest: JsonObject, id: string): { id: string; version: string; file: string; schema: string } {
  const prompts = registry(moduleRoot, manifest, "prompts");
  const entry = object(prompts[id], "MODULE_WORKFLOW_PROMPT_UNREGISTERED");
  const version = string(entry.active_version, "prompt.active_version");
  const file = path.join(moduleRoot, "prompts", ...relative(string(entry.path, "prompt.path"), "prompt.path").split("/"));
  const raw = requireText(file);
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const metadata = frontmatter ? parseMarkdown(ENGINE_ROOT, file).data : {};
  return { id, version, file, schema: string(metadata.output_schema, "prompt.output_schema") };
}

function generation(task: Parameters<RuntimeHandler>[0]["task"], runId: string, state: WorkflowState, prompt: { id: string; version: string }, model: string, reasoningEffort: string): JsonObject {
  return {
    run_id: runId,
    module: { id: task.module, version: String(state.resolved.manifest.version ?? "unknown") },
    workflow: { id: state.resolved.workflowId, version: state.resolved.workflowVersion },
    prompt: { id: prompt.id, version: prompt.version },
    adapter: "codex-cli", model, reasoning_effort: reasoningEffort, generated_at: new Date().toISOString(),
  };
}

function isDocumentInput(value: JsonValue): value is DocumentInput {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && typeof (value as JsonObject).path === "string"
    && typeof (value as JsonObject).content === "string"
    && (value as JsonObject).data && typeof (value as JsonObject).data === "object"
    && !Array.isArray((value as JsonObject).data));
}

function approvedDocuments(state: WorkflowState): DocumentInput[] {
  const byPath = new Map<string, DocumentInput>();
  const collect = (value: JsonValue): void => {
    if (isDocumentInput(value)) { byPath.set(value.path, value); return; }
    if (Array.isArray(value)) { value.forEach(collect); }
  };
  state.values.forEach(collect);
  return [...byPath.values()];
}

function contextDocumentContent(document: DocumentInput): string {
  // parseMarkdown separates frontmatter from the body. Both are approved task
  // input, so materialize them together without copying the original Vault file.
  const label = document.representation === "metadata" ? "No document body was authorized for this context." : document.content;
  return `# KnowledgeOS structured metadata\n\n\`\`\`json\n${JSON.stringify(document.data, null, 2)}\n\`\`\`\n\n# Authorized ${document.representation} content (Sensitivity Class ${document.sensitivity_class})\n\n${label}`;
}

function contextBudget(workflow: JsonObject): CodexContextBudget {
  const raw = workflow.context_budget;
  if (raw === undefined) return { max_files: 50, max_total_bytes: 500_000, max_file_bytes: 50_000, max_estimated_tokens: 125_000, overflow_policy: "truncate-and-review" };
  const value = object(raw, "CONTEXT_BUDGET_INVALID");
  const budget = {
    max_files: value.max_files,
    max_total_bytes: value.max_total_bytes,
    max_file_bytes: value.max_file_bytes,
    max_estimated_tokens: value.max_estimated_tokens,
    overflow_policy: value.overflow_policy,
  };
  for (const key of ["max_files", "max_total_bytes", "max_file_bytes", "max_estimated_tokens"] as const) {
    if (!Number.isInteger(budget[key]) || Number(budget[key]) <= 0) throw new PkbError("CONTEXT_BUDGET_INVALID", `context_budget.${key} must be a positive integer.`);
  }
  if (budget.overflow_policy !== "truncate-and-review") throw new PkbError("CONTEXT_BUDGET_INVALID", "context_budget.overflow_policy must be truncate-and-review.");
  return budget as CodexContextBudget;
}

async function createPromptContext(state: WorkflowState, task: Parameters<RuntimeHandler>[0]["task"], promptText: string): Promise<ReturnType<typeof createCodexContextWorkspace>> {
  const documents = approvedDocuments(state);
  const sourcePath = typeof task.payload.source_file === "string" ? relative(task.payload.source_file, "source_file")
    : typeof task.payload.capture_path === "string" ? relative(task.payload.capture_path, "capture_path") : null;
  const primary = (sourcePath ? documents.find((document) => document.path === sourcePath) : undefined) ?? documents[0] ?? {
    path: "runtime-input.md", data: {}, content: "# Workflow input\n\nNo document body was supplied. Use the instance and runtime context only.\n", format: null,
    representation: "metadata", requested_representation: "metadata", sensitivity_class: 0, max_representation: "metadata", policy_source: "default",
  } satisfies DocumentInput;
  const related = documents.filter((document) => document.path !== primary.path);
  const context = await createCodexContextWorkspace({
    modulePrompt: promptText,
    instanceContext: state.resolved.instance ?? {},
    runtimeContext: {
      task_id: task.task_id,
      module: task.module,
      instance_id: task.instance_id,
      workflow: { id: state.resolved.workflowId, version: state.resolved.workflowVersion },
      schedule: state.schedule,
      approved_input_files: [primary.path, ...related.map((document) => document.path)],
      pdf_inputs: [...state.pdfDecisions.values()],
    },
    primary: { source_path: primary.path, content: contextDocumentContent(primary), sensitivity_class: primary.sensitivity_class, requested_representation: primary.requested_representation, representation: primary.representation, policy_source: primary.policy_source },
    related: related.map((document) => ({ source_path: document.path, content: contextDocumentContent(document), sensitivity_class: document.sensitivity_class, requested_representation: document.requested_representation, representation: document.representation, policy_source: document.policy_source })),
    allowedReadRoots: state.sdk.context.allowedReadRoots,
    maxSensitivityClass: state.sdk.context.maxSensitivityClass,
    budget: contextBudget(state.resolved.workflow),
  });
  // The runner reads this information before launching Codex. It makes the
  // audit trail useful without persisting private document content or a temp path.
  state.codexContexts.push(context.manifest);
  if (context.manifest.budget.review_required) {
    await context.cleanup();
    throw new PkbError("CONTEXT_BUDGET_REVIEW_REQUIRED", "The approved context exceeds this Workflow's budget. Review the budget or narrow the input set before running Codex.", {
      candidate_files: context.manifest.budget.candidate_files,
      included_files: context.manifest.budget.included_files,
      excluded_file_count: context.manifest.budget.excluded_file_count,
      truncated_file_count: context.manifest.budget.truncated_file_count,
      overflow_policy: context.manifest.budget.overflow_policy,
    });
  }
  return context;
}

export function createModuleWorkflowRunner(executeJson: CodexJsonExecutor = executeCodexJson): RuntimeHandler {
  return async ({ vaultRoot, task, runId, checkpoint }): Promise<WorkerResult> => {
    const resolved = await resolveWorkflow(task, vaultRoot);
    const state: WorkflowState = {
      resolved, schedule: scheduleFor(task, resolved.instance), values: new Map([["instance", resolved.instance ?? {}], ["schedule", {}]]),
      sourceFiles: new Set(), outputFiles: new Set(), planId: null, snapshot: null, codexCalls: 0,
      sdk: workflowSdk(vaultRoot, task, resolved), codexContexts: [], eventIds: [], pdfDecisions: new Map(),
    };
    state.values.set("schedule", state.schedule);
    const steps = (resolved.workflow.steps as unknown[] ?? []).map((raw) => {
      const step = object(raw); return { id: string(step.id, "step.id"), uses: string(step.uses, "step.uses"), with: (step.with && typeof step.with === "object" && !Array.isArray(step.with) ? step.with : {}) as JsonObject } satisfies WorkflowStep;
    });
    if (!steps.length) throw new PkbError("MODULE_WORKFLOW_EMPTY", `${resolved.workflowId} has no steps.`);
    for (const step of steps) {
      checkpoint();
      const definition = getWorkflowStepDefinition(step.uses);
      if (!definition) throw new PkbError("WORKFLOW_STEP_UNSUPPORTED", `${resolved.workflowId} uses unsupported step ${step.uses}.`);
      if (definition.execute) {
        const sourceFile = typeof task.payload.source_file === "string" ? relative(task.payload.source_file, "source_file")
          : typeof task.payload.capture_path === "string" ? relative(task.payload.capture_path, "capture_path") : null;
        const result = await definition.execute({
          vaultRoot, task, runId, moduleId: task.module, moduleVersion: String(resolved.manifest.version ?? "unknown"),
          instance: resolved.instance, with: fixedValue(step.with, state, task) as JsonObject, sourceFile, getValue: (key) => state.values.get(key),
          allocateId: (prefix) => allocateId(vaultRoot, prefix),
        });
        state.values.set(step.id, result);
        if (definition.id === "core.publish-event" && result && typeof result === "object" && !Array.isArray(result) && typeof (result as JsonObject).event_id === "string") state.eventIds.push(String((result as JsonObject).event_id));
        continue;
      }
      if (step.uses === "core.validate-capture") {
        const capture = await sourceDocument(vaultRoot, state, task, step.with);
        // A Capture can come from Quick Capture (typed frontmatter) or a user
        // dropping a plain Markdown note into an instance Inbox. The runner
        // validates that it is material, while the module Prompt classifies it.
        if (!capture.content.trim() && !Object.keys(capture.data).length) throw new PkbError("MODULE_WORKFLOW_CAPTURE_INVALID", `${capture.path} is empty.`);
        state.values.set(step.id, capture);
      } else if (step.uses === "core.parse-structured-document") {
        const parsed = await sourceDocument(vaultRoot, state, task, step.with);
        if (typeof step.with.output_schema === "string") validateSchema(vaultRoot, schemaId(resolved.moduleRoot, resolved.manifest, step.with.output_schema), parsed.data);
        if (step.with.time_anchor !== undefined) setScheduleAnchor(state, task, step.with, parsed.data);
        state.values.set(step.id, parsed);
      } else if (step.uses === "core.query-documents") {
        state.values.set(step.id, await queryDocuments(vaultRoot, state, task, step.with));
      } else if (step.uses === "codex.prompt") {
        assertCodexRolePermitted(task.payload, resolved.manifest, object(resolved.workflow.blueprint_contract));
        const prompt = promptEntry(resolved.moduleRoot, resolved.manifest, string(step.with.prompt_id, "codex.prompt.prompt_id"));
        const outputSchema = typeof step.with.output_schema === "string" ? schemaId(resolved.moduleRoot, resolved.manifest, step.with.output_schema) : prompt.schema;
        if (typeof step.with.skip_if_valid_schema === "string") {
          const existing = await sourceDocument(vaultRoot, state, task, step.with);
          try {
            validateSchema(vaultRoot, schemaId(resolved.moduleRoot, resolved.manifest, step.with.skip_if_valid_schema), existing.data);
            state.values.set(step.id, existing.data);
            continue;
          } catch { /* the prompt will normalize a non-conforming source */ }
        }
        const model = resolveCodexModel(typeof task.payload.codex_model === "string" ? task.payload.codex_model : undefined);
        const reasoningEffort = resolveCodexReasoningEffort(typeof task.payload.codex_reasoning_effort === "string" ? task.payload.codex_reasoning_effort : undefined);
        const managed = await runManagedCodexStep(vaultRoot, {
          task_id: task.task_id, run_id: runId, prompt_id: prompt.id, prompt_version: prompt.version, adapter: "codex-cli", model, reasoning_effort: reasoningEffort,
          output_schema: outputSchema, module: task.module, instance_id: task.instance_id, workflow_id: resolved.workflowId, workflow_version: resolved.workflowVersion,
        }, async ({ repair_format }) => {
          const promptText = await fs.readFile(prompt.file, "utf8");
          const context = await createPromptContext(state, task, promptText);
          const request = [
            "Read global-rules.md, module-prompt.md, instance-context.yaml, runtime-context.json, primary-input.md, and any files in related/ before answering.",
            "Only those files are authorized input. Return only the structured JSON required by module-prompt.md.",
            repair_format ? "Repair the previous result format and return JSON that conforms to the declared schema." : "",
          ].filter(Boolean).join("\n");
          let result: Awaited<ReturnType<CodexJsonExecutor>>;
          try { result = await executeJson({ contextRoot: context.root, prompt: request, model, reasoningEffort }); }
          finally { await context.cleanup(); }
          const raw = object(result.output, "CODEX_OUTPUT_INVALID");
          const fixed = step.with.fixed_fields && typeof step.with.fixed_fields === "object" && !Array.isArray(step.with.fixed_fields)
            ? fixedValue(step.with.fixed_fields as JsonObject, state, task) as JsonObject : {};
          const nullDefaults = Array.isArray(step.with.default_null_fields)
            ? Object.fromEntries(step.with.default_null_fields.filter((key): key is string => typeof key === "string" && raw[key] === undefined).map((key) => [key, null])) : {};
          return { output: { ...raw, ...nullDefaults, ...fixed, generation: generation(task, runId, state, prompt, model, reasoningEffort) } };
        }, (output) => {
          try { validateSchema(vaultRoot, outputSchema, output); return true; }
          catch { return Boolean(output && typeof output === "object" && !Array.isArray(output) && hasMissingReviewRule(resolved.workflow, output as JsonObject)); }
        });
        state.values.set(step.id, managed.output);
        state.codexCalls += 1;
      } else if (step.uses === "core.build-operation-plan") {
        if (typeof step.with.plan_from === "string") {
          const prepared = object(state.values.get(step.with.plan_from), "MODULE_WORKFLOW_PLAN_MISSING");
          const plan = prepared.plan === null ? null : object(prepared.plan, "MODULE_WORKFLOW_PLAN_INVALID") as unknown as OperationPlan;
          if (!plan) {
            state.values.set(step.id, { skipped: true });
            continue;
          }
          if (typeof step.with.normalize_source_from === "string" && (await sourceDocument(vaultRoot, state, task, step.with)).format === "markdown") {
            const normalized = object(state.values.get(step.with.normalize_source_from), "MODULE_WORKFLOW_NORMALIZED_OUTPUT_MISSING");
            const source = await sourceDocument(vaultRoot, state, task, step.with);
            const removeTopLevel = Object.keys(source.data).filter((key) => !(key in normalized));
            plan.operations.unshift({
              operation_id: "OP-000", type: "update-frontmatter", target: source.path, risk: "green", confidence: Number(normalized.confidence ?? 1),
              idempotency_key: `normalize:${task.idempotency_key}:${String(normalized.report_id ?? step.with.normalize_source_from)}`,
              payload: {
                patch: normalized, replace_top_level: Object.keys(normalized), remove_top_level: removeTopLevel, actor: "ai",
                ...(typeof step.with.source_schema === "string" ? { schema_id: schemaId(resolved.moduleRoot, resolved.manifest, step.with.source_schema) } : {}),
              },
              requires_review_id: null,
            });
            plan.operations.forEach((operation, index) => { operation.operation_id = `OP-${String(index + 1).padStart(3, "0")}`; });
          }
          await writeJsonAtomic(path.join(vaultRoot, "90-System", "State", "Plans", `${plan.plan_id}.json`), plan);
          const snapshot = await createGitSnapshot(vaultRoot, runId);
          await executeOperationPlan(vaultRoot, plan, {
            allowedTypes: ["create-file", "update-frontmatter", "append-section", "move-file"],
            allowedTargets: plan.operations.map((operation) => operation.target!).filter(Boolean), requiredReviewId: null, gitSnapshot: snapshot,
          });
          // Preserve the exact Capture/Task that produced a Review. This is
          // required both for user explanation and for fixture tests to prove
          // an ambiguous input created *its own* Review rather than relying on
          // a Review left by an earlier scenario.
          for (const review of plan.review_items) {
            review.origin_task_id = task.task_id;
            if (typeof task.payload.item_id === "string") review.item_id = task.payload.item_id;
            if (typeof task.payload.source_file === "string") review.source_file = task.payload.source_file;
          }
          await writeReviewItems(vaultRoot, plan.review_items);
          if (step.with.record_processed_report === true && typeof prepared.report === "object" && typeof prepared.destination === "string" && typeof prepared.reportHash === "string") {
            const report = object(prepared.report, "MODULE_WORKFLOW_REPORT_MISSING");
            const reportId = string(report.report_id, "report_id");
            const processedPath = path.join(vaultRoot, "90-System", "State", "processed-reports.json");
            const processed = await readJson<{ reports: Record<string, JsonObject> }>(processedPath, { reports: {} });
            const destination = fromVaultPath(vaultRoot, prepared.destination);
            processed.reports[reportId] = {
              // The normalizing operation may have changed frontmatter before
              // the report was archived. Persist the archive hash so a later
              // user move back to Inbox is recognized as the same document.
              hash: await sha256File(destination), processed_at: new Date().toISOString(), run_id: runId, destination: prepared.destination,
            };
            await writeJsonAtomic(processedPath, processed);
          }
          state.planId = plan.plan_id; state.snapshot = snapshot;
          for (const operation of plan.operations) if (operation.target) state.outputFiles.add(operation.type === "move-file" && typeof operation.payload.destination === "string" ? operation.payload.destination : operation.target);
          state.values.set(step.id, plan);
          continue;
        }
        const outputKey = typeof step.with.output === "string" ? step.with.output : steps.slice(0, steps.indexOf(step)).reverse().find((candidate) => candidate.uses === "codex.prompt")?.id;
        const output = outputKey ? object(state.values.get(outputKey), "MODULE_WORKFLOW_OUTPUT_MISSING") : null;
        if (!output) throw new PkbError("MODULE_WORKFLOW_OUTPUT_MISSING", `${resolved.workflowId} has no structured output for build-operation-plan.`);
        const outputSchema = schemaId(resolved.moduleRoot, resolved.manifest, string(step.with.output_schema, "build-operation-plan.output_schema"));
        try { validateSchema(vaultRoot, outputSchema, output); }
        catch (error) {
          if (!hasMissingReviewRule(resolved.workflow, output)) throw error;
        }
        const target = relative(interpolate(string(step.with.target, "build-operation-plan.target"), state, task), "build-operation-plan.target");
        const operationMode = String(step.with.operation_type ?? "create-record") as RecordOperationMode;
        const operationType = operationPlanTypeForRecordMode(operationMode);
        if (!resolved.instance) throw new PkbError("MODULE_WORKFLOW_INSTANCE_REQUIRED", "Creating a module document requires an instance.");
        const contentRoot = String(resolved.instance.content_root ?? "");
        if (!target.startsWith(`${contentRoot}/`)) throw new PkbError("MODULE_WRITE_DENIED", `Workflow cannot write ${target}.`);
        const idempotencyKey = interpolate(string(step.with.idempotency_key, "build-operation-plan.idempotency_key"), state, task);
        const targetExists = await exists(fromVaultPath(vaultRoot, target));
        if (operationMode === "create-record" && targetExists) {
          // A process can exit after the transactional write succeeds but before
          // its Task is marked complete. Reuse the durable operation ledger in
          // that narrow recovery window; unrelated user files are never replaced.
          const ledger = await readJson<{ completed?: Record<string, { plan_id?: string }> }>(path.join(vaultRoot, "90-System", "State", "idempotency.json"), {});
          const completed = ledger.completed?.[idempotencyKey];
          if (!completed?.plan_id) throw new PkbError("MODULE_WORKFLOW_OUTPUT_EXISTS", `Workflow will not overwrite existing output ${target}.`);
          state.planId = completed.plan_id;
          state.outputFiles.add(target);
          state.values.set(step.id, { plan_id: completed.plan_id, recovered: true });
          continue;
        }
        if (operationMode !== "create-record" && !targetExists) {
          throw new PkbError("MODULE_WORKFLOW_TARGET_MISSING", `${operationMode} requires an existing target ${target}.`);
        }
        const templatePath = path.join(resolved.moduleRoot, ...relative(string(step.with.template, "build-operation-plan.template"), "build-operation-plan.template").split("/"));
        const planId = await allocateId(vaultRoot, "PLAN");
        const reviewRequirements = pendingReviewRequirements(state);
        const reviewId = reviewRequirements.length ? await allocateId(vaultRoot, "REV") : null;
        const generated = output.generation && typeof output.generation === "object" && !Array.isArray(output.generation) ? output.generation as JsonObject : null;
        const plan: OperationPlan = {
          plan_id: planId, task_id: task.task_id, source_module: task.module, instance_id: task.instance_id,
          summary: typeof step.with.summary === "string" ? interpolate(step.with.summary, state, task) : `Run ${resolved.workflowId}`,
          operations: [{
            operation_id: "OP-001", type: operationType, target, risk: reviewId ? "yellow" : "green", confidence: 1,
            idempotency_key: idempotencyKey, requires_review_id: reviewId,
            payload: operationMode === "create-record"
              ? { document: { data: output, content: documentBody(await fs.readFile(templatePath, "utf8"), output) }, schema_id: outputSchema }
              : operationMode === "update-record"
                ? { patch: output, replace_top_level: Object.keys(output), schema_id: outputSchema, actor: "ai" }
                : { section: typeof step.with.section === "string" ? step.with.section : "AI Updates", content: documentBody(await fs.readFile(templatePath, "utf8"), output), marker: idempotencyKey, actor: "ai" },
          }], review_items: [],
        };
        if (reviewId) {
          const primary = reviewRequirements[0]!;
          const now = new Date().toISOString();
          const review: ReviewItem = {
            review_id: reviewId, schema_version: 1, source_module: task.module, instance_id: task.instance_id, target,
            action: "module-operation", proposed_value: {
              field: String(primary.field ?? "record"), old_value: primary.current_value ?? null, new_value: output,
              operation_plan_id: planId, matching_rules: reviewRequirements,
            }, confidence: typeof output.confidence === "number" ? output.confidence : 1,
            priority: reviewRequirements.some((item) => item.condition === "conflicting") ? "high" : "medium",
            status: "pending", reason: reviewRequirements.map((item) => String(item.reason ?? item.field ?? "Review rule matched.")).join(" "),
            evidence: [...state.sourceFiles], created: now, review_after: null, decision: null, decision_history: [], target_observation: null,
            resolution: null, origin_task_id: task.task_id,
            ...(typeof task.payload.item_id === "string" ? { item_id: task.payload.item_id } : {}),
            ...(typeof task.payload.source_file === "string" ? { source_file: task.payload.source_file } : {}),
            ...(generated ? { generation: generated } : {}),
          };
          plan.review_items = [review];
        }
        await writeJsonAtomic(path.join(vaultRoot, "90-System", "State", "Plans", `${planId}.json`), plan);
        if (reviewId) {
          await writeReviewItems(vaultRoot, plan.review_items);
          throw new PkbError("MODULE_WORKFLOW_REVIEW_REQUIRED", `Workflow ${resolved.workflowId} requires a user Review before writing ${target}.`, {
            review_id: reviewId, plan_id: planId, matches: reviewRequirements,
            ...(typeof task.payload.item_id === "string" ? { item_id: task.payload.item_id } : {}),
            ...(typeof task.payload.source_file === "string" ? { source_file: task.payload.source_file } : {}),
          });
        }
        const snapshot = await createGitSnapshot(vaultRoot, runId);
        await executeOperationPlan(vaultRoot, plan, { allowedTypes: [operationType], allowedTargets: [target], requiredReviewId: null, gitSnapshot: snapshot });
        state.planId = planId; state.snapshot = snapshot; state.outputFiles.add(target); state.values.set(step.id, plan);
      }
    }
    if (task.trigger.type === "inbox" && typeof task.payload.item_id === "string" && typeof task.payload.source_file === "string") {
      const destination = [...state.values.values()].flatMap((value) => value && typeof value === "object" && !Array.isArray(value) && typeof (value as JsonObject).destination === "string" ? [String((value as JsonObject).destination)] : []).at(-1) ?? null;
      await writeInboxState(vaultRoot, {
        schema_version: 1, item_id: task.payload.item_id, path: task.payload.source_file, state: "processed",
        attempts: task.attempt_count + 1, review_after: null, error: null, run_id: runId, plan_id: state.planId,
        task_id: task.task_id, result: { status: "processed", destination, workflow: resolved.workflowId }, updated_at: new Date().toISOString(),
      });
      await rebuildTodayDashboard(vaultRoot);
    }
    return {
      completion_reason: `module-workflow:${resolved.workflowId}`,
      operation_plan_id: state.planId, git_snapshot_id: state.snapshot,
      input_files: [...state.sourceFiles], output_files: [...state.outputFiles],
      metrics: {
        module_workflow: resolved.workflowId, module_workflow_version: resolved.workflowVersion, steps_executed: steps.length,
        codex_calls: state.codexCalls, files_read: state.sourceFiles.size, files_written: state.outputFiles.size,
        events_published: state.eventIds.length, event_ids: state.eventIds,
        pdf_inputs: [...state.pdfDecisions.values()],
        codex_contexts: state.codexContexts.map((context) => ({
          version: context.version, primary_input: context.primary_input.source_path,
          related_input_count: context.related_inputs.length, allowed_read_roots: context.allowed_read_roots,
          max_sensitivity_class: context.max_sensitivity_class,
          budget: context.budget as unknown as JsonObject,
        })),
      },
    };
  };
}

export const runModuleWorkflow = createModuleWorkflowRunner();
