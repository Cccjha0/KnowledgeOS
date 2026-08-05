import { fileURLToPath } from "node:url";
import path from "node:path";
import { discoverModulesForVault } from "../core/discovery.js";
import { fromVaultPath, sha256File } from "../core/files.js";
import { RuntimeRepository } from "../runtime/repository.js";
import { dispatchOnce } from "../runtime/dispatcher.js";
import { probeRuntimeResources } from "../runtime/resourceMonitor.js";
import { resolveWorkflowResourceContract } from "./workflowResources.js";
import type { RuntimeTask } from "../runtime/domain.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Compatibility entrypoint for CLI integrations. It enqueues a durable Task and dispatches it through the normal resource gate. */
export async function executeModuleWorkflowNow(options: { vaultRoot: string; moduleId: string; instanceId: string; entrypoint: string; sourceFile: string; codexExecutable?: string }): Promise<RuntimeTask> {
  const module = (await discoverModulesForVault(ENGINE_ROOT, options.vaultRoot)).find((entry) => entry.data.id === options.moduleId && entry.data.status === "enabled");
  if (!module) throw new Error(`Enabled module ${options.moduleId} was not found.`);
  const workflow = resolveWorkflowResourceContract(module, null, options.entrypoint);
  const sourceHash = await sha256File(fromVaultPath(options.vaultRoot, options.sourceFile));
  let taskId: string;
  const repository = await RuntimeRepository.open(options.vaultRoot);
  try {
    const created = repository.createTask({
      job_id: `${options.moduleId}.direct-invocation`, module: options.moduleId, instance_id: options.instanceId,
      task_type: "workflow", workflow: `module:${options.moduleId}:${options.entrypoint}`, priority: "high",
      resources: workflow.resources,
      trigger: { type: "manual", workflow_id: workflow.workflow_id, workflow_version: workflow.workflow_version, entrypoint: options.entrypoint },
      catch_up_policy: "none", idempotency_key: `direct:${options.moduleId}:${options.entrypoint}:${sourceHash}:${workflow.workflow_version}`,
      payload: { source_file: options.sourceFile, source_hash: sourceHash, instance_id: options.instanceId }, concurrency_key: `direct:${options.moduleId}:${options.instanceId}:${options.entrypoint}`, concurrency_policy: "forbid",
    });
    taskId = created.task.task_id;
  } finally { repository.close(); }
  await probeRuntimeResources(options.vaultRoot, { codexExecutable: options.codexExecutable });
  await dispatchOnce({ vaultRoot: options.vaultRoot, limit: 1, workerId: "cli-module-workflow", taskIds: [taskId] });
  const result = await RuntimeRepository.open(options.vaultRoot);
  try {
    const task = result.getTask(taskId);
    if (!task) throw new Error(`Direct invocation task ${taskId} disappeared.`);
    return task;
  } finally { result.close(); }
}
