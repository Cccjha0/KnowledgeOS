import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMarkdownBatch, parseYaml } from "../core/bridge.js";
import { listFilesRecursive, toVaultPath } from "../core/files.js";
import type { DashboardItem, JsonObject, JsonValue, Priority } from "../core/types.js";
import { discoverInstances, discoverModulesForVault, type DiscoveredDocument } from "../core/discovery.js";

type ProviderKind = "entity" | "due" | "recent" | "review-summary";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

interface ProviderItem {
  id: string;
  kind: ProviderKind;
  entity?: string;
  category?: DashboardItem["category"];
  due_category?: DashboardItem["category"];
  priority?: Priority | JsonObject;
  filters?: JsonObject;
  due_field?: string;
  due_state?: "always" | "overdue-only";
  date_field?: string;
  window_days?: number;
  limit?: number;
  title?: string;
  description?: string;
  actions?: string[];
  due_actions?: string[];
  created_at_field?: string;
  suppress_due_when?: JsonObject;
}

interface LocatedDocument {
  path: string;
  data: JsonObject;
}

export interface DashboardDiscoveryContext {
  modules: DiscoveredDocument[];
  instances: DiscoveredDocument[];
}

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function nested(data: JsonObject, dotted: string): JsonValue | undefined {
  let current: JsonValue | undefined = data;
  for (const part of dotted.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as JsonObject)[part];
  }
  return current;
}

function text(value: JsonValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function render(template: string, data: JsonObject, file: string, vaultRoot: string): string {
  return template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (_match, key: string) => {
    if (key === "path") return toVaultPath(vaultRoot, file);
    return text(nested(data, key));
  }).replace(/\s{2,}/g, " ").trim();
}

function matchesFilters(data: JsonObject, filters: JsonObject | undefined): boolean {
  if (!filters) return true;
  return Object.entries(filters).every(([field, expected]) => {
    const actual = nested(data, field);
    if (Array.isArray(expected)) return expected.some((item) => JSON.stringify(item) === JSON.stringify(actual));
    if (object(expected) && typeof object(expected)?.equals !== "undefined") return JSON.stringify(actual) === JSON.stringify(object(expected)?.equals);
    return JSON.stringify(actual) === JSON.stringify(expected);
  });
}

function parseDate(value: JsonValue | undefined): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function priorityFor(item: ProviderItem, dueAt: number | null, now: number): Priority {
  if (typeof item.priority === "string") return item.priority;
  const policy = object(item.priority);
  if (!policy || dueAt === null) return "medium";
  const remainingDays = (dueAt - now) / 86_400_000;
  if (remainingDays < 0 && typeof policy.overdue === "string") return policy.overdue as Priority;
  if (remainingDays <= 3 && typeof policy.within_3_days === "string") return policy.within_3_days as Priority;
  return typeof policy.default === "string" ? policy.default as Priority : "medium";
}

function isEntityDocument(data: JsonObject, moduleId: string, entity: string): boolean {
  return data.schema_id === entity || data.type === `${moduleId}-${entity}` || data.type === entity;
}

async function documentsForInstance(vaultRoot: string, instance: DiscoveredDocument): Promise<LocatedDocument[]> {
  const root = typeof instance.data.content_root === "string" ? path.join(vaultRoot, ...instance.data.content_root.split("/")) : null;
  if (!root) return [];
  const documents: LocatedDocument[] = [];
  const files = (await listFilesRecursive(root, ".md")).filter((file) => !/(?:^|\/)Inbox(?:\/|$)/.test(toVaultPath(vaultRoot, file)));
  const parsed = parseMarkdownBatch(vaultRoot, files);
  for (const file of files) {
    try {
      const document = parsed.get(file);
      if (!document) continue;
      if (document.data.instance_id !== instance.data.instance_id) continue;
      documents.push({ path: file, data: document.data });
    } catch {
      // A normal note without valid frontmatter is not a module entity.
    }
  }
  return documents.filter((document) => typeof document.data.type === "string" || typeof document.data.schema_id === "string");
}

function providerItems(provider: JsonObject): ProviderItem[] {
  return (Array.isArray(provider.items) ? provider.items : []).map((entry) => entry as unknown as ProviderItem);
}

/**
 * Dashboard providers are fully schema-validated when a module is installed or
 * tested. Today is a hot path, so it deliberately uses this small structural
 * gate instead of spawning the Python JSON-Schema bridge once per provider.
 *
 * Keep this gate fail-closed: an old or malformed provider becomes a visible
 * configuration warning rather than silently contributing incorrect items.
 */
