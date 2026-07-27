import { performance } from "node:perf_hooks";
import { PkbError } from "../core/errors.js";
import type { JsonObject } from "../core/types.js";
import { rebuildTodayDashboard } from "../platform/dashboard.js";
import { discoverInboxItems } from "../platform/inboxDiscovery.js";
import { doctorVault } from "../core/vault.js";
import type { RuntimeError, RuntimeTask } from "./domain.js";
import { RuntimeRepository } from "./repository.js";

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
    const target = await rebuildTodayDashboard(vaultRoot);
    return { completion_reason: "today-rebuilt", output_files: [target], metrics: { files_written: 1 } };
  },
  "core:scan-inbox": async ({ vaultRoot }) => {
    const items = await discoverInboxItems(vaultRoot);
    return { completion_reason: "inbox-scanned", input_files: items.map((item) => item.path), metrics: { files_read: items.length, inbox_items: items.length } };
  },
  "core:vault-audit": async ({ vaultRoot }) => {
    const report = await doctorVault(vaultRoot);
    const failed = report.checks.filter((check) => !check.ok);
    if (failed.length) throw new PkbError("VAULT_AUDIT_FAILED", failed.map((check) => check.message).join("; "));
    return { completion_reason: "vault-audit-clean", metrics: { checks: report.checks.length } };
  },
  "core:cleanup-runtime": async ({ vaultRoot }) => {
    const repository = await RuntimeRepository.open(vaultRoot);
    try { return { completion_reason: "runtime-history-cleaned", metrics: repository.cleanupHistory(90) }; }
    finally { repository.close(); }
  },
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
    return repository.finishRun(run.run_id, {
      runStatus: "completed", taskStatus: "completed", operationPlanId: result.operation_plan_id,
      gitSnapshotId: result.git_snapshot_id, inputFiles: result.input_files, outputFiles: result.output_files,
      metrics: { ...(result.metrics ?? {}), duration_ms: performance.now() - started }, completionReason: result.completion_reason,
    }).task;
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
    return repository.finishRun(run.run_id, {
      runStatus: "failed", taskStatus: retry ? "queued" : "failed", error: classified, nextRetryAt,
      metrics: { duration_ms: performance.now() - started }, completionReason: retry ? "retry-scheduled" : "worker-failed",
    }).task;
  }
}
