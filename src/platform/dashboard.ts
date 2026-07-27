import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectApplicationDashboardItems } from "../application/dashboard.js";
import { buildTodaySnapshot, writeTodayMarkdown } from "../core/dashboard.js";
import { discoverModules } from "../core/discovery.js";
import type { TodaySnapshot } from "../core/types.js";
import { discoverInboxItems, inboxDashboardItem } from "./inboxDiscovery.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function getTodaySnapshot(vaultRoot: string): Promise<TodaySnapshot> {
  const modules = await discoverModules(ENGINE_ROOT);
  const enabled = new Set(
    modules.filter((module) => module.data.status === "enabled").map((module) => String(module.data.id)),
  );
  const items = (await discoverInboxItems(vaultRoot))
    .filter((item) => !["ignored", "unmanaged", "processed", "deferred"].includes(item.state))
    .map(inboxDashboardItem);
  if (enabled.has("application-tracker")) items.push(...await collectApplicationDashboardItems(vaultRoot));
  return buildTodaySnapshot(vaultRoot, items);
}

export async function rebuildTodayDashboard(vaultRoot: string): Promise<string> {
  return writeTodayMarkdown(vaultRoot, await getTodaySnapshot(vaultRoot));
}
