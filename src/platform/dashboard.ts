import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectApplicationDashboardItems } from "../application/dashboard.js";
import { buildTodaySnapshot, writeTodayMarkdown } from "../core/dashboard.js";
import { discoverInstances, discoverModulesForVault } from "../core/discovery.js";
import type { TodaySnapshot } from "../core/types.js";
import { discoverInboxItems, inboxDashboardItem } from "./inboxDiscovery.js";

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
  return buildTodaySnapshot(vaultRoot, items, enabled);
}

export async function rebuildTodayDashboard(vaultRoot: string): Promise<string> {
  return writeTodayMarkdown(vaultRoot, await getTodaySnapshot(vaultRoot));
}
