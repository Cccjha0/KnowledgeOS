import { performance } from "node:perf_hooks";
import { PkbError } from "../core/errors.js";
import type { JsonObject } from "../core/types.js";
import { rebuildTodayDashboard } from "../platform/dashboard.js";
import { discoverInboxItems } from "../platform/inboxDiscovery.js";
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
};

function runtimeError(error: unknown): RuntimeError {
  const code = error instanceof PkbError ? error.code : "WORKER_FAILED";
  return {
    code, message: error instanceof Error ? error.message : String(error), retryable: false,
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
    return repository.finishRun(run.run_id, {
      runStatus: "failed", taskStatus: "failed", error: runtimeError(error),
      metrics: { duration_ms: performance.now() - started }, completionReason: "worker-failed",
    }).task;
  }
}
