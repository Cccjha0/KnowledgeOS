import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMarkdown } from "../core/bridge.js";
import { discoverInstances, discoverModules, type DiscoveredDocument } from "../core/discovery.js";
import { fromVaultPath, listFilesRecursive, readJson, toVaultPath, writeJsonAtomic } from "../core/files.js";
import type { DashboardItem, JsonObject, JsonValue } from "../core/types.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export type InboxItemState = "pending" | "processing" | "waiting-for-user" | "waiting-for-ai" | "failed" | "processed" | "deferred" | "ignored" | "unmanaged";

export interface InboxStateRecord extends JsonObject {
  schema_version: 1;
  item_id: string;
  path: string;
  state: InboxItemState;
  attempts: number;
  review_after: string | null;
  error: string | null;
  run_id: string | null;
  plan_id: string | null;
  result: JsonValue;
  updated_at: string;
}

export interface InboxItemView extends JsonObject {
  item_id: string;
  path: string;
  filename: string;
  title: string;
  extension: string;
  size: number;
  created_at: string;
  modified_at: string;
  scope: "global" | "module" | "instance";
  source_module: string | null;
  instance_id: string | null;
  content_type: string;
  state: InboxItemState;
  confidence: number;
  reasons: string[];
  required_read_level: number;
  requires_ai: boolean;
  processor: "application-research-report" | "module-workflow" | "routing-only";
  suggested_module_id: string | null;
  suggested_instance_id: string | null;
  auto_route_threshold: number;
  retryable: boolean;
  error: string | null;
  review_after: string | null;
  available_actions: string[];
}

export interface InboxListing extends JsonObject {
  generated_at: string;
  items: InboxItemView[];
  groups: JsonObject[];
  counts: JsonObject;
}

interface InboxRoot {
  path: string;
  scope: InboxItemView["scope"];
  moduleId: string | null;
  instanceId: string | null;
}

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function itemId(vaultPath: string): string {
  return `INBOX-${createHash("sha256").update(vaultPath).digest("hex").slice(0, 16).toUpperCase()}`;
}

export function inboxStatePath(vaultRoot: string, id: string): string {
  return path.join(vaultRoot, "90-System", "State", "Inbox", `${id}.json`);
}

export async function writeInboxState(vaultRoot: string, state: InboxStateRecord): Promise<void> {
  state.updated_at = new Date().toISOString();
  await writeJsonAtomic(inboxStatePath(vaultRoot, state.item_id), state);
}

function moduleThreshold(module: DiscoveredDocument | undefined): number {
  const routing = object(module?.data.routing);
  return typeof routing?.auto_route_threshold === "number" ? routing.auto_route_threshold : 1;
}

async function roots(vaultRoot: string): Promise<{ roots: InboxRoot[]; modules: DiscoveredDocument[]; instances: DiscoveredDocument[] }> {
  const modules = (await discoverModules(ENGINE_ROOT)).filter((entry) => entry.data.status === "enabled");
  const instances = (await discoverInstances(vaultRoot)).filter((entry) => entry.data.status === "active");
  const enabled = new Set(modules.map((entry) => String(entry.data.id)));
  const result: InboxRoot[] = [{ path: "00-Inbox", scope: "global", moduleId: null, instanceId: null }];
  for (const module of modules) {
    const level = object(object(module.data.inbox)?.module_level);
    if (level?.enabled === true && typeof level.path === "string") {
      result.push({ path: level.path, scope: "module", moduleId: String(module.data.id), instanceId: null });
    }
  }
  for (const instance of instances) {
    const moduleId = String(instance.data.module_id);
    if (enabled.has(moduleId) && typeof instance.data.inbox_path === "string") {
      result.push({ path: instance.data.inbox_path, scope: "instance", moduleId, instanceId: String(instance.data.instance_id) });
    }
  }
  return { roots: result, modules, instances };
}

function availableActions(state: InboxItemState): string[] {
  if (state === "failed") return ["preview", "open", "retry", "defer", "ignore", "unmanage"];
  if (["ignored", "unmanaged", "processed"].includes(state)) return ["open"];
  return ["preview", "open", "process", "select-route", "defer", "ignore", "unmanage"];
}