function runtimeProviderContractError(provider: JsonObject): string | null {
  if (typeof provider.provider_id !== "string" || !provider.provider_id.trim()) return "Provider requires a non-empty provider_id.";
  if (typeof provider.version !== "string" && typeof provider.version !== "number") return "Provider requires a version.";
  if (!Array.isArray(provider.items) || !provider.items.length) return "Provider declares no Dashboard items.";
  for (const [index, value] of provider.items.entries()) {
    const item = object(value);
    if (!item) return `Provider item ${index + 1} must be an object.`;
    if (typeof item.id !== "string" || !item.id.trim()) return `Provider item ${index + 1} requires a non-empty id.`;
    if (item.kind !== "entity" && item.kind !== "due" && item.kind !== "recent" && item.kind !== "review-summary") {
      return `Provider item ${index + 1} declares an unsupported kind.`;
    }
    if (item.kind !== "review-summary" && (typeof item.entity !== "string" || !item.entity.trim())) {
      return `Provider item ${index + 1} requires an entity.`;
    }
    if (item.kind === "due" && (typeof item.due_field !== "string" || !item.due_field.trim())) {
      return `Provider item ${index + 1} requires a due_field.`;
    }
    if (item.kind === "recent" && (typeof item.date_field !== "string" || !item.date_field.trim())) {
      return `Provider item ${index + 1} requires a date_field.`;
    }
  }
  return null;
}

function providerDiagnostic(moduleId: string, providerPath: string, reason: string): DashboardItem {
  return {
    item_id: `DSH-MODULE-${moduleId}-DASHBOARD-CONFIG`, source_module: moduleId, instance_id: null,
    category: "warning", priority: "high", title: `${moduleId} Dashboard configuration needs attention`,
    description: `${reason} (${providerPath})`, target: null, due_at: null, actions: ["open"], created_at: null,
    blocks_count: 0, active_context: true,
  };
}

function itemFromDocument(
  vaultRoot: string,
  moduleId: string,
  instanceId: string,
  definition: ProviderItem,
  document: LocatedDocument,
  now: number,
  includeDue = true,
): DashboardItem | null {
  const dueValue = definition.due_field ? nested(document.data, definition.due_field) : undefined;
  const dueTimestamp = parseDate(dueValue);
  const windowDays = typeof definition.window_days === "number" ? definition.window_days : null;
  if (definition.kind === "due") {
    if (dueTimestamp === null || dueTimestamp > now + (windowDays ?? 14) * 86_400_000) return null;
  }
  const overdue = dueTimestamp !== null && dueTimestamp <= now;
  const dueState = definition.due_state ?? "always";
  const dueAt = includeDue && definition.due_field && (dueState !== "overdue-only" || overdue) ? text(dueValue) || null : null;
  const category = includeDue && overdue && definition.due_category ? definition.due_category : definition.category ?? (definition.kind === "due" ? "deadline" : "status");
  const actions = includeDue && overdue && strings(definition.due_actions).length ? strings(definition.due_actions) : strings(definition.actions);
  const title = render(definition.title ?? "{title}", document.data, document.path, vaultRoot) || path.basename(document.path, ".md");
  const description = render(definition.description ?? "", document.data, document.path, vaultRoot);
  return {
    item_id: `DSH-MODULE-${moduleId}-${instanceId}-${definition.id}-${document.data.id ?? path.basename(document.path, ".md")}`,
    source_module: moduleId,
    instance_id: instanceId,
    category,
    priority: priorityFor(definition, dueTimestamp, now),
    title,
    description,
    target: toVaultPath(vaultRoot, document.path),
    due_at: dueAt,
    actions: actions.length ? actions : ["open"],
    created_at: text(nested(document.data, definition.created_at_field ?? "created")) || null,
    blocks_count: 0,
    active_context: category === "deadline" || category === "research" || overdue,
  };
}

function hasSuppressingDocument(moduleId: string, definition: ProviderItem, document: LocatedDocument, documents: LocatedDocument[]): boolean {
  const condition = definition.suppress_due_when;
  if (!condition || typeof condition.entity !== "string") return false;
  const localField = typeof condition.local_field === "string" ? condition.local_field : "id";
  const foreignField = typeof condition.foreign_field === "string" ? condition.foreign_field : "id";
  const localValue = nested(document.data, localField);
  const filters = object(condition.filters) ?? undefined;
  return documents.some((candidate) =>
    isEntityDocument(candidate.data, moduleId, String(condition.entity))
    && JSON.stringify(nested(candidate.data, foreignField)) === JSON.stringify(localValue)
    && matchesFilters(candidate.data, filters),
  );
}

