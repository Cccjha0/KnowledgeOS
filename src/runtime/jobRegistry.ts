import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseYaml } from "../core/bridge.js";
import { discoverInstances, discoverModulesForVault } from "../core/discovery.js";
import { exists } from "../core/files.js";
import { PkbError } from "../core/errors.js";
import type { JsonObject } from "../core/types.js";
import type { JobDefinition, TaskPriority, TaskResources } from "./domain.js";
import { RuntimeRepository } from "./repository.js";
import { resolveWorkflowResourceRequirements } from "../modules/workflowResources.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const local: TaskResources = { filesystem: "required", network: "not-required", codex: "not-required", user: "not-required" };
const networked: TaskResources = { filesystem: "required", network: "required", codex: "not-required", user: "not-required" };

function coreJobs(now: string): JobDefinition[] {
  const base = { source: "core" as const, module: "core", scope: "core" as const, enabled: true, task_type: "core-operation" as const, resources: local, retry: { max_attempts: 3, strategy: "exponential" }, idempotency: {}, priority: "low" as TaskPriority, updated_at: now };
  return [
    { ...base, job_id: "core.startup-today", workflow: "core:build-today", trigger: { type: "startup", dedupe: "daily", timezone: "Asia/Shanghai" }, catch_up: { policy: "none" }, concurrency: { policy: "replace", key: "core:today" }, priority: "high" },
    { ...base, job_id: "core.daily-today", workflow: "core:build-today", trigger: { type: "daily", at: "08:00", timezone: "Asia/Shanghai" }, catch_up: { policy: "latest" }, concurrency: { policy: "replace", key: "core:today" } },
    { ...base, job_id: "core.weekly-vault-audit", workflow: "core:vault-audit", trigger: { type: "weekly", weekday: "Sun", at: "09:00", timezone: "Asia/Shanghai" }, catch_up: { policy: "latest", max_age_days: 14 }, concurrency: { policy: "forbid", key: "core:vault-audit" } },
    { ...base, job_id: "core.daily-quality-audit", workflow: "core:quality-audit-daily", trigger: { type: "daily", at: "07:30", timezone: "Asia/Shanghai" }, catch_up: { policy: "latest" }, concurrency: { policy: "replace", key: "core:quality-audit" }, priority: "normal" },
    { ...base, job_id: "core.weekly-quality-audit", workflow: "core:quality-audit-weekly", trigger: { type: "weekly", weekday: "Sun", at: "10:00", timezone: "Asia/Shanghai" }, catch_up: { policy: "latest", max_age_days: 14 }, concurrency: { policy: "forbid", key: "core:quality-audit" } },
    { ...base, job_id: "core.weekly-external-link-audit", workflow: "core:external-link-audit", resources: networked, trigger: { type: "weekly", weekday: "Sun", at: "10:30", timezone: "Asia/Shanghai" }, catch_up: { policy: "latest", max_age_days: 14 }, concurrency: { policy: "forbid", key: "core:external-link-audit" } },
    { ...base, job_id: "core.monthly-quality-audit", workflow: "core:quality-audit-monthly", trigger: { type: "monthly", day: 1, at: "04:00", timezone: "Asia/Shanghai" }, catch_up: { policy: "latest", max_age_days: 14 }, concurrency: { policy: "forbid", key: "core:quality-audit" } },
    { ...base, job_id: "core.monthly-runtime-cleanup", workflow: "core:cleanup-runtime", trigger: { type: "monthly", day: 1, at: "03:00", timezone: "Asia/Shanghai" }, catch_up: { policy: "latest", max_age_days: 7 }, concurrency: { policy: "forbid", key: "core:runtime-cleanup" } },
  ];
}

