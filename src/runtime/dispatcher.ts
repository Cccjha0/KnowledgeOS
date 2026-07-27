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
  handlers?: Record<string, RuntimeHandler>;
}): Promise<DispatchSummary> {
  const repository = await RuntimeRepository.open(options.vaultRoot);
  const summary: DispatchSummary = { considered: 0, completed: 0, failed: 0, waiting: 0, tasks: [] };
  try {
    const now = Date.now();
    const candidates = repository.listTasks(["queued"])
      .filter((task) => Date.parse(task.available_after) <= now && (!task.next_retry_at || Date.parse(task.next_retry_at) <= now))
      .sort((left, right) => PRIORITY[left.priority] - PRIORITY[right.priority] || Date.parse(left.scheduled_for) - Date.parse(right.scheduled_for))
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
      const result = await executeTask(options.vaultRoot, repository, task, options.workerId ?? `local-worker-${process.pid}`, gate.checked, options.handlers);
      if (result.status === "completed") summary.completed += 1;
      else if (result.status === "failed") summary.failed += 1;
      summary.tasks.push(result);
    }
    return summary;
  } finally { repository.close(); }
}
