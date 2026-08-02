import { recoverInterruptedTransactions } from "../core/operationExecutor.js";
import { evaluateScheduler } from "./scheduler.js";
import { RuntimeRepository } from "./repository.js";

export async function reconcileStartup(vaultRoot: string, now = new Date()): Promise<Record<string, unknown>> {
  const repository = await RuntimeRepository.open(vaultRoot);
  let databaseRecovery;
  try {
    databaseRecovery = repository.reconcile(now.toISOString(), new Date(now.getTime() - 90_000).toISOString());
    for (const task of repository.listTasks(["interrupted"])) {
      const safe = task.task_type === "core-operation" || task.attempt_count === 0;
      repository.transitionTask(task.task_id, safe ? "queued" : "waiting-for-user", {
        error: { code: "TASK_INTERRUPTED", message: safe ? "Interrupted task was safely requeued." : "Interrupted write workflow requires user review.", retryable: safe, occurred_at: now.toISOString(), details: {} },
      });
    }
    for (const status of repository.getResourceStatuses()) if (status.status === "available") repository.wakeResourceTasks(status.resource);
  } finally { repository.close(); }
  const transactions = await recoverInterruptedTransactions(vaultRoot);
  const scheduler = await evaluateScheduler(vaultRoot, now);
  return { database: databaseRecovery, transactions, scheduler };
}
