import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMarkdown, parseMarkdownBatch } from "../core/bridge.js";
import { discoverRoutingContext, type DiscoveredDocument, type RoutingDiscoveryContext } from "../core/discovery.js";
import { fromVaultPath, listFilesRecursive, readJson, toVaultPath, writeJsonAtomic } from "../core/files.js";
import type { DashboardItem, JsonObject, JsonValue } from "../core/types.js";
import { resolveWorkflowResourceContract } from "../modules/workflowResources.js";
import type { RepresentationLevel } from "../core/readLevels.js";
import { incrementPerformanceDiagnostic } from "../core/performanceDiagnostics.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export type InboxItemState = "pending" | "processing" | "waiting-for-user" | "waiting-for-ai" | "failed" | "empty" | "processed" | "deferred" | "ignored" | "unmanaged";
export type InboxRequiredUserAction = "select-route" | "classify-attachment" | "review-partial-extraction" | "close-open-file" | "resolve-review";

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
  task_id: string | null;
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
  lifecycle_revision: string;
  scope: "global" | "module" | "instance";
  source_module: string | null;
  instance_id: string | null;
  content_type: string;
  state: InboxItemState;
  confidence: number;
  reasons: string[];
  required_representation: RepresentationLevel;
  /** @deprecated UI compatibility alias for required_representation; never an authorization input. */
  required_read_level: number;
  requires_ai: boolean;
  /** A generic processor identifier; module-owned details live in processor_descriptor. */
  processor: string;
  processor_descriptor: JsonObject | null;
  suggested_module_id: string | null;
  suggested_instance_id: string | null;
  auto_route_threshold: number;
  retryable: boolean;
  blocked_by_open_editor: boolean;
  error: string | null;
  review_after: string | null;
  task_id: string | null;
  available_actions: string[];
  required_user_action: InboxRequiredUserAction | null;
  /** Structured data for a user action; never infer privacy state from an error string. */
  attachment_classification: JsonObject | null;
}

export interface InboxListing extends JsonObject {
  generated_at: string;
  items: InboxItemView[];
  groups: JsonObject[];
  counts: JsonObject;
}

export interface InboxRoot {
  path: string;
  scope: InboxItemView["scope"];
  moduleId: string | null;
  instanceId: string | null;
}

