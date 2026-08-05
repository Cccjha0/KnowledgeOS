import type { RuntimeTask, TaskPriority } from "./domain.js";
import { RuntimeRepository } from "./repository.js";
import { evaluateResourceGate } from "./resourceGate.js";
import { executeTask, type RuntimeHandler } from "./worker.js";

const PRIORITY: Record<TaskPriority, number> = { critical: 0, high: 1, normal: 2, low: 3 };

export interface DispatchSummary {
  considered: number;
  completed: number;
  failed: number;
  waiting: number;
  tasks: RuntimeTask[];
}

export async function dispatchOnce(options: {
  vaultRoot: string;
  limit?: number;
  workerId?: string;
  /** Restrict a manual/direct dispatch to its newly created Task. */
  taskIds?: string[];
  handlers?: Record<string, RuntimeHandler>;
  /** Test seam; production uses the Core Module Workflow Runner. */
  moduleWorkflowHandler?: RuntimeHandler;
}): Promise<DispatchSummary> {
  const repository = await RuntimeRepository.open(options.vaultRoot);
  const summary: DispatchSummary = { considered: 0, completed: 0, failed: 0, waiting: 0, tasks: [] };
  try {
    const now = Date.now();
    const allTasks = new Map(repository.listTasks().map((task) => [task.task_id, task]));
    const candidates = repository.listTasks(["queued"])
      .filter((task) => !options.taskIds || options.taskIds.includes(task.task_id))
      .filter((task) => Date.parse(task.available_after) <= now && (!task.next_retry_at || Date.parse(task.next_retry_at) <= now))
      .filter((task) => {
        if (!task.dependency_task_ids.length) return true;
        const dependencies = task.dependency_task_ids.map((id) => allTasks.get(id)).filter((item): item is RuntimeTask => Boolean(item));
        if (dependencies.length !== task.dependency_task_ids.length) return false;
        if (task.dependency_policy === "all-finished") return dependencies.every((item) => ["completed", "failed", "cancelled"].includes(item.status));
        if (task.dependency_policy === "any-success") return dependencies.some((item) => item.status === "completed");
        return dependencies.every((item) => item.status === "completed");
      })
      .sort((left, right) => {
        const ageBoost = (task: RuntimeTask) => Math.min(2, Math.floor((now - Date.parse(task.created_at)) / 86_400_000));
        return (PRIORITY[left.priority] - ageBoost(left)) - (PRIORITY[right.priority] - ageBoost(right)) || Date.parse(left.scheduled_for) - Date.parse(right.scheduled_for);
      })
      .slice(0, options.limit ?? 2);
    for (const task of candidates) {
      summary.considered += 1;
      const gate = await evaluateResourceGate(options.vaultRoot, repository, task);
      if (!gate.ready) {
        const waiting = repository.transitionTask(task.task_id, gate.waiting_status!, {
          error: { code: "RESOURCE_UNAVAILABLE", message: gate.reason!, retryable: true, occurred_at: new Date().toISOString(), details: gate.checked },
        });
        summary.waiting += 1;
        summary.tasks.push(waiting);
        continue;
      }
      const result = await executeTask(options.vaultRoot, repository, task, options.workerId ?? `local-worker-${process.pid}`, gate.checked, options.handlers, options.moduleWorkflowHandler);
      if (result.status === "completed") summary.completed += 1;
      else if (result.status === "failed") summary.failed += 1;
      summary.tasks.push(result);
    }
    return summary;
  } finally { repository.close(); }
}
