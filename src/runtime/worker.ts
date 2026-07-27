import { performance } from "node:perf_hooks";
import { PkbError } from "../core/errors.js";
import type { JsonObject } from "../core/types.js";
import { rebuildTodayDashboard } from "../platform/dashboard.js";
import { discoverInboxItems } from "../platform/inboxDiscovery.js";
import { doctorVault } from "../core/vault.js";
import { syncDueResearchRequests } from "../platform/researchRequestWorkflow.js";
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

export type RuntimeHandler = (context: { vaultRoot: string; task: RuntimeTask }) => Promise<WorkerResult>;

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
  "application:sync-due-research": async ({ vaultRoot }) => {
    const result = await syncDueResearchRequests(vaultRoot);
    return { completion_reason: result.created.length ? "research-requests-created" : "no-due-applications", operation_plan_id: result.planPath, git_snapshot_id: result.snapshot, output_files: result.created, metrics: { created: result.created.length, existing: result.existing.length } };
  },
};

function runtimeError(error: unknown): RuntimeError {
  const code = error instanceof PkbError ? error.code : "WORKER_FAILED";
  return {
    code, message: error instanceof Error ? error.message : String(error), retryable: ["EBUSY", "EACCES", "ETIMEDOUT", "RATE_LIMITED", "NETWORK_UNAVAILABLE", "CODEX_UNAVAILABLE"].includes(code),
    occurred_at: new Date().toISOString(), details: {},
  };
}

export async function executeTask(vaultRoot: string, repository: RuntimeRepository, task: RuntimeTask, workerId: string, resourcesChecked: JsonObject, handlers: Record<string, RuntimeHandler> = {}): Promise<RuntimeTask> {
  const handler = handlers[task.workflow] ?? coreHandlers[task.workflow];
  const run = repository.startRun(task.task_id, workerId, resourcesChecked);
  const started = performance.now();
  if (!handler) {
    return repository.finishRun(run.run_id, {
      runStatus: "failed", taskStatus: "failed", error: runtimeError(new PkbError("WORKFLOW_NOT_FOUND", `No runtime handler is registered for ${task.workflow}.`)),
      metrics: { duration_ms: performance.now() - started }, completionReason: "workflow-not-found",
    }).task;
  }
  try {
    const result = await handler({ vaultRoot, task });
    return repository.finishRun(run.run_id, {
      runStatus: "completed", taskStatus: "completed", operationPlanId: result.operation_plan_id,
      gitSnapshotId: result.git_snapshot_id, inputFiles: result.input_files, outputFiles: result.output_files,
      metrics: { ...(result.metrics ?? {}), duration_ms: performance.now() - started }, completionReason: result.completion_reason,
    }).task;
  } catch (error) {
    const classified = runtimeError(error);
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
