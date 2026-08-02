import { collectApplicationDashboardItems } from "../application/dashboard.js";
import { buildTodaySnapshot, writeTodayMarkdown, writeTodayMarkdownWithResult, type TodayWriteResult } from "../core/dashboard.js";
import type { DashboardItem, TodaySnapshot } from "../core/types.js";
import { qualityIssueToDashboardItem } from "../quality/presentation.js";
import { QualityRepository } from "../quality/repository.js";
import { RuntimeRepository } from "../runtime/repository.js";
import { discoverInboxContext, discoverInboxItems, inboxDashboardItem } from "./inboxDiscovery.js";

export async function getTodaySnapshot(vaultRoot: string): Promise<TodaySnapshot> {
  const context = await discoverInboxContext(vaultRoot);
  const enabled = new Set(context.modules.map((module) => String(module.data.id)));
  const items = (await discoverInboxItems(vaultRoot, context))
    .filter((item) => !["ignored", "unmanaged", "processed", "deferred"].includes(item.state)).map(inboxDashboardItem);
  if (enabled.has("application-tracker")) {
    const activeInstances = new Set(context.instances.map((instance) => String(instance.data.instance_id)));
    items.push(...(await collectApplicationDashboardItems(vaultRoot)).filter((item) => item.instance_id === null || activeInstances.has(item.instance_id)));
  }
  const runtime = await RuntimeRepository.open(vaultRoot);
  try {
    const now = Date.now();
    for (const task of runtime.listTasks()) {
      let item: DashboardItem | null = null;
      const priority: DashboardItem["priority"] = task.priority === "normal" ? "medium" : task.priority;
      const common = { item_id: `DSH-TASK-${task.task_id}`, source_module: task.module, instance_id: task.instance_id, title: `${task.job_id} · ${task.status}`, target: null, created_at: task.created_at, blocks_count: 0, active_context: ["critical", "high"].includes(task.priority), actions: ["open"] };
      if (task.status === "failed") item = { ...common, category: "system", priority, description: task.last_error?.message ?? "任务重试已用尽。", due_at: null };
      else if (task.status === "waiting-for-user") item = { ...common, category: "action", priority, description: task.last_error?.message ?? "等待用户操作。", due_at: task.defer_until };
      else if (["waiting-for-network", "waiting-for-ai"].includes(task.status)) {
        const waitingFor = Date.parse(task.updated_at || task.created_at); const longWaiting = Number.isFinite(waitingFor) && now - waitingFor >= 86_400_000;
        if (task.priority !== "low" || longWaiting) item = { ...common, category: "research", priority, description: task.last_error?.message ?? "等待资源恢复。", due_at: null, actions: ["open", "run"] };
      }
      else if (task.status === "queued" && Date.parse(task.scheduled_for) - now < 86_400_000 && ["critical", "high"].includes(task.priority)) item = { ...common, category: "deadline", priority, description: "即将执行的重要任务。", due_at: task.scheduled_for };
      if (item) items.push(item as DashboardItem);
    }
  } finally { runtime.close(); }
  const quality = await QualityRepository.open(vaultRoot);
  try {
    items.push(...quality.listIssues({ statuses: ["open", "acknowledged", "scheduled"] })
      .filter((issue) => ["critical", "high"].includes(issue.severity) || issue.issue_type === "overdue-review")
      .map(qualityIssueToDashboardItem));
  } finally { quality.close(); }
  return buildTodaySnapshot(vaultRoot, items, enabled);
}

export async function rebuildTodayDashboard(vaultRoot: string): Promise<string> {
  return writeTodayMarkdown(vaultRoot, await getTodaySnapshot(vaultRoot));
}

export async function rebuildTodayDashboardWithResult(vaultRoot: string): Promise<TodayWriteResult> {
  return writeTodayMarkdownWithResult(vaultRoot, await getTodaySnapshot(vaultRoot));
}
