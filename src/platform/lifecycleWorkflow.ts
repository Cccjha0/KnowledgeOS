import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CreateInstanceParams, ManageInstanceParams, ManageModuleParams } from "../api/types.js";
import { parseMarkdown, validateSchema } from "../core/bridge.js";
import { discoverInstances, discoverModules, discoverModulesForVault, type DiscoveredDocument } from "../core/discovery.js";
import { PkbError } from "../core/errors.js";
import { reconcileLifecycleTasks } from "../runtime/jobRegistry.js";
import { exists, listFilesRecursive, readJson, toVaultPath, writeJsonAtomic } from "../core/files.js";
import { createGitSnapshot } from "../core/git.js";
import { allocateId } from "../core/ids.js";
import { writeRunLog } from "../core/logs.js";
import { executeOperationPlan } from "../core/operationExecutor.js";
import type { JsonObject, JsonValue, Operation, OperationPlan, RunLog } from "../core/types.js";
import { rebuildTodayDashboard } from "./dashboard.js";
import { validateModule } from "../modules/validator.js";
import { installModulePackage, rollbackModulePackage } from "../modules/packageManager.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE_INSTANCE_SCHEMA = "https://pkb.local/schemas/core/instance.schema.json";

interface InstalledModule extends JsonObject {
  id: string;
  version: string;
  installed_path: string;
  status: "enabled" | "disabled";
}

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function stringValue(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new PkbError("INVALID_REQUEST", `${label} is required.`);
  return value.trim();
}

function validateVaultPath(value: string, label: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.split("/").includes("..") || /^[A-Za-z]:/.test(normalized)) {
    throw new PkbError("INVALID_REQUEST", `${label} must be a Vault-relative path.`);
  }
  return normalized;
}

function setNested(target: JsonObject, dotted: string, value: JsonValue): void {
  const parts = dotted.split(".");
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (!object(current[part])) current[part] = {};
    current = current[part] as JsonObject;
  }
  current[parts.at(-1)!] = value;
}

function form(module: DiscoveredDocument): JsonObject {
  const descriptor = object(module.data.instance_form);
  if (!descriptor || !Array.isArray(descriptor.fields)) throw new PkbError("INSTANCE_FORM_UNAVAILABLE", `Module ${String(module.data.id)} does not declare an instance form.`);
  return descriptor;
}

async function moduleInstanceSchema(module: DiscoveredDocument): Promise<string> {
  const schemas = object(module.data.schemas);
  const relative = typeof schemas?.instance === "string" ? schemas.instance : null;
  if (!relative) return BASE_INSTANCE_SCHEMA;
  const schema = JSON.parse(await fs.readFile(path.join(path.dirname(module.path), ...relative.split("/")), "utf8")) as { $id?: string };
  if (!schema.$id) throw new PkbError("MODULE_SCHEMA_INVALID", `Instance schema for ${String(module.data.id)} has no $id.`);
  return schema.$id;
}

async function writeLifecycleLog(vaultRoot: string, runId: string, taskId: string, planId: string, moduleId: string, instanceId: string | null, snapshot: string, summary: string): Promise<void> {
  const now = new Date().toISOString();
  const log: RunLog = {
    run_id: runId, task_id: taskId, plan_id: planId, source_module: moduleId, instance_id: instanceId,
    review_id: null, status: "completed", git_snapshot: snapshot, started_at: now, completed_at: new Date().toISOString(), schema_version: 1,
  };
  await writeRunLog(vaultRoot, log, `# ${runId}\n\n${summary}\n`);
}

async function executePlan(vaultRoot: string, plan: OperationPlan, allowedTypes: string[], allowedTargets: string[]): Promise<JsonObject> {
  const runId = await allocateId(vaultRoot, "RUN");
  const planPath = path.join(vaultRoot, "90-System", "State", "Plans", `${plan.plan_id}.json`);
  await writeJsonAtomic(planPath, plan);
  const snapshot = await createGitSnapshot(vaultRoot, runId);
  await executeOperationPlan(vaultRoot, plan, { allowedTypes, allowedTargets, requiredReviewId: null, gitSnapshot: snapshot });
  await writeLifecycleLog(vaultRoot, runId, plan.task_id, plan.plan_id, plan.source_module, plan.instance_id, snapshot, plan.summary);
  await rebuildTodayDashboard(vaultRoot);
  return { run_id: runId, plan_id: plan.plan_id, snapshot, plan_path: toVaultPath(vaultRoot, planPath) };
}

