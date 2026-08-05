import path from "node:path";
import { parseMarkdown } from "../core/bridge.js";
import { PkbError } from "../core/errors.js";
import { fromVaultPath } from "../core/files.js";
import type { JsonObject, Operation, OperationPlan } from "../core/types.js";

export interface LinkReconciliationInput {
  vaultRoot: string;
  planId: string;
  taskId: string;
  moduleId: string;
  instanceId: string | null;
  instanceRoot: string;
  target: string;
  links: string[];
  field?: string;
}

function normalizedPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.split("/").includes("..") || /^[A-Za-z]:/.test(normalized)) throw new PkbError("LINK_TARGET_INVALID", "Link targets must be Vault-relative paths.");
  return normalized;
}

function within(target: string, root: string): boolean { return target === root || target.startsWith(`${root}/`); }

function wikilink(value: string): string {
  const trimmed = value.trim().replace(/^\[\[/, "").replace(/\]\]$/, "");
  if (!trimmed || /[\r\n]/.test(trimmed)) throw new PkbError("LINK_VALUE_INVALID", "Links must be a single non-empty line.");
  return `[[${trimmed}]]`;
}

/** Produces an additive, deterministic Frontmatter update; it never edits body text. */
export async function prepareLinkReconciliation(input: LinkReconciliationInput): Promise<{ plan: OperationPlan; added: string[]; unchanged: boolean }> {
  const target = normalizedPath(input.target); const root = normalizedPath(input.instanceRoot);
  if (!within(target, root)) throw new PkbError("LINK_TARGET_OUTSIDE_INSTANCE", "Link reconciliation may only change a document owned by its instance.");
  const field = (input.field ?? "related_links").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) throw new PkbError("LINK_FIELD_INVALID", "The managed link field must be a Frontmatter key.");
  const document = parseMarkdown(input.vaultRoot, fromVaultPath(input.vaultRoot, target));
  const existing = Array.isArray(document.data[field]) ? document.data[field].filter((value): value is string => typeof value === "string") : [];
  const desired = [...new Set(input.links.map(wikilink))].sort((a, b) => a.localeCompare(b));
  const merged = [...new Set([...existing, ...desired])].sort((a, b) => a.localeCompare(b));
  const added = merged.filter((link) => !existing.includes(link));
  const operations: Operation[] = added.length ? [{
    operation_id: "OP-001", type: "update-frontmatter", target, risk: "green", confidence: 1,
    idempotency_key: `links:${target}:${field}:${added.join("|")}`,
    payload: { patch: { [field]: merged }, replace_top_level: [field], actor: "system" }, requires_review_id: null,
  }] : [];
  return {
    plan: { plan_id: input.planId, task_id: input.taskId, source_module: input.moduleId, instance_id: input.instanceId, summary: `Reconcile links for ${path.basename(target)}`, operations, review_items: [] },
    added, unchanged: operations.length === 0,
  };
}
