import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseMarkdownBatch, validateSchemaBatch } from "./bridge.js";
import { listFilesRecursive, toVaultPath } from "./files.js";
import { incrementPerformanceDiagnostic } from "./performanceDiagnostics.js";
import type { JsonObject, ReviewItem } from "./types.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REVIEW_SCHEMA = "https://pkb.local/schemas/core/review-item.schema.json";
const DIRECTORIES = ["Pending", "Deferred", "Closed", "Error"];

export interface ReviewSummaryEntry extends JsonObject {
  review_id: string;
  status: string;
  priority: string;
  source_module: string;
  instance_id: string | null;
  action: string;
  created: string;
  review_after: string | null;
  vault_path: string;
}

function locations(vaultRoot: string): { database: string; state: string; root: string } {
  const cache = path.join(vaultRoot, "90-System", "Cache");
  return {
    database: path.join(cache, "review-summary-index.sqlite"),
    state: path.join(cache, "review-summary-index.state.json"),
    root: path.join(vaultRoot, "90-System", "Review Queue"),
  };
}

async function reviewFiles(vaultRoot: string): Promise<string[]> {
  const { root } = locations(vaultRoot);
  return (await Promise.all(DIRECTORIES.map((directory) => listFilesRecursive(path.join(root, directory), ".md")))).flat().sort();
}

async function revision(vaultRoot: string, files?: string[]): Promise<{ revision: string; files: string[] }> {
  const selected = files ?? await reviewFiles(vaultRoot);
  const hash = createHash("sha256");
  for (const file of selected) {
    const stat = await fs.stat(file);
    hash.update(`${toVaultPath(vaultRoot, file)}\0${stat.size}\0${stat.mtimeMs}\n`);
  }
  return { revision: hash.digest("hex"), files: selected };
}

function callIndex<T>(vaultRoot: string, command: string, payload: unknown): T {
  const { database } = locations(vaultRoot);
  incrementPerformanceDiagnostic("python_subprocesses");
  const result = spawnSync("python", ["-X", "utf8", path.join(ENGINE_ROOT, "tools", "review_summary_index.py"), command, database], {
    encoding: "utf8", input: JSON.stringify(payload), windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr || result.stdout);
  return (JSON.parse(result.stdout) as { data: T }).data;
}

async function rebuild(vaultRoot: string, files: string[], currentRevision: string): Promise<void> {
  const parsed = parseMarkdownBatch(vaultRoot, files);
  const candidates = files.map((file) => ({ file, document: parsed.get(file) })).filter((entry) => Boolean(entry.document));
  const validation = validateSchemaBatch(vaultRoot, candidates.map((entry) => ({ schemaId: REVIEW_SCHEMA, data: entry.document!.data })));
  const entries: ReviewSummaryEntry[] = [];
  for (const [index, candidate] of candidates.entries()) {
    if (!validation[index]?.ok) continue;
    const item = candidate.document!.data as unknown as ReviewItem;
    entries.push({
      review_id: item.review_id, status: item.status, priority: item.priority, source_module: item.source_module,
      instance_id: item.instance_id, action: item.action, created: item.created, review_after: item.review_after,
      vault_path: toVaultPath(vaultRoot, candidate.file),
    });
  }
  callIndex(vaultRoot, "replace", entries);
  await fs.writeFile(locations(vaultRoot).state, `${JSON.stringify({ schema_version: 1, revision: currentRevision })}\n`, "utf8");
}

async function ensureIndex(vaultRoot: string): Promise<void> {
  const { database, state } = locations(vaultRoot);
  const current = await revision(vaultRoot);
  let recorded: string | null = null;
  try { recorded = (JSON.parse(await fs.readFile(state, "utf8")) as { revision?: string }).revision ?? null; } catch { recorded = null; }
  if (!existsSync(database) || recorded !== current.revision) await rebuild(vaultRoot, current.files, current.revision);
}

export async function listReviewSummaryPage(vaultRoot: string, params: JsonObject): Promise<JsonObject> {
  await ensureIndex(vaultRoot);
  const payload = {
    ...params,
    page_size: typeof params.page_size === "number" ? params.page_size : 50,
    cursor: params.cursor && typeof params.cursor === "object" && !Array.isArray(params.cursor) ? params.cursor : null,
  };
  try { return callIndex(vaultRoot, "page", payload); }
  catch {
    const current = await revision(vaultRoot);
    rmSync(locations(vaultRoot).database, { force: true });
    await rebuild(vaultRoot, current.files, current.revision);
    return callIndex(vaultRoot, "page", payload);
  }
}