async function normalizedInstalled(vaultRoot: string): Promise<{ schema_version: 1; modules: InstalledModule[] }> {
  const file = path.join(vaultRoot, "90-System", "Modules", "installed.json");
  const stored = await readJson<{ modules?: JsonObject[] }>(file, { modules: [] });
  const byId = new Map((stored.modules ?? []).filter((entry) => typeof entry.id === "string").map((entry) => [String(entry.id), entry]));
  const modules: InstalledModule[] = [];
  for (const module of await discoverModules(ENGINE_ROOT)) {
    const id = String(module.data.id);
    const previous = byId.get(id);
    modules.push({
      ...(previous ?? {}), id, version: String(module.data.version),
      installed_path: typeof previous?.installed_path === "string" ? previous.installed_path : `90-System/Modules/${id}/${String(module.data.version)}`,
      status: previous?.status === "disabled" ? "disabled" : module.data.status === "disabled" ? "disabled" : "enabled",
    });
  }
  return { schema_version: 1, modules };
}

async function moduleImpact(vaultRoot: string, moduleId: string): Promise<JsonObject> {
  const instances = (await discoverInstances(vaultRoot)).filter((entry) => entry.data.module_id === moduleId);
  const pendingReviews = await openReviewFiles(vaultRoot);
  let reviewCount = 0;
  for (const file of pendingReviews) if (parseYamlOrMarkdownModule(vaultRoot, file) === moduleId) reviewCount += 1;
  let inboxCount = 0;
  const inboxRoots = new Set<string>();
  const module = (await discoverModulesForVault(ENGINE_ROOT, vaultRoot)).find((entry) => entry.data.id === moduleId);
  const moduleLevel = object(object(module?.data.inbox)?.module_level);
  if (moduleLevel?.enabled === true && typeof moduleLevel.path === "string") inboxRoots.add(moduleLevel.path);
  for (const instance of instances) if (typeof instance.data.inbox_path === "string") inboxRoots.add(instance.data.inbox_path);
  for (const inboxRoot of inboxRoots) inboxCount += (await listFilesRecursive(path.join(vaultRoot, ...inboxRoot.split("/")))).length;
  return {
    instance_count: instances.length,
    active_instance_count: instances.filter((entry) => entry.data.status === "active").length,
    inbox_count: inboxCount,
    pending_review_count: reviewCount,
    data_deleted: false,
  };
}

async function openReviewFiles(vaultRoot: string): Promise<string[]> {
  const files: string[] = [];
  for (const directory of ["Pending", "Deferred", "Error"]) {
    files.push(...await listFilesRecursive(path.join(vaultRoot, "90-System", "Review Queue", directory), ".md"));
  }
  return files;
}

function parseYamlOrMarkdownModule(vaultRoot: string, file: string): string | null {
  try {
    const value = parseMarkdown(vaultRoot, file).data.source_module;
    return typeof value === "string" ? value : null;
  }
  catch { return null; }
}

