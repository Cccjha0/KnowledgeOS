import path from "node:path";
import { parseMarkdown } from "../core/bridge.js";
import { PkbError } from "../core/errors.js";
import { exists, fromVaultPath } from "../core/files.js";
import type { JsonObject, Operation, OperationPlan } from "../core/types.js";

export interface IndexEntry { title: string; target: string; description?: string | null; }
export interface IndexMaterializerInput {
  vaultRoot: string;
  planId: string;
  taskId: string;
  moduleId: string;
  instanceId: string | null;
  instanceRoot: string;
  target: string;
  title: string;
  entries: IndexEntry[];
  section?: string;
}

function normalized(value: string, label: string): string {
  const output = value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!output || output.split("/").includes("..") || /^[A-Za-z]:/.test(output)) throw new PkbError("INDEX_PATH_INVALID", `${label} must be Vault-relative.`);
  return output;
}
function within(target: string, root: string): boolean { return target === root || target.startsWith(`${root}/`); }
function line(entry: IndexEntry): string {
  if (!entry.title.trim() || !entry.target.trim()) throw new PkbError("INDEX_ENTRY_INVALID", "Index entries require title and target.");
  return `- [[${entry.target.trim().replace(/^\[\[|\]\]$/g, "")}]]${entry.description?.trim() ? ` - ${entry.description.trim()}` : ""}`;
}
function marker(target: string, entry: IndexEntry): string { return `<!-- knowledgeos:index:${target}:${Buffer.from(`${entry.title}\0${entry.target}\0${entry.description ?? ""}`).toString("base64url")} -->`; }

/** Materializes only a system-managed section, preserving every user-owned section and note body. */
export async function prepareIndexMaterialization(input: IndexMaterializerInput): Promise<{ plan: OperationPlan; created: boolean; entries: number }> {
  const target = normalized(input.target, "Index target"); const root = normalized(input.instanceRoot, "Instance root");
  if (!within(target, root)) throw new PkbError("INDEX_TARGET_OUTSIDE_INSTANCE", "An index may only be materialized inside its instance.");
  const section = input.section ?? "System Index";
  const entries = [...input.entries].sort((a, b) => `${a.target}\0${a.title}`.localeCompare(`${b.target}\0${b.title}`));
  const targetPath = fromVaultPath(input.vaultRoot, target); const targetExists = await exists(targetPath);
  const operations: Operation[] = [];
  if (!targetExists) {
    const content = [`# ${input.title}`, "", `## ${section}`, "", ...entries.flatMap((entry) => [marker(target, entry), line(entry)]), "", "## Notes", ""].join("\n");
    operations.push({ operation_id: "OP-001", type: "create-file", target, risk: "green", confidence: 1, idempotency_key: `index:create:${target}`,
      payload: { document: { data: { type: "knowledgeos-index", source_module: input.moduleId, instance_id: input.instanceId, _ownership: { sections: { [section]: "system-managed", Notes: "user-owned" } } }, content }, actor: "system" }, requires_review_id: null });
  } else {
    const document = parseMarkdown(input.vaultRoot, targetPath);
    for (const [index, entry] of entries.entries()) {
      const entryMarker = marker(target, entry); if (document.content.includes(entryMarker)) continue;
      operations.push({ operation_id: `OP-${String(operations.length + 1).padStart(3, "0")}`, type: "append-section", target, risk: "green", confidence: 1,
        idempotency_key: `index:entry:${target}:${Buffer.from(`${entry.title}\0${entry.target}\0${entry.description ?? ""}`).toString("base64url")}`,
        payload: { section, marker: entryMarker, content: line(entry), actor: "system" }, requires_review_id: null });
    }
  }
  return { plan: { plan_id: input.planId, task_id: input.taskId, source_module: input.moduleId, instance_id: input.instanceId, summary: `Materialize ${path.basename(target)}`, operations, review_items: [] }, created: !targetExists, entries: entries.length };
}
