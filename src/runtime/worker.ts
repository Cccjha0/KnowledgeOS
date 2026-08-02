import { performance } from "node:perf_hooks";
import { PkbError } from "../core/errors.js";
import type { JsonObject } from "../core/types.js";
import { rebuildTodayDashboardWithResult } from "../platform/dashboard.js";
import { discoverInboxItems } from "../platform/inboxDiscovery.js";
import { doctorVault, initializeVault } from "../core/vault.js";
import type { RuntimeError, RuntimeTask } from "./domain.js";
import { RuntimeRepository } from "./repository.js";
import { runExternalLinkAudit, runQualityAudit } from "../quality/audit.js";

export interface WorkerResult {
  completion_reason: string;
  operation_plan_id?: string | null;
  git_snapshot_id?: string | null;
  input_files?: string[];
  output_files?: string[];
  metrics?: JsonObject;
}

export type RuntimeHandler = (context: { vaultRoot: string; task: RuntimeTask; checkpoint: () => void }) => Promise<WorkerResult>;

const coreHandlers: Record<string, RuntimeHandler> = {
  "core:build-today": async ({ vaultRoot }) => {
    const result = await rebuildTodayDashboardWithResult(vaultRoot);
    return {
      completion_reason: result.written ? "today-rebuilt" : "today-unchanged",
      output_files: result.written ? [result.path] : [],
      metrics: { files_written: result.written ? 1 : 0, unchanged: result.written ? 0 : 1 },
    };
  },
  "core:scan-inbox": async ({ vaultRoot }) => {
    const items = await discoverInboxItems(vaultRoot);
    return { completion_reason: "inbox-scanned", input_files: items.map((item) => item.path), metrics: { files_read: items.length, inbox_items: items.length } };
  },
  "core:vault-audit": async ({ vaultRoot }) => {
    const repaired = await initializeVault(vaultRoot, "disabled");
    const report = await doctorVault(vaultRoot);
    const failed = report.checks.filter((check) => !check.ok);
    if (failed.length) throw new PkbError("VAULT_AUDIT_FAILED", failed.map((check) => `${check.name}: ${check.message}`).join("; "));
    return {
      completion_reason: repaired.createdDirectories.length || repaired.createdFiles.length ? "vault-audit-repaired" : "vault-audit-clean",
      output_files: repaired.createdFiles,
      metrics: { checks: report.checks.length, directories_repaired: repaired.createdDirectories.length, files_created: repaired.createdFiles.length },
    };
  },
  "core:cleanup-runtime": async ({ vaultRoot }) => {
    const repository = await RuntimeRepository.open(vaultRoot);
    try { return { completion_reason: "runtime-history-cleaned", metrics: repository.cleanupHistory(90) }; }
    finally { repository.close(); }
  },
  "core:quality-audit-daily": async ({ vaultRoot }) => ({ completion_reason: "daily-quality-audit", metrics: await runQualityAudit(vaultRoot, "daily") }),
  "core:quality-audit-weekly": async ({ vaultRoot }) => ({ completion_reason: "weekly-quality-audit", metrics: await runQualityAudit(vaultRoot, "weekly") }),
  "core:quality-audit-monthly": async ({ vaultRoot }) => ({ completion_reason: "monthly-quality-audit", metrics: await runQualityAudit(vaultRoot, "monthly") }),
  "core:external-link-audit": async ({ vaultRoot }) => ({ completion_reason: "external-link-audit", metrics: await runExternalLinkAudit(vaultRoot) }),
};

function runtimeError(error: unknown): RuntimeError {
  const code = error instanceof PkbError ? error.code : "WORKER_FAILED";
  return {
    code, message: error instanceof Error ? error.message : String(error), retryable: ["EBUSY", "EACCES", "ETIMEDOUT", "RATE_LIMITED", "NETWORK_UNAVAILABLE", "CODEX_UNAVAILABLE", "CODEX_CONNECTION_FAILED", "CODEX_RATE_LIMITED", "CODEX_OUTPUT_INVALID", "RUNTIME_DB_LOCKED"].includes(code),
    occurred_at: new Date().toISOString(), details: {},
  };
}