export async function manageModule(vaultRoot: string, params: ManageModuleParams): Promise<JsonObject> {
  const moduleId = stringValue(params.module_id, "module_id");
  const modules = await discoverModulesForVault(ENGINE_ROOT, vaultRoot);
  const module = modules.find((entry) => entry.data.id === moduleId);
  if (!module) throw new PkbError("MODULE_NOT_FOUND", `Module ${moduleId} was not found.`);
  const impact = await moduleImpact(vaultRoot, moduleId);
  if (params.action === "validate") {
    const schemaId = await moduleInstanceSchema(module);
    const report = await validateModule(ENGINE_ROOT, path.dirname(module.path), { writeReport: true });
    return { status: report.overall === "FAIL" ? "invalid" : "valid", module_id: moduleId, instance_schema: schemaId, report, impact };
  }
  if (params.action === "upgrade") {
    if (!params.package_path) throw new PkbError("INVALID_REQUEST", "package_path is required for a Module upgrade.");
    return { ...await installModulePackage(ENGINE_ROOT, vaultRoot, path.resolve(params.package_path), { enable: true, upgrade: true, confirmBreaking: params.confirm === true }), impact };
  }
  if (params.action === "rollback") {
    if (params.confirm !== true) throw new PkbError("MODULE_CONFIRMATION_REQUIRED", "Module rollback requires explicit confirmation.", { module_id: moduleId, impact });
    return { ...await rollbackModulePackage(ENGINE_ROOT, vaultRoot, moduleId), impact };
  }
  if (!['enable', 'disable'].includes(params.action)) throw new PkbError("INVALID_REQUEST", "Invalid module lifecycle action.");
  const targetStatus = params.action === "enable" ? "enabled" : "disabled";
  const currentStatus = module.data.status === "disabled" ? "disabled" : "enabled";
  const preview = {
    status: "preview", module_id: moduleId, current_status: currentStatus, target_status: targetStatus,
    requires_confirmation: targetStatus === "disabled" && currentStatus !== "disabled", impact,
    effects: targetStatus === "disabled"
      ? ["Module Inbox processing stops.", "Active instance reminders disappear from Today.", "User data and Review records are retained."]
      : ["Module Inbox processing and active-instance Today items resume.", "User data is unchanged."],
  };
  if (params.preview_only) return preview;
  if (currentStatus === targetStatus) return { ...preview, status: "unchanged" };
  if (targetStatus === "disabled" && params.confirm !== true) throw new PkbError("MODULE_CONFIRMATION_REQUIRED", "Disabling a module requires explicit confirmation.", preview);
  const installed = await normalizedInstalled(vaultRoot);
  const entry = installed.modules.find((item) => item.id === moduleId)!;
  entry.status = targetStatus;
  entry.updated_at = new Date().toISOString();
  const taskId = await allocateId(vaultRoot, "TASK");
  const planId = await allocateId(vaultRoot, "PLAN");
  const target = "90-System/Modules/installed.json";
  const plan: OperationPlan = {
    plan_id: planId, task_id: taskId, source_module: moduleId, instance_id: null,
    summary: `${params.action === "enable" ? "Enable" : "Disable"} module ${moduleId}`,
    operations: [{ operation_id: "OP-001", type: "update-file", target, risk: targetStatus === "disabled" ? "yellow" : "green", confidence: 1, idempotency_key: `module-lifecycle:${moduleId}:${targetStatus}:${Date.now()}`, payload: { format: "json", data: installed }, requires_review_id: null }],
    review_items: [],
  };
  const execution = await executePlan(vaultRoot, plan, ["update-file"], [target]);
  const task_effects = await reconcileLifecycleTasks(vaultRoot, { moduleId, active: targetStatus === "enabled" });
  return { ...preview, status: targetStatus, ...execution, task_effects };
}

function buildFields(descriptor: JsonObject, provided: JsonObject): JsonObject {
  const output: JsonObject = {};
  const allowed = new Set<string>();
  const reserved = new Set(["instance_id", "module_id", "status", "display_name", "content_root", "inbox_path", "created", "updated"]);
  for (const raw of descriptor.fields as JsonValue[]) {
    const field = object(raw)!;
    const key = String(field.key);
    if (reserved.has(key.split(".")[0]!)) throw new PkbError("INSTANCE_FORM_INVALID", `Module instance form cannot own reserved field ${key}.`);
    allowed.add(key);
    let value = provided[key];
    if (value === undefined) value = field.default;
    if ((value === undefined || value === null || value === "") && field.required === true) throw new PkbError("INSTANCE_FIELD_REQUIRED", `${String(field.label)} is required.`, { key });
    if (value !== undefined) setNested(output, key, value);
  }
  const unknown = Object.keys(provided).filter((key) => !allowed.has(key));
  if (unknown.length) throw new PkbError("INSTANCE_FIELD_UNKNOWN", `Unknown instance fields: ${unknown.join(", ")}.`);
  return output;
}

