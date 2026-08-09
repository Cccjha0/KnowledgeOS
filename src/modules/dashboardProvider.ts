import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMarkdown, parseYaml } from "../core/bridge.js";
import { listFilesRecursive, toVaultPath } from "../core/files.js";
import type { DashboardItem, JsonObject, JsonValue, Priority } from "../core/types.js";
import { discoverInstances, discoverModulesForVault, type DiscoveredDocument } from "../core/discovery.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

type ProviderKind = "entity" | "due" | "recent" | "review-summary";

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
  for (const file of await listFilesRecursive(root, ".md")) {
    const relative = toVaultPath(vaultRoot, file);
    if (/(?:^|\/)Inbox(?:\/|$)/.test(relative)) continue;
    try {
      const document = parseMarkdown(vaultRoot, file);
      if (document.data.instance_id !== instance.data.instance_id) continue;
      documents.push({ path: file, data: document.data });
    } catch {
      // A normal note without valid frontmatter is not a module entity.
    }
  }
  return documents.filter((document) => typeof document.data.type === "string" || typeof document.data.schema_id === "string");
}

function providerItems(provider: JsonObject): ProviderItem[] {
  return Array.isArray(provider.items)
    ? provider.items.map((entry) => object(entry)).filter((entry): entry is JsonObject => Boolean(entry))
      .filter((entry) => typeof entry.id === "string" && ["entity", "due", "recent", "review-summary"].includes(String(entry.kind)))
      .map((entry) => entry as unknown as ProviderItem)
    : [];
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
  vaultRoot: string,
  moduleId: string,
  instanceId: string,
  definition: ProviderItem,
): Promise<DashboardItem | null> {
  let count = 0;
  for (const file of await listFilesRecursive(path.join(vaultRoot, "90-System", "Review Queue", "Pending"), ".md")) {
    const review = parseMarkdown(vaultRoot, file).data;
    if (review.source_module === moduleId && review.instance_id === instanceId && review.status === "pending") count += 1;
  }
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
export async function collectModuleDashboardItems(vaultRoot: string, now = Date.now()): Promise<DashboardItem[]> {
  const modules = (await discoverModulesForVault(ENGINE_ROOT, vaultRoot)).filter((module) => module.data.status === "enabled");
  const instances = (await discoverInstances(vaultRoot)).filter((instance) => instance.data.status === "active");
  const result: DashboardItem[] = [];
  for (const module of modules) {
    const moduleId = String(module.data.id);
    const dashboard = object(module.data.dashboard);
    if (!dashboard || typeof dashboard.provider !== "string") continue;
    let provider: JsonObject;
    try {
      provider = parseYaml(vaultRoot, path.join(path.dirname(module.path), ...dashboard.provider.split("/")));
    } catch {
      continue;
    }
    const definitions = providerItems(provider);
    if (!definitions.length) continue;
    for (const instance of instances.filter((candidate) => candidate.data.module_id === moduleId)) {
      const documents = await documentsForInstance(vaultRoot, instance);
      for (const definition of definitions) {
        if (definition.kind === "review-summary") {
          const summary = await reviewSummary(vaultRoot, moduleId, String(instance.data.instance_id), definition);
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