export interface InboxDiscoveryContext {
  roots: InboxRoot[];
  modules: DiscoveredDocument[];
  instances: DiscoveredDocument[];
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

interface MatchedInboxProcessor {
  moduleId: string;
  id: string;
  descriptor: JsonObject;
  instanceField: string | null;
}

function publicProcessorDescriptor(id: string, descriptor: JsonObject): JsonObject {
  return {
    id,
    label: descriptor.label ?? null,
    risk: descriptor.risk ?? null,
    preview_target: descriptor.preview_target ?? null,
    preview_kind: descriptor.preview_kind ?? "module-processing",
    content_type: descriptor.content_type ?? null,
  };
}

/** Matches module-owned structured captures without teaching Core any business
 * record type. A descriptor may only compare primitive frontmatter values. */
function matchInboxProcessor(data: JsonObject, modules: DiscoveredDocument[]): MatchedInboxProcessor | null {
  for (const module of modules) {
    const processors = object(module.data.inbox_processors) ?? {};
    for (const [id, raw] of Object.entries(processors)) {
      const descriptor = object(raw); const matcher = object(descriptor?.matcher); const fields = object(matcher?.fields);
      if (!descriptor || !matcher || !fields || !Object.entries(fields).every(([field, expected]) => data[field] === expected)) continue;
      const required = Array.isArray(matcher.required_fields) ? matcher.required_fields : [];
      if (!required.every((field) => typeof field === "string" && data[field] !== undefined && data[field] !== null && String(data[field]).trim())) continue;
      return { moduleId: String(module.data.id), id, descriptor: publicProcessorDescriptor(id, descriptor), instanceField: typeof descriptor.instance_field === "string" ? descriptor.instance_field : null };
    }
  }
  return null;
}

export async function discoverInboxContext(vaultRoot: string, existing?: RoutingDiscoveryContext): Promise<InboxDiscoveryContext> {
  const routing = existing ?? await discoverRoutingContext(ENGINE_ROOT, vaultRoot);
  const modules = routing.modules.filter((entry) => entry.data.status === "enabled");
  const instances = routing.instances.filter((entry) => entry.data.status === "active");
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

function availableActions(state: InboxItemState, blockedByOpenEditor = false): string[] {
  if (blockedByOpenEditor) return ["preview", "open", "process", "ignore", "unmanage"];
  if (state === "empty") return ["preview", "open", "quarantine-empty", "ignore"];
  if (state === "failed") return ["preview", "open", "retry", "defer", "ignore", "unmanage"];
  if (["ignored", "unmanaged", "processed"].includes(state)) return ["open"];
  return ["preview", "open", "process", "select-route", "defer", "ignore", "unmanage"];
}

function generatedFromEmptySource(data: JsonObject, content: string): boolean {
  const generation = object(data.generation);
  const prompt = object(generation?.prompt);
  const source = Array.isArray(data.sources) && data.sources.length === 1 ? object(data.sources[0]) : null;
  const promptId = typeof prompt?.id === "string" ? prompt.id : "";
  return content.trim().length === 0
    && data.confidence === 0
    && /^normalize-[a-z0-9-]+$/.test(promptId)
    && source?.source_type === "unknown";
}

export async function inspectInboxItem(
  vaultRoot: string,
  absolute: string,
  root: InboxRoot,
  modules: DiscoveredDocument[],
  instances: DiscoveredDocument[],
  parsedDocument?: ReturnType<typeof parseMarkdown> | null,
): Promise<InboxItemView> {
  const vaultPath = toVaultPath(vaultRoot, absolute);
  const id = itemId(vaultPath);
  const stat = await fs.stat(absolute);
  const lifecycleRevision = new Date(Math.max(stat.birthtimeMs, stat.ctimeMs, stat.mtimeMs)).toISOString();
  const extension = path.extname(absolute).toLowerCase();
  let data: JsonObject = {};
  let content = "";
  if (extension === ".md") {
    try {
      const document = parsedDocument === undefined ? parseMarkdown(vaultRoot, absolute) : parsedDocument;
      if (!document) throw new Error("Markdown could not be parsed.");
      data = document.data;
      content = document.content;
    } catch { data = {}; }
  }
  const emptySource = stat.size === 0 || generatedFromEmptySource(data, content);
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
  const matchedProcessor = matchInboxProcessor(data, modules);
  if (matchedProcessor) {
    suggestedModule = matchedProcessor.moduleId;
    if (matchedProcessor.instanceField && typeof data[matchedProcessor.instanceField] === "string") suggestedInstance = String(data[matchedProcessor.instanceField]);
    confidence = 1;
    reasons.push(`matched-inbox-processor:${matchedProcessor.moduleId}:${matchedProcessor.id}`);
  }
  if (!suggestedModule) reasons.push("no-reliable-route");
  const processor = matchedProcessor
    ? `module:${matchedProcessor.moduleId}:${matchedProcessor.id}`
    : root.scope === "global" && suggestedModule ? "routing-only" : "module-workflow";
  const workflowModule = modules.find((entry) => String(entry.data.id) === suggestedModule);
  let workflowContract = null;
  if (!emptySource && processor !== "routing-only" && workflowModule) {
    workflowContract = resolveWorkflowResourceContract(workflowModule, null, "capture");
  }
  const requiresAi = workflowContract?.resources.codex === "required";
  const stored = await readJson<InboxStateRecord | null>(inboxStatePath(vaultRoot, id), null);
  let state: InboxItemState = emptySource ? "empty" : stored?.state ?? (!suggestedModule ? "waiting-for-user" : requiresAi ? "waiting-for-ai" : "pending");
  const storedResult = object(stored?.result);
  const blockedByOpenEditor = stored?.state === "waiting-for-user" && storedResult?.coordination === "obsidian-file-open";
  const processedDestination = typeof storedResult?.destination === "string" ? storedResult.destination : null;
  const reintroducedAfterProcessing = !emptySource && stored?.state === "processed" && processedDestination !== null && processedDestination !== vaultPath &&
    Date.parse(lifecycleRevision) > Date.parse(stored.updated_at) + 1_000;
  if (reintroducedAfterProcessing) {
    state = requiresAi ? "waiting-for-ai" : "pending";
    reasons.push("reintroduced-after-processing");
  }
  if (emptySource) reasons.push(stat.size === 0 ? "empty-source" : "empty-normalization-artifact");
  if (blockedByOpenEditor) reasons.push("obsidian-file-open");
  const interrupted = state === "processing";
  if (interrupted) state = "failed";
  if (state === "deferred" && stored?.review_after && Date.parse(stored.review_after) <= Date.now()) state = requiresAi ? "waiting-for-ai" : "pending";
  const requestedAction = typeof storedResult?.required_user_action === "string" && ["select-route", "classify-attachment", "review-partial-extraction", "close-open-file", "resolve-review"].includes(storedResult.required_user_action)
    ? storedResult.required_user_action as InboxRequiredUserAction
    : null;
  const requiredUserAction: InboxRequiredUserAction | null = state !== "waiting-for-user" ? null
    : blockedByOpenEditor ? "close-open-file"
      : requestedAction ?? (!suggestedModule ? "select-route" : null);
  const attachmentClassification = object(storedResult?.attachment_classification);
  return {
    item_id: id, path: vaultPath, filename: path.basename(absolute), title: emptySource ? `空白副本 · ${path.basename(absolute)}` : typeof data.title === "string" ? data.title : path.basename(absolute),
    extension, size: stat.size, created_at: stat.birthtime.toISOString(), modified_at: stat.mtime.toISOString(), lifecycle_revision: lifecycleRevision,
    scope: root.scope, source_module: root.moduleId, instance_id: root.instanceId,
    content_type: typeof data.content_type === "string" ? data.content_type : typeof matchedProcessor?.descriptor.content_type === "string" ? matchedProcessor.descriptor.content_type : extension.slice(1) || "file",
    state, confidence, reasons,
    required_representation: workflowContract?.read_representation ?? "metadata",
    required_read_level: ({ metadata: 0, summary: 1, full: 2, "sensitive-original": 3 } as const)[workflowContract?.read_representation ?? "metadata"],
    requires_ai: requiresAi,
    processor, processor_descriptor: matchedProcessor?.descriptor ?? null, suggested_module_id: suggestedModule, suggested_instance_id: suggestedInstance,
    auto_route_threshold: moduleThreshold(modules.find((entry) => entry.data.id === suggestedModule)),
    retryable: state === "failed", blocked_by_open_editor: blockedByOpenEditor,
    error: emptySource ? "此文件没有可处理的正文内容。它可能是归档后被重新创建的同名空白副本；请移至恢复区或手动补充内容。" : interrupted ? "Previous processing was interrupted; explicit retry is required." : stored?.error ?? null, review_after: stored?.review_after ?? null,
    task_id: reintroducedAfterProcessing ? null : stored?.task_id ?? null,
    available_actions: availableActions(state, blockedByOpenEditor),
    required_user_action: requiredUserAction,
    attachment_classification: attachmentClassification,
  };
}

export async function discoverInboxItems(vaultRoot: string, context?: InboxDiscoveryContext): Promise<InboxItemView[]> {
  const discovered = context ?? await discoverInboxContext(vaultRoot);
  const seen = new Set<string>();
  const output: InboxItemView[] = [];
  const candidates: Array<{ absolute: string; root: InboxRoot }> = [];
  for (const root of discovered.roots) {
    for (const absolute of await listFilesRecursive(fromVaultPath(vaultRoot, root.path))) {
      const relative = toVaultPath(vaultRoot, absolute);
      if (seen.has(relative)) continue;
      seen.add(relative);
      candidates.push({ absolute, root });
    }
  }
  const markdownFiles = candidates.map((candidate) => candidate.absolute).filter((file) => path.extname(file).toLowerCase() === ".md");
  const parsed = parseMarkdownBatch(vaultRoot, markdownFiles);
  for (const candidate of candidates) {
    const document = parsed.has(candidate.absolute) ? parsed.get(candidate.absolute)! : undefined;
    output.push(await inspectInboxItem(vaultRoot, candidate.absolute, candidate.root, discovered.modules, discovered.instances, document));
  }
  return output.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.path.localeCompare(b.path));
}

export function inboxRootForPath(vaultRoot: string, context: InboxDiscoveryContext, absolute: string): InboxRoot | null {
  const resolved = path.resolve(absolute);
  const matches = context.roots.filter((root) => {
    const rootPath = path.resolve(fromVaultPath(vaultRoot, root.path));
    return resolved === rootPath || resolved.startsWith(`${rootPath}${path.sep}`);
  }).sort((left, right) => right.path.length - left.path.length);
  return matches[0] ?? null;
}

export async function listInbox(vaultRoot: string, params: JsonObject = {}, context?: InboxDiscoveryContext): Promise<InboxListing> {
  const includeClosed = params.include_closed === true;
  const moduleId = typeof params.module_id === "string" ? params.module_id : null;
  const instanceId = typeof params.instance_id === "string" ? params.instance_id : null;
  const state = typeof params.state === "string" ? params.state : null;
  const all = await discoverInboxItems(vaultRoot, context);
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

function inboxIndexLocations(vaultRoot: string): { database: string; state: string; stateRoot: string } {
  const cache = path.join(vaultRoot, "90-System", "Cache");
  return {
    database: path.join(cache, "inbox-summary-index.sqlite"), state: path.join(cache, "inbox-summary-index.state.json"),
    stateRoot: path.join(vaultRoot, "90-System", "State", "Inbox"),
  };
}

async function inboxIndexRevision(vaultRoot: string, context: InboxDiscoveryContext): Promise<string> {
  const hash = createHash("sha256");
  const files = new Set<string>();
  for (const root of context.roots) for (const file of await listFilesRecursive(fromVaultPath(vaultRoot, root.path))) files.add(file);
  for (const file of await listFilesRecursive(inboxIndexLocations(vaultRoot).stateRoot, ".json")) files.add(file);
  for (const file of [...files].sort()) {
    const stat = await fs.stat(file);
    hash.update(`${toVaultPath(vaultRoot, file)}\0${stat.size}\0${stat.mtimeMs}\n`);
  }
  for (const module of context.modules) hash.update(`module:${module.path}:${JSON.stringify(module.data)}\n`);
  for (const instance of context.instances) hash.update(`instance:${instance.path}:${JSON.stringify(instance.data)}\n`);
  return hash.digest("hex");
}

function callInboxIndex<T>(vaultRoot: string, command: string, payload: unknown): T {
  incrementPerformanceDiagnostic("python_subprocesses");
  const result = spawnSync("python", ["-X", "utf8", path.join(ENGINE_ROOT, "tools", "inbox_summary_index.py"), command, inboxIndexLocations(vaultRoot).database], {
    encoding: "utf8", input: JSON.stringify(payload), windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr || result.stdout);
  return (JSON.parse(result.stdout) as { data: T }).data;
}

async function ensureInboxIndex(vaultRoot: string, context: InboxDiscoveryContext): Promise<void> {
  const locations = inboxIndexLocations(vaultRoot);
  const revision = await inboxIndexRevision(vaultRoot, context);
  let recorded: string | null = null;
  try { recorded = (JSON.parse(await fs.readFile(locations.state, "utf8")) as { revision?: string }).revision ?? null; } catch { recorded = null; }
  if (existsSync(locations.database) && recorded === revision) return;
  const items = await discoverInboxItems(vaultRoot, context);
  callInboxIndex(vaultRoot, "replace", items.map((item) => ({
    ...item, closed: ["ignored", "unmanaged", "processed"].includes(item.state) ? 1 : 0, record_json: JSON.stringify(item),
  })));
  await fs.writeFile(locations.state, `${JSON.stringify({ schema_version: 1, revision })}\n`, "utf8");
}

function listingFromItems(items: InboxItemView[], page: JsonObject): InboxListing {
  const groups = new Map<string, JsonObject>();
  for (const item of items) {
    const key = item.state === "failed" ? "failed" : item.suggested_instance_id ? `instance:${item.suggested_instance_id}` : item.suggested_module_id ? `module:${item.suggested_module_id}` : "needs-routing";
    const group = groups.get(key) ?? { group_id: key, label: key === "needs-routing" ? "Needs routing" : key === "failed" ? "Failed" : key.split(":")[1]!, count: 0, items: [] };
    group.count = Number(group.count) + 1; (group.items as JsonValue[]).push(item); groups.set(key, group);
  }
  return {
    generated_at: new Date().toISOString(), items, groups: [...groups.values()],
    counts: {
      total: (page.counts as JsonObject | undefined)?.total ?? page.total ?? items.length,
      needs_routing: (page.counts as JsonObject | undefined)?.needs_routing ?? items.filter((item) => !item.suggested_module_id).length,
      waiting_for_ai: (page.counts as JsonObject | undefined)?.waiting_for_ai ?? items.filter((item) => item.state === "waiting-for-ai").length,
      failed: (page.counts as JsonObject | undefined)?.failed ?? items.filter((item) => item.state === "failed").length,
      high_confidence: items.filter((item) => item.confidence >= item.auto_route_threshold && !item.requires_ai).length,
    },
    page: { has_more: page.has_more === true, next_cursor: page.next_cursor ?? null, total: page.total ?? items.length },
  };
}

export async function listInboxPage(vaultRoot: string, params: JsonObject = {}, context?: InboxDiscoveryContext): Promise<InboxListing> {
  const discovered = context ?? await discoverInboxContext(vaultRoot);
  await ensureInboxIndex(vaultRoot, discovered);
  const page = callInboxIndex<JsonObject>(vaultRoot, "page", params);
  const summaries = Array.isArray(page.items) ? page.items as InboxItemView[] : [];
  const markdownFiles = summaries.map((item) => fromVaultPath(vaultRoot, item.path)).filter((file) => path.extname(file).toLowerCase() === ".md");
  const parsed = parseMarkdownBatch(vaultRoot, markdownFiles);
  const current: InboxItemView[] = [];
  for (const summary of summaries) {
    const absolute = fromVaultPath(vaultRoot, summary.path);
    const root = inboxRootForPath(vaultRoot, discovered, absolute);
    if (!root || !existsSync(absolute)) continue;
    current.push(await inspectInboxItem(vaultRoot, absolute, root, discovered.modules, discovered.instances, parsed.get(absolute)));
  }
  return listingFromItems(current, page);
}

export function inboxDashboardItem(item: InboxItemView): DashboardItem {
  const failedByModelVersion = item.error && /requires a newer version|model unavailable|model.*not available/i.test(item.error);
  const title = item.state === "empty" ? "Inbox 中有空白副本" : item.state === "failed" ? "Inbox 文件处理失败" : item.title;
  const description = item.state === "empty"
    ? `文件“${item.filename}”没有正文内容，系统不会交给 AI 处理。请在 Inbox 中将它移至恢复区，或补充真实内容后再处理。`
    : item.state === "failed"
    ? failedByModelVersion
      ? "当前选择的 Codex 模型无法运行，请在设置中更换模型或升级 Codex CLI 后重试。"
      : `文件“${item.filename}”未能完成处理，请打开 Inbox 查看原因并重试。`
    : item.state === "waiting-for-user" ? "Needs a routing decision." : item.state === "waiting-for-ai" ? "Waiting for module/Codex processing." : `Inbox state: ${item.state}`;
  const actions = item.state === "failed"
    ? ["open", "retry"]
    : item.state === "waiting-for-user"
      ? ["open", "run", "defer", "dismiss"]
      : ["waiting-for-ai", "processing"].includes(item.state)
        ? ["open"]
        : ["open", "run", "defer"];
  return {
    item_id: `DSH-${item.item_id}`, source_module: item.suggested_module_id ?? "core", instance_id: item.suggested_instance_id,
    category: ["failed", "empty"].includes(item.state) ? "system" : ["waiting-for-ai", "processing"].includes(item.state) ? "research" : "action", priority: item.state === "failed" ? "high" : "medium",
    title, description,
    target: item.path, due_at: item.review_after, created_at: item.created_at, blocks_count: 0, active_context: true,
    actions,
  };
}