export async function executeTask(vaultRoot: string, repository: RuntimeRepository, task: RuntimeTask, workerId: string, resourcesChecked: JsonObject, handlers: Record<string, RuntimeHandler> = {}): Promise<RuntimeTask> {
  const handler = handlers[task.workflow] ?? coreHandlers[task.workflow];
  const run = repository.startRun(task.task_id, workerId, resourcesChecked);
  repository.recordMetricEvent({ idempotency_key: `${run.run_id}:started`, event_type: "task.started", module: task.module, instance_id: task.instance_id, workflow_id: String(task.trigger.workflow_id ?? task.workflow), workflow_version: typeof task.trigger.workflow_version === "string" ? task.trigger.workflow_version : null, prompt_id: null, prompt_version: null, run_id: run.run_id, occurred_at: run.started_at, dimensions: { priority: task.priority, trigger_type: task.trigger.type ?? "unknown" }, values: {} });
  const started = performance.now();
  const checkpoint = () => {
    const current = repository.getTask(task.task_id);
    if (current?.cancel_requested) throw new PkbError("TASK_CANCELLED", "Task cancellation was requested.");
    repository.heartbeatRun(run.run_id);
  };
  const heartbeat = setInterval(() => { try { repository.heartbeatRun(run.run_id); } catch { /* completion or next startup reconciliation owns recovery */ } }, 15_000);
  if (!handler) {
    clearInterval(heartbeat);
    return repository.finishRun(run.run_id, {
      runStatus: "failed", taskStatus: "failed", error: runtimeError(new PkbError("WORKFLOW_NOT_FOUND", `No runtime handler is registered for ${task.workflow}.`)),
      metrics: { duration_ms: performance.now() - started }, completionReason: "workflow-not-found",
    }).task;
  }
  try {
    checkpoint();
    const result = await handler({ vaultRoot, task, checkpoint });
    checkpoint();
    clearInterval(heartbeat);
    const finished = repository.finishRun(run.run_id, {
      runStatus: "completed", taskStatus: "completed", operationPlanId: result.operation_plan_id,
      gitSnapshotId: result.git_snapshot_id, inputFiles: result.input_files, outputFiles: result.output_files,
      metrics: { ...(result.metrics ?? {}), duration_ms: performance.now() - started, workflow_id: task.trigger.workflow_id ?? task.workflow, workflow_version: task.trigger.workflow_version ?? null }, completionReason: result.completion_reason,
    }).task;
    repository.recordMetricEvent({ idempotency_key: `${run.run_id}:completed`, event_type: "task.completed", module: task.module, instance_id: task.instance_id, workflow_id: String(task.trigger.workflow_id ?? task.workflow), workflow_version: typeof task.trigger.workflow_version === "string" ? task.trigger.workflow_version : null, prompt_id: null, prompt_version: null, run_id: run.run_id, occurred_at: new Date().toISOString(), dimensions: { priority: task.priority }, values: { duration_ms: performance.now() - started } });
    return finished;
  } catch (error) {
    clearInterval(heartbeat);
    const classified = runtimeError(error);
    if (classified.code === "TASK_CANCELLED") {
      return repository.finishRun(run.run_id, { runStatus: "cancelled", taskStatus: "cancelled", error: classified, metrics: { duration_ms: performance.now() - started }, completionReason: "cooperative-cancelled" }).task;
    }
    const attempt = run.attempt_number;
    const delays = [5, 15, 45];
    const retry = classified.retryable && attempt < task.max_attempts;
    const nextRetryAt = retry ? new Date(Date.now() + (delays[Math.min(attempt - 1, delays.length - 1)] ?? 45) * 60_000).toISOString() : null;
    const finished = repository.finishRun(run.run_id, {
      runStatus: "failed", taskStatus: retry ? "queued" : "failed", error: classified, nextRetryAt,
      metrics: { duration_ms: performance.now() - started }, completionReason: retry ? "retry-scheduled" : "worker-failed",
    }).task;
    repository.recordMetricEvent({ idempotency_key: `${run.run_id}:failed`, event_type: "task.failed", module: task.module, instance_id: task.instance_id, workflow_id: String(task.trigger.workflow_id ?? task.workflow), workflow_version: typeof task.trigger.workflow_version === "string" ? task.trigger.workflow_version : null, prompt_id: null, prompt_version: null, run_id: run.run_id, occurred_at: new Date().toISOString(), dimensions: { error_code: classified.code, retryable: classified.retryable }, values: { duration_ms: performance.now() - started } });
    return finished;
  }
}