function normalize(moduleId: string, raw: JsonObject, instance: JsonObject | null, module: Awaited<ReturnType<typeof discoverModulesForVault>>[number], moduleEnabled: boolean, now: string): JobDefinition {
  const id = String(raw.id);
  const instanceId = instance ? String(instance.instance_id) : null;
  const trigger = structuredClone(raw.trigger as JsonObject);
  if (instanceId) trigger.instance_id = instanceId;
  if (typeof raw.workflow_id === "string") trigger.workflow_id = raw.workflow_id;
  if (typeof raw.workflow_version === "string") trigger.workflow_version = raw.workflow_version;
  if (trigger.timezone === "instance") trigger.timezone = String(instance?.timezone ?? "Asia/Shanghai");
  if (trigger.type === "event" && trigger.subscription_scope === "global") {
    const permitted = module.data.module_type === "integration"
      || (module.data.permissions && typeof module.data.permissions === "object" && !Array.isArray(module.data.permissions)
        && (module.data.permissions as JsonObject).global_event_subscription === true);
    if (!permitted) throw new PkbError("GLOBAL_EVENT_SUBSCRIPTION_DENIED", `${moduleId} may not declare a global Event subscription without integration module_type or permissions.global_event_subscription: true.`);
    const sources = Array.isArray(trigger.source_modules) ? trigger.source_modules.filter((value): value is string => typeof value === "string" && value.trim().length > 0) : [];
    if (sources.length === 0) throw new PkbError("GLOBAL_EVENT_SOURCE_REQUIRED", `${moduleId} global Event subscriptions must declare trigger.source_modules.`);
  }
  const concurrency = structuredClone((raw.concurrency ?? {}) as JsonObject);
  if (typeof concurrency.key === "string" && instanceId) concurrency.key = concurrency.key.replaceAll("{instance}", instanceId);
  return {
    job_id: instanceId ? `${moduleId}.${id}.${instanceId}` : `${moduleId}.${id}`, source: "module", module: moduleId,
    scope: instanceId ? "instance" : "module", enabled: moduleEnabled && raw.enabled !== false && (!instance || instance.status === "active"),
    task_type: String(raw.task_type ?? "workflow") as JobDefinition["task_type"], workflow: String(raw.workflow), trigger,
    resources: resolveWorkflowResourceRequirements(module, typeof raw.workflow_id === "string" ? raw.workflow_id : String(raw.workflow), null), catch_up: (raw.catch_up ?? { policy: "none" }) as JsonObject,
    retry: (raw.retry ?? { max_attempts: 3 }) as JsonObject, concurrency, idempotency: (raw.idempotency ?? {}) as JsonObject,
    priority: String(raw.priority ?? "normal") as TaskPriority, updated_at: now,
  };
}

export async function registerDeclaredJobs(vaultRoot: string): Promise<JobDefinition[]> {
  const repository = await RuntimeRepository.open(vaultRoot);
  try {
    const now = new Date().toISOString();
    const definitions = coreJobs(now);
    const instances = await discoverInstances(vaultRoot);
    for (const module of await discoverModulesForVault(ENGINE_ROOT, vaultRoot)) {
      const moduleId = String(module.data.id);
      const jobs = module.data.jobs as JsonObject | undefined;
      const file = path.join(path.dirname(module.path), ...String(jobs?.registry ?? "jobs.yaml").split("/"));
      if (!(await exists(file))) continue;
      const document = parseYaml(ENGINE_ROOT, file);
      for (const raw of (document.jobs as JsonObject[] | undefined) ?? []) {
        if (raw.scope === "instance") {
          for (const instance of instances.filter((entry) => entry.data.module_id === moduleId)) definitions.push(normalize(moduleId, raw, instance.data, module, module.data.status === "enabled", now));
        } else definitions.push(normalize(moduleId, raw, null, module, module.data.status === "enabled", now));
      }
    }
    for (const definition of definitions) repository.registerJob(definition);
    return definitions;
  } finally { repository.close(); }
}

export async function reconcileLifecycleTasks(vaultRoot: string, filter: { moduleId?: string; instanceId?: string; active: boolean; createFinalSummary?: boolean }): Promise<{ cancelled: string[]; final_task_id: string | null }> {
  await registerDeclaredJobs(vaultRoot);
  const repository = await RuntimeRepository.open(vaultRoot);
  try {
    const cancelled: string[] = [];
    if (!filter.active) {
      for (const task of repository.listTasks().filter((item) =>
        (!filter.moduleId || item.module === filter.moduleId) && (!filter.instanceId || item.instance_id === filter.instanceId) &&
        !["completed", "cancelled"].includes(item.status))) {
        repository.cancelTask(task.task_id); cancelled.push(task.task_id);
      }
    }
    let finalTaskId: string | null = null;
    if (filter.createFinalSummary && filter.instanceId && filter.moduleId === "experience-log") {
      const module = (await discoverModulesForVault(ENGINE_ROOT, vaultRoot)).find((entry) => entry.data.id === "experience-log" && entry.data.status === "enabled");
      if (!module) throw new Error("experience-log must be enabled before creating its final summary task.");
      const result = repository.createTask({
        job_id: `experience-log.final-summary.${filter.instanceId}`, module: "experience-log", instance_id: filter.instanceId,
        task_type: "workflow", workflow: "experience-log:weekly-summary", priority: "high", resources: resolveWorkflowResourceRequirements(module, "build-weekly-summary"),
        trigger: { type: "event", source: "instance.completed", workflow_id: "build-weekly-summary", workflow_version: "1.0.0" }, catch_up_policy: "none",
        idempotency_key: `experience-log:${filter.instanceId}:final-summary`, concurrency_key: `experience-log:${filter.instanceId}:summary`,
      });
      finalTaskId = result.task.task_id;
    }
    return { cancelled, final_task_id: finalTaskId };
  } finally { repository.close(); }
}
