import { RuntimeRepository } from "../runtime/repository.js";
import { executeTask } from "../runtime/worker.js";
import { runModuleWorkflow } from "./workflowRunner.js";
import type { RuntimeTask } from "../runtime/domain.js";

/** Compatibility entrypoint for CLI integrations; it still uses the Core Runner. */
export async function executeModuleWorkflowNow(options: { vaultRoot: string; moduleId: string; instanceId: string; entrypoint: string; sourceFile: string }): Promise<RuntimeTask> {
  const repository = await RuntimeRepository.open(options.vaultRoot);
  try {
    const created = repository.createTask({
      job_id: `${options.moduleId}.direct-invocation`, module: options.moduleId, instance_id: options.instanceId,
      task_type: "workflow", workflow: `module:${options.moduleId}:${options.entrypoint}`, priority: "high",
      resources: { filesystem: "required", network: "not-required", codex: "not-required", user: "not-required" },
      trigger: { type: "manual", workflow_id: options.entrypoint, workflow_version: "active", entrypoint: options.entrypoint },
      catch_up_policy: "none", idempotency_key: `direct:${options.moduleId}:${options.entrypoint}:${options.sourceFile}`,
      payload: { source_file: options.sourceFile, instance_id: options.instanceId }, concurrency_key: `direct:${options.moduleId}:${options.instanceId}:${options.entrypoint}`, concurrency_policy: "forbid",
    });
    return executeTask(options.vaultRoot, repository, created.task, "cli-module-workflow", { filesystem: "available", network: "unknown", codex: "unknown", user: "available" }, {}, runModuleWorkflow);
  } finally { repository.close(); }
}
