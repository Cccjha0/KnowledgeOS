import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectApplicationDashboardItems } from "../application/dashboard.js";
import { buildTodaySnapshot, writeTodayMarkdown } from "../core/dashboard.js";
import { discoverInstances, discoverModules } from "../core/discovery.js";
import { fromVaultPath, listFilesRecursive, toVaultPath } from "../core/files.js";
import type { DashboardItem, JsonObject, TodaySnapshot } from "../core/types.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

async function inboxItem(
  vaultRoot: string,
  absolute: string,
  moduleId: string,
  instanceId: string | null,
  sequence: number,
): Promise<DashboardItem> {
  const stat = await fs.stat(absolute);
  return {
    item_id: `DSH-INBOX-${String(sequence).padStart(6, "0")}`,
    source_module: moduleId,
    instance_id: instanceId,
    category: "action",
    priority: "medium",
    title: path.basename(absolute),
    description: instanceId ? `等待 ${instanceId} 处理` : `等待 ${moduleId} 处理`,
    target: toVaultPath(vaultRoot, absolute),
    due_at: null,
    created_at: stat.birthtime.toISOString(),
    blocks_count: 0,
    active_context: true,
    actions: ["open", "run"],
  };
}

async function collectGenericInboxItems(vaultRoot: string, enabledModules: Set<string>): Promise<DashboardItem[]> {
  const items: DashboardItem[] = [];
  const seen = new Set<string>();
  let sequence = 0;
  const addDirectory = async (vaultPath: string, moduleId: string, instanceId: string | null): Promise<void> => {
    for (const file of await listFilesRecursive(fromVaultPath(vaultRoot, vaultPath))) {
      const relative = toVaultPath(vaultRoot, file);
      if (seen.has(relative)) continue;
      seen.add(relative);
      items.push(await inboxItem(vaultRoot, file, moduleId, instanceId, ++sequence));
    }
  };

  await addDirectory("00-Inbox", "core", null);
  for (const module of await discoverModules(ENGINE_ROOT)) {
    const moduleId = String(module.data.id);
    if (!enabledModules.has(moduleId)) continue;
    const inbox = object(module.data.inbox);
    const moduleLevel = object(inbox?.module_level);
    if (moduleLevel?.enabled === true && typeof moduleLevel.path === "string") {
      await addDirectory(moduleLevel.path, moduleId, null);
    }
  }
  for (const instance of await discoverInstances(vaultRoot)) {
    const moduleId = String(instance.data.module_id);
    if (!enabledModules.has(moduleId) || instance.data.status !== "active") continue;
    if (typeof instance.data.inbox_path === "string") {
      await addDirectory(instance.data.inbox_path, moduleId, String(instance.data.instance_id));
    }
  }
  return items;
}

export async function getTodaySnapshot(vaultRoot: string): Promise<TodaySnapshot> {
  const modules = await discoverModules(ENGINE_ROOT);
  const enabled = new Set(
    modules.filter((module) => module.data.status === "enabled").map((module) => String(module.data.id)),
  );
  const items = await collectGenericInboxItems(vaultRoot, enabled);
  if (enabled.has("application-tracker")) items.push(...await collectApplicationDashboardItems(vaultRoot));
  return buildTodaySnapshot(vaultRoot, items);
}

export async function rebuildTodayDashboard(vaultRoot: string): Promise<string> {
  return writeTodayMarkdown(vaultRoot, await getTodaySnapshot(vaultRoot));
}
