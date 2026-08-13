import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMarkdownBatch } from "./bridge.js";
import { listFilesRecursive, toVaultPath } from "./files.js";
import { incrementPerformanceDiagnostic } from "./performanceDiagnostics.js";
import type { JsonObject, RunLog } from "./types.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface RunSummaryIndexEntry extends JsonObject {
  run_id: string;
  completed_at: string;
  started_at: string;
  source_module: string;
  instance_id: string | null;
  status: "completed" | "failed";
  plan_id: string | null;
  review_id: string | null;
  task_id: string | null;
  vault_path: string;
  summary_line: string | null;
}

function locations(vaultRoot: string): { database: string; dirty: string; state: string; logs: string } {
  const root = path.join(vaultRoot, "90-System", "Cache");
  return { database: path.join(root, "run-summary-index.sqlite"), dirty: path.join(root, "run-summary-index.dirty.json"),
    state: path.join(root, "run-summary-index.state.json"), logs: path.join(vaultRoot, "90-System", "Logs") };
}

function writeIndexState(vaultRoot: string): void {
  const { state, logs } = locations(vaultRoot);
  const stat = statSync(logs);
  writeFileSync(state, `${JSON.stringify({ schema_version: 1, logs_mtime_ms: stat.mtimeMs, logs_ctime_ms: stat.ctimeMs })}\n`, "utf8");
}

function indexStateIsCurrent(vaultRoot: string): boolean {
  const { state, logs } = locations(vaultRoot);
  if (!existsSync(state)) return false;
  try {
    const recorded = JSON.parse(readFileSync(state, "utf8")) as { logs_mtime_ms?: number; logs_ctime_ms?: number };
    const stat = statSync(logs);
    return recorded.logs_mtime_ms === stat.mtimeMs && recorded.logs_ctime_ms === stat.ctimeMs;
  } catch { return false; }
}

function firstSummaryLine(content: string): string | null {
  return content.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#") && !line.startsWith("-")) ?? null;
}

function normalize(data: JsonObject, vaultPath: string, content: string): RunSummaryIndexEntry | null {
  if (typeof data.run_id !== "string" || typeof data.completed_at !== "string") return null;
  return {
    run_id: data.run_id, completed_at: data.completed_at,
    started_at: typeof data.started_at === "string" ? data.started_at : new Date(0).toISOString(),
    source_module: typeof data.source_module === "string" ? data.source_module : typeof data.module === "string" ? data.module : "core",
    instance_id: typeof data.instance_id === "string" ? data.instance_id : typeof data.instance === "string" ? data.instance : null,
    status: data.status === "failed" ? "failed" : "completed", plan_id: typeof data.plan_id === "string" ? data.plan_id : null,
    review_id: typeof data.review_id === "string" ? data.review_id : null, task_id: typeof data.task_id === "string" ? data.task_id : null,
    vault_path: vaultPath, summary_line: firstSummaryLine(content),
  };
}

function callIndex<T>(vaultRoot: string, command: string, payload: unknown): T {
  const { database } = locations(vaultRoot);
  const script = path.join(ENGINE_ROOT, "tools", "run_summary_index.py");
  incrementPerformanceDiagnostic("python_subprocesses");
  const result = spawnSync("python", ["-X", "utf8", script, command, database], {
    encoding: "utf8", input: JSON.stringify(payload), windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr || result.stdout);
  const envelope = JSON.parse(result.stdout) as { ok: boolean; data: T };
  if (!envelope.ok) throw new Error("Run summary index command failed.");
  return envelope.data;
}

export function updateRunSummaryIndex(vaultRoot: string, log: RunLog, content: string, filePath: string): void {
  const { dirty } = locations(vaultRoot);
  const entry = normalize(log as unknown as JsonObject, toVaultPath(vaultRoot, filePath), content);
  if (!entry) return;
  try {
    callIndex(vaultRoot, "upsert", entry);
    if (existsSync(dirty)) rmSync(dirty, { force: true });
    writeIndexState(vaultRoot);
  } catch (error) {
    writeFileSync(dirty, `${JSON.stringify({ schema_version: 1, reason: "index-update-failed", occurred_at: new Date().toISOString(), error_type: error instanceof Error ? error.name : "unknown" }, null, 2)}\n`, "utf8");
  }
}

async function rebuild(vaultRoot: string): Promise<void> {
  const logRoot = path.join(vaultRoot, "90-System", "Logs");
  const files = await listFilesRecursive(logRoot, ".md");
  const parsed = parseMarkdownBatch(vaultRoot, files);
  const entries: RunSummaryIndexEntry[] = [];
  for (const file of files) {
    const document = parsed.get(file);
    if (!document) continue;
    const entry = normalize(document.data, toVaultPath(vaultRoot, file), document.content);
    if (entry) entries.push(entry);
  }
  callIndex(vaultRoot, "replace", entries);
  const { dirty } = locations(vaultRoot);
  if (existsSync(dirty)) rmSync(dirty, { force: true });
  writeIndexState(vaultRoot);
}

export async function listRecentRunSummaries(
  vaultRoot: string,
  options: { limit?: number; status?: string | null } = {},
): Promise<RunSummaryIndexEntry[]> {
  const { database, dirty } = locations(vaultRoot);
  if (!existsSync(database) || existsSync(dirty) || !indexStateIsCurrent(vaultRoot)) await rebuild(vaultRoot);
  try {
    const entries = callIndex<RunSummaryIndexEntry[]>(vaultRoot, "list", { limit: options.limit ?? 20, status: options.status ?? null });
    if (entries.some((entry) => !existsSync(path.join(vaultRoot, ...entry.vault_path.split("/"))))) {
      await rebuild(vaultRoot);
      return callIndex(vaultRoot, "list", { limit: options.limit ?? 20, status: options.status ?? null });
    }
    return entries;
  } catch {
    await rebuild(vaultRoot);
    return callIndex(vaultRoot, "list", { limit: options.limit ?? 20, status: options.status ?? null });
  }
}

export async function listRecentRunSummaryPage(
  vaultRoot: string,
  options: { pageSize?: number; status?: string | null; cursor?: JsonObject | null } = {},
): Promise<{ items: RunSummaryIndexEntry[]; has_more: boolean; next_cursor: JsonObject | null }> {
  const { database, dirty } = locations(vaultRoot);
  if (!existsSync(database) || existsSync(dirty) || !indexStateIsCurrent(vaultRoot)) await rebuild(vaultRoot);
  const payload = { page_size: options.pageSize ?? 20, status: options.status ?? null, cursor: options.cursor ?? null };
  const read = () => callIndex<{ items: RunSummaryIndexEntry[]; has_more: boolean; next_cursor: JsonObject | null }>(vaultRoot, "page", payload);
  try {
    const page = read();
    if (page.items.some((entry) => !existsSync(path.join(vaultRoot, ...entry.vault_path.split("/"))))) {
      await rebuild(vaultRoot);
      return read();
    }
    return page;
  } catch {
    await rebuild(vaultRoot);
    return read();
  }
}
