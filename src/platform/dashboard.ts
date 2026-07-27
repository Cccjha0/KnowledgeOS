import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectApplicationDashboardItems } from "../application/dashboard.js";
import { buildTodaySnapshot, writeTodayMarkdown } from "../core/dashboard.js";
import { discoverInstances, discoverModulesForVault } from "../core/discovery.js";
import type { TodaySnapshot } from "../core/types.js";
import { discoverInboxItems, inboxDashboardItem } from "./inboxDiscovery.js";
import { RuntimeRepository } from "../runtime/repository.js";
import type { DashboardItem } from "../core/types.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function getTodaySnapshot(vaultRoot: string): Promise<TodaySnapshot> {
  const modules = await discoverModulesForVault(ENGINE_ROOT, vaultRoot);
  const enabled = new Set(
    modules.filter((module) => module.data.status === "enabled").map((module) => String(module.data.id)),
  );
  const items = (await discoverInboxItems(vaultRoot))
    .filter((item) => !["ignored", "unmanaged", "processed", "deferred"].includes(item.state))
    .map(inboxDashboardItem);
  if (enabled.has("application-tracker")) {
    const activeInstances = new Set((await discoverInstances(vaultRoot))
      .filter((instance) => instance.data.status === "active").map((instance) => String(instance.data.instance_id)));
    items.push(...(await collectApplicationDashboardItems(vaultRoot)).filter((item) => item.instance_id === null || activeInstances.has(item.instance_id)));
  }
  const runtime = await RuntimeRepository.open(vaultRoot);
  try {
    const now = Date.now();
    for (const task of runtime.listTasks()) {
      let item: DashboardItem | null = null;
      const dashboardPriority: DashboardItem["priority"] = task.priority === "normal" ? "medium" : task.priority;
      const common = {
        item_id: `DSH-TASK-${task.task_id}`, source_module: task.module, instance_id: task.instance_id,
        title: `${task.job_id} · ${task.status}`, target: null, created_at: task.created_at, blocks_count: 0,
        active_context: task.priority === "critical" || task.priority === "high", actions: ["open"],
      };
      if (task.status === "failed") item = { ...common, category: "system", priority: dashboardPriority, description: task.last_error?.message ?? "任务重试已用尽。", due_at: null };
      else if (task.status === "waiting-for-user") item = { ...common, category: "action", priority: dashboardPriority, description: task.last_error?.message ?? "等待用户操作。", due_at: task.defer_until };
      else if (["waiting-for-network", "waiting-for-ai"].includes(task.status)) item = { ...common, category: "research", priority: dashboardPriority, description: task.last_error?.message ?? "等待资源恢复。", due_at: null, actions: ["open", "run"] };
      else if (task.status === "queued" && Date.parse(task.scheduled_for) - now < 86_400_000 && ["critical", "high"].includes(task.priority)) item = { ...common, category: "deadline", priority: dashboardPriority, description: "即将执行的重要任务。", due_at: task.scheduled_for };
      if (item) items.push(item);
    }
  } finally { runtime.close(); }
  return buildTodaySnapshot(vaultRoot, items, enabled);
}

export async function rebuildTodayDashboard(vaultRoot: string): Promise<string> {
  return writeTodayMarkdown(vaultRoot, await getTodaySnapshot(vaultRoot));
}