export async function createInstance(vaultRoot: string, params: CreateInstanceParams): Promise<JsonObject> {
  const moduleId = stringValue(params.module_id, "module_id");
  const instanceId = stringValue(params.instance_id, "instance_id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(instanceId)) throw new PkbError("INVALID_INSTANCE_ID", "instance_id must be 3-128 safe characters.");
  const displayName = stringValue(params.display_name, "display_name");
  const module = (await discoverModulesForVault(ENGINE_ROOT, vaultRoot)).find((entry) => entry.data.id === moduleId);
  if (!module) throw new PkbError("MODULE_NOT_FOUND", `Module ${moduleId} was not found.`);
  if (module.data.status !== "enabled") throw new PkbError("MODULE_DISABLED", `Module ${moduleId} is disabled.`);
  if ((await discoverInstances(vaultRoot)).some((entry) => entry.data.instance_id === instanceId)) throw new PkbError("INSTANCE_EXISTS", `Instance ${instanceId} already exists.`);
  const descriptor = form(module);
  const defaultRoot = String(descriptor.content_root_pattern).replaceAll("{instance_id}", instanceId);
  const contentRoot = validateVaultPath(params.content_root?.trim() || defaultRoot, "content_root");
  const defaultInbox = String(descriptor.inbox_path_pattern).replaceAll("{instance_id}", instanceId).replaceAll("{content_root}", contentRoot);
  const inboxPath = validateVaultPath(params.inbox_path?.trim() || defaultInbox, "inbox_path");
  if (!(inboxPath === contentRoot || inboxPath.startsWith(`${contentRoot}/`))) throw new PkbError("INVALID_INSTANCE_PATH", "inbox_path must be inside content_root.");
  const now = new Date().toISOString();
  const data: JsonObject = {
    instance_id: instanceId, module_id: moduleId, status: "active", display_name: displayName,
    content_root: contentRoot, inbox_path: inboxPath, created: now, updated: now,
    ...buildFields(descriptor, params.fields ?? {}),
  };
  const schemaId = await moduleInstanceSchema(module);
  validateSchema(vaultRoot, schemaId, data);
  const preview = {
    status: "preview", module_id: moduleId, instance_id: instanceId, display_name: displayName,
    content_root: contentRoot, inbox_path: inboxPath, initial_status: "active", fields: data,
    effects: ["Create instance configuration.", "Create content and Inbox directories.", "Enable Today and Inbox discovery immediately."],
  };
  if (params.preview_only) return preview;
  const taskId = await allocateId(vaultRoot, "TASK");
  const planId = await allocateId(vaultRoot, "PLAN");
  const operations: Operation[] = [];
  const markerTargets = [`${contentRoot}/.gitkeep`, `${inboxPath}/.gitkeep`];
  for (const target of [...new Set(markerTargets)]) if (!(await exists(path.join(vaultRoot, ...target.split("/"))))) operations.push({
    operation_id: `OP-${String(operations.length + 1).padStart(3, "0")}`, type: "create-file", target, risk: "green", confidence: 1,
    idempotency_key: `instance-create:${instanceId}:${target}`, payload: { format: "text", text: "" }, requires_review_id: null,
  });
  const instanceTarget = `90-System/Instances/${instanceId}/instance.yaml`;
  operations.push({
    operation_id: `OP-${String(operations.length + 1).padStart(3, "0")}`, type: "create-file", target: instanceTarget, risk: "green", confidence: 1,
    idempotency_key: `instance-create:${instanceId}:configuration`, payload: { format: "yaml", data, schema_id: schemaId }, requires_review_id: null,
  });
  const plan: OperationPlan = { plan_id: planId, task_id: taskId, source_module: moduleId, instance_id: instanceId, summary: `Create instance ${displayName}`, operations, review_items: [] };
  return { ...preview, status: "created", ...await executePlan(vaultRoot, plan, ["create-file"], operations.map((operation) => operation.target!)) };
}

const TRANSITIONS: Record<ManageInstanceParams["action"], { from: string[]; to: string }> = {
  activate: { from: ["planned"], to: "active" },
  pause: { from: ["active"], to: "paused" },
  resume: { from: ["paused"], to: "active" },
  complete: { from: ["active", "paused"], to: "completed" },
  archive: { from: ["planned", "active", "paused", "completed", "error"], to: "archived" },
};

async function instanceImpact(vaultRoot: string, instance: DiscoveredDocument): Promise<JsonObject> {
  const inboxPath = typeof instance.data.inbox_path === "string" ? instance.data.inbox_path : `${String(instance.data.content_root)}/Inbox`;
  const inboxCount = (await listFilesRecursive(path.join(vaultRoot, ...inboxPath.split("/")))).length;
  let reviewCount = 0;
  for (const file of await openReviewFiles(vaultRoot)) {
    try { if (parseYamlOrMarkdownInstance(vaultRoot, file) === instance.data.instance_id) reviewCount += 1; } catch { /* Ignore unreadable Review in impact preview. */ }
  }
  return { inbox_count: inboxCount, pending_review_count: reviewCount, scheduled_jobs_stop: true, today_reminders_stop: true, data_deleted: false, content_root: String(instance.data.content_root) };
}

function parseYamlOrMarkdownInstance(vaultRoot: string, file: string): string | null {
  const value = parseMarkdown(vaultRoot, file).data.instance_id;
  return typeof value === "string" ? value : null;
}

export async function manageInstance(vaultRoot: string, params: ManageInstanceParams): Promise<JsonObject> {
  const instanceId = stringValue(params.instance_id, "instance_id");
  const instance = (await discoverInstances(vaultRoot)).find((entry) => entry.data.instance_id === instanceId);
  if (!instance) throw new PkbError("INSTANCE_NOT_FOUND", `Instance ${instanceId} was not found.`);
  const transition = TRANSITIONS[params.action];
  if (!transition) throw new PkbError("INVALID_REQUEST", "Invalid instance lifecycle action.");
  const current = String(instance.data.status);
  const moduleId = String(instance.data.module_id);
  if (current === transition.to) return { status: "unchanged", instance_id: instanceId, current_status: current, target_status: transition.to };
  if (!transition.from.includes(current)) throw new PkbError("INSTANCE_TRANSITION_INVALID", `Cannot ${params.action} an instance in ${current} state.`, { allowed_from: transition.from });
  const impact = await instanceImpact(vaultRoot, instance);
  const requiresConfirmation = params.action === "archive" && (Number(impact.inbox_count) > 0 || Number(impact.pending_review_count) > 0);
  const preview = {
    status: "preview", instance_id: instanceId, module_id: moduleId, current_status: current, target_status: transition.to,
    requires_confirmation: requiresConfirmation, impact,
    effects: params.action === "archive"
      ? ["Scheduled work and Today reminders stop.", "Content, Inbox files and Review Items are retained.", "No user data is deleted."]
      : transition.to === "active" ? ["Inbox discovery and Today reminders resume."] : ["Automatic processing and Today reminders stop.", "User data is retained."],
  };
  if (params.preview_only) return preview;
  if (requiresConfirmation && params.confirm !== true) throw new PkbError("INSTANCE_CONFIRMATION_REQUIRED", "Archiving with open Inbox or Review items requires confirmation.", preview);
  const rawModule = (await discoverModules(ENGINE_ROOT)).find((entry) => entry.data.id === instance.data.module_id);
  if (!rawModule) throw new PkbError("MODULE_NOT_FOUND", `Module ${String(instance.data.module_id)} was not found.`);
  const schemaId = await moduleInstanceSchema(rawModule);
  const taskId = await allocateId(vaultRoot, "TASK");
  const planId = await allocateId(vaultRoot, "PLAN");
  const target = toVaultPath(vaultRoot, instance.path);
  const plan: OperationPlan = {
    plan_id: planId, task_id: taskId, source_module: String(instance.data.module_id), instance_id: instanceId,
    summary: `${params.action} instance ${instanceId}`,
    operations: [{
      operation_id: "OP-001", type: "update-instance", target, risk: params.action === "archive" ? "yellow" : "green", confidence: 1,
      idempotency_key: `instance-lifecycle:${instanceId}:${transition.to}:${Date.now()}`,
      payload: { patch: { status: transition.to, updated: new Date().toISOString() }, schema_id: schemaId }, requires_review_id: null,
    }], review_items: [],
  };
  const execution = await executePlan(vaultRoot, plan, ["update-instance"], [target]);
  const task_effects = await reconcileLifecycleTasks(vaultRoot, {
    moduleId, instanceId, active: transition.to === "active", createFinalSummary: params.action === "complete",
  });
  return { ...preview, status: transition.to, ...execution, task_effects };
}