async function reviewSummary(
  moduleId: string,
  instanceId: string,
  definition: ProviderItem,
  reviewCounts: ReadonlyMap<string, number>,
): Promise<DashboardItem | null> {
  const count = reviewCounts.get(`${moduleId}\0${instanceId}`) ?? 0;
  if (!count) return null;
  return {
    item_id: `DSH-MODULE-${moduleId}-${instanceId}-${definition.id}`,
    source_module: moduleId, instance_id: instanceId, category: definition.category ?? "status",
    priority: priorityFor(definition, null, Date.now()),
    title: (definition.title ?? "待审核事项").replace("{count}", String(count)),
    description: (definition.description ?? "有 {count} 项等待你的决定。").replace("{count}", String(count)),
    target: null, due_at: null, actions: strings(definition.actions).length ? strings(definition.actions) : ["open"],
    created_at: null, blocks_count: count, active_context: true,
  };
}

/**
 * Materializes module-owned Today items from declarative dashboard providers.
 * Providers are intentionally deterministic: they query only their active
 * instance content roots and normalize each result into a DashboardItem.
 */
export async function collectModuleDashboardItems(
  vaultRoot: string,
  now = Date.now(),
  discovery?: DashboardDiscoveryContext,
): Promise<DashboardItem[]> {
  // Today already discovers these documents for Inbox routing. Reuse that
  // trusted snapshot when supplied so a single view refresh does not repeat
  // expensive module/instance schema discovery.
  const modules = (discovery?.modules ?? await discoverModulesForVault(ENGINE_ROOT, vaultRoot))
    .filter((module) => module.data.status === "enabled");
  const instances = (discovery?.instances ?? await discoverInstances(vaultRoot))
    .filter((instance) => instance.data.status === "active");
  const result: DashboardItem[] = [];
  const pendingReviewFiles = await listFilesRecursive(path.join(vaultRoot, "90-System", "Review Queue", "Pending"), ".md");
  const pendingReviews = parseMarkdownBatch(vaultRoot, pendingReviewFiles);
  const reviewCounts = new Map<string, number>();
  for (const file of pendingReviewFiles) {
    const review = pendingReviews.get(file)?.data;
    if (!review || review.status !== "pending" || typeof review.source_module !== "string" || typeof review.instance_id !== "string") continue;
    const key = `${review.source_module}\0${review.instance_id}`;
    reviewCounts.set(key, (reviewCounts.get(key) ?? 0) + 1);
  }
  for (const module of modules) {
    const moduleId = String(module.data.id);
    const dashboard = object(module.data.dashboard);
    if (!dashboard || typeof dashboard.provider !== "string") continue;
    const providerFile = path.join(path.dirname(module.path), ...dashboard.provider.split("/"));
    let provider: JsonObject;
    try {
      provider = parseYaml(vaultRoot, providerFile);
      const contractError = runtimeProviderContractError(provider);
      if (contractError) throw new Error(contractError);
    } catch (error) {
      result.push(providerDiagnostic(moduleId, toVaultPath(vaultRoot, providerFile), `Provider could not be loaded safely: ${error instanceof Error ? error.message : String(error)}`));
      continue;
    }
    const definitions = providerItems(provider);
    if (!definitions.length) {
      result.push(providerDiagnostic(moduleId, toVaultPath(vaultRoot, providerFile), "Provider declares no Dashboard items."));
      continue;
    }
    for (const instance of instances.filter((candidate) => candidate.data.module_id === moduleId)) {
      const documents = await documentsForInstance(vaultRoot, instance);
      for (const definition of definitions) {
        if (definition.kind === "review-summary") {
          const summary = await reviewSummary(moduleId, String(instance.data.instance_id), definition, reviewCounts);
          if (summary) result.push(summary);
          continue;
        }
        if (!definition.entity) continue;
        const matches = documents.filter((document) => isEntityDocument(document.data, moduleId, definition.entity!) && matchesFilters(document.data, object(definition.filters) ?? undefined));
        const ordered = definition.kind === "recent"
          ? [...matches].sort((left, right) => (parseDate(nested(right.data, definition.date_field ?? "updated")) ?? 0) - (parseDate(nested(left.data, definition.date_field ?? "updated")) ?? 0)).slice(0, typeof definition.limit === "number" ? definition.limit : 5)
          : matches;
        for (const document of ordered) {
          const includeDue = !hasSuppressingDocument(moduleId, definition, document, documents);
          const item = itemFromDocument(vaultRoot, moduleId, String(instance.data.instance_id), definition, document, now, includeDue);
          if (item) result.push(item);
        }
      }
    }
  }
  return result;
}