async function inspectItem(
  vaultRoot: string,
  absolute: string,
  root: InboxRoot,
  modules: DiscoveredDocument[],
  instances: DiscoveredDocument[],
): Promise<InboxItemView> {
  const vaultPath = toVaultPath(vaultRoot, absolute);
  const id = itemId(vaultPath);
  const stat = await fs.stat(absolute);
  const extension = path.extname(absolute).toLowerCase();
  let data: JsonObject = {};
  if (extension === ".md") {
    try { data = parseMarkdown(vaultRoot, absolute).data; } catch { data = {}; }
  }
  const hintModule = typeof data.source_module === "string" ? data.source_module : null;
  const hintInstance = typeof data.instance_id === "string" ? data.instance_id : null;
  const validInstance = instances.find((entry) => entry.data.instance_id === hintInstance);
  const validModule = modules.find((entry) => entry.data.id === (validInstance?.data.module_id ?? hintModule));
  let suggestedModule = root.moduleId ?? (validModule ? String(validModule.data.id) : null);
  let suggestedInstance = root.instanceId ?? (validInstance ? String(validInstance.data.instance_id) : null);
  let confidence = root.scope === "instance" ? 1 : root.scope === "module" ? 0.98 : suggestedInstance ? 1 : suggestedModule ? 0.95 : 0;
  const reasons: string[] = root.scope === "global" ? [] : [`located-in-${root.scope}-inbox`];
  if (validInstance) reasons.push("valid-instance-hint");
  else if (validModule) reasons.push("valid-module-hint");
  const applicationReport = data.research_type === "application-update" && typeof data.report_id === "string" && typeof data.instance_id === "string";
  if (applicationReport) {
    suggestedModule = "application-tracker";
    suggestedInstance = String(data.instance_id);
    confidence = 1;
    reasons.push("structured-application-research-report");
  }
  if (!suggestedModule) reasons.push("no-reliable-route");
  const processor: InboxItemView["processor"] = applicationReport
    ? "application-research-report"
    : root.scope === "global" && suggestedModule ? "routing-only" : "module-workflow";
  const requiresAi = processor === "module-workflow" || (extension !== ".md" && processor !== "routing-only");
  const stored = await readJson<InboxStateRecord | null>(inboxStatePath(vaultRoot, id), null);
  let state: InboxItemState = stored?.state ?? (!suggestedModule ? "waiting-for-user" : requiresAi ? "waiting-for-ai" : "pending");
  const interrupted = state === "processing";
  if (interrupted) state = "failed";
  if (state === "deferred" && stored?.review_after && Date.parse(stored.review_after) <= Date.now()) state = requiresAi ? "waiting-for-ai" : "pending";
  return {
    item_id: id, path: vaultPath, filename: path.basename(absolute), title: typeof data.title === "string" ? data.title : path.basename(absolute),
    extension, size: stat.size, created_at: stat.birthtime.toISOString(), modified_at: stat.mtime.toISOString(),
    scope: root.scope, source_module: root.moduleId, instance_id: root.instanceId,
    content_type: typeof data.content_type === "string" ? data.content_type : applicationReport ? "research-report" : extension.slice(1) || "file",
    state, confidence, reasons, required_read_level: requiresAi ? 1 : 0, requires_ai: requiresAi,
    processor, suggested_module_id: suggestedModule, suggested_instance_id: suggestedInstance,
    auto_route_threshold: moduleThreshold(modules.find((entry) => entry.data.id === suggestedModule)),
    retryable: state === "failed", error: interrupted ? "Previous processing was interrupted; explicit retry is required." : stored?.error ?? null, review_after: stored?.review_after ?? null,
    available_actions: availableActions(state),
  };
}

export async function discoverInboxItems(vaultRoot: string): Promise<InboxItemView[]> {
  const discovered = await roots(vaultRoot);
  const seen = new Set<string>();
  const output: InboxItemView[] = [];
  for (const root of discovered.roots) {
    for (const absolute of await listFilesRecursive(fromVaultPath(vaultRoot, root.path))) {
      const relative = toVaultPath(vaultRoot, absolute);
      if (seen.has(relative)) continue;
      seen.add(relative);
      output.push(await inspectItem(vaultRoot, absolute, root, discovered.modules, discovered.instances));
    }
  }
  return output.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.path.localeCompare(b.path));
}

export async function listInbox(vaultRoot: string, params: JsonObject = {}): Promise<InboxListing> {
  const includeClosed = params.include_closed === true;
  const moduleId = typeof params.module_id === "string" ? params.module_id : null;
  const instanceId = typeof params.instance_id === "string" ? params.instance_id : null;
  const state = typeof params.state === "string" ? params.state : null;
  const all = await discoverInboxItems(vaultRoot);
  const items = all.filter((item) => (includeClosed || !["ignored", "unmanaged", "processed"].includes(item.state)) &&
    (!moduleId || item.suggested_module_id === moduleId) && (!instanceId || item.suggested_instance_id === instanceId) && (!state || item.state === state));
  const groups = new Map<string, JsonObject>();
  for (const item of items) {
    const key = item.state === "failed" ? "failed" : item.suggested_instance_id ? `instance:${item.suggested_instance_id}` : item.suggested_module_id ? `module:${item.suggested_module_id}` : "needs-routing";
    const group = groups.get(key) ?? { group_id: key, label: key === "needs-routing" ? "Needs routing" : key === "failed" ? "Failed" : key.split(":")[1]!, count: 0, items: [] };
    group.count = Number(group.count) + 1;
    (group.items as JsonValue[]).push(item);
    groups.set(key, group);
  }
  return {
    generated_at: new Date().toISOString(), items, groups: [...groups.values()],
    counts: {
      total: items.length, needs_routing: items.filter((item) => !item.suggested_module_id).length,
      waiting_for_ai: items.filter((item) => item.state === "waiting-for-ai").length,
      failed: items.filter((item) => item.state === "failed").length,
      high_confidence: items.filter((item) => item.confidence >= item.auto_route_threshold && !item.requires_ai).length,
    },
  };
}

export function inboxDashboardItem(item: InboxItemView): DashboardItem {
  const actions = item.state === "failed"
    ? ["open", "retry"]
    : item.state === "waiting-for-user"
      ? ["open", "run", "defer", "dismiss"]
      : ["open", "run", "defer"];
  return {
    item_id: `DSH-${item.item_id}`, source_module: item.suggested_module_id ?? "core", instance_id: item.suggested_instance_id,
    category: item.state === "failed" ? "system" : "action", priority: item.state === "failed" ? "high" : "medium",
    title: item.title, description: item.state === "waiting-for-user" ? "Needs a routing decision." : item.state === "waiting-for-ai" ? "Waiting for module/Codex processing." : `Inbox state: ${item.state}`,
    target: item.path, due_at: item.review_after, created_at: item.created_at, blocks_count: 0, active_context: true,
    actions,
  };
}
