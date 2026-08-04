import path from "node:path";
import { PkbError } from "../core/errors.js";
import { fromVaultPath, readJson, toVaultPath, writeJsonAtomic } from "../core/files.js";
import type { JsonObject } from "../core/types.js";
import { RuntimeRepository } from "../runtime/repository.js";

const STATE_PATH = ["90-System", "State", "obsidian-file-state.json"];
const SNAPSHOT_MAX_AGE_MS = 90_000;

interface ObsidianFileState extends JsonObject {
  schema_version: 1;
  observed_at: string;
  open_markdown_paths: string[];
  source: "obsidian-plugin";
}

function statePath(vaultRoot: string): string {
  return path.join(vaultRoot, ...STATE_PATH);
}

function normalizeVaultPath(vaultRoot: string, value: string): string | null {
  const input = value.trim().replaceAll("\\", "/");
  if (!input || input.startsWith("/") || input.split("/").includes("..")) return null;
  const absolute = fromVaultPath(vaultRoot, input);
  const relative = toVaultPath(vaultRoot, absolute);
  return relative && !relative.startsWith("..") ? relative : null;
}

export async function syncObsidianOpenFiles(vaultRoot: string, paths: unknown): Promise<ObsidianFileState> {
  const open_markdown_paths = [...new Set((Array.isArray(paths) ? paths : [])
    .filter((value): value is string => typeof value === "string")
    .map((value) => normalizeVaultPath(vaultRoot, value))
    .filter((value): value is string => Boolean(value)))].sort();
  const state: ObsidianFileState = { schema_version: 1, observed_at: new Date().toISOString(), open_markdown_paths, source: "obsidian-plugin" };
  await writeJsonAtomic(statePath(vaultRoot), state);
  return state;
}

export async function freshObsidianOpenFiles(vaultRoot: string, now = Date.now()): Promise<Set<string> | null> {
  const state = await readJson<ObsidianFileState | null>(statePath(vaultRoot), null);
  if (!state || state.schema_version !== 1 || state.source !== "obsidian-plugin" || !Number.isFinite(Date.parse(state.observed_at))) return null;
  if (now - Date.parse(state.observed_at) > SNAPSHOT_MAX_AGE_MS) return null;
  return new Set(state.open_markdown_paths.filter((value): value is string => typeof value === "string"));
}

export async function assertMoveSourceNotOpen(vaultRoot: string, sourcePath: string): Promise<void> {
  const source = normalizeVaultPath(vaultRoot, sourcePath);
  if (!source || !(await freshObsidianOpenFiles(vaultRoot))?.has(source)) return;
  throw new PkbError(
    "OBSIDIAN_FILE_OPEN",
    "该文件正在 Obsidian 中打开。请先保存并关闭笔记，KnowledgeOS 才会继续归档。",
    { source_path: source },
  );
}

export async function resumeTasksAfterObsidianFileClose(vaultRoot: string): Promise<number> {
  const open = await freshObsidianOpenFiles(vaultRoot);
  if (!open) return 0;
  const repository = await RuntimeRepository.open(vaultRoot);
  try {
    let resumed = 0;
    for (const task of repository.listTasks(["waiting-for-user"])) {
      if (task.last_error?.code !== "OBSIDIAN_FILE_OPEN") continue;
      const source = typeof task.payload.source_file === "string" ? normalizeVaultPath(vaultRoot, task.payload.source_file) : null;
      if (source && !open.has(source)) {
        repository.retryTask(task.task_id);
        resumed += 1;
      }
    }
    return resumed;
  } finally { repository.close(); }
}
