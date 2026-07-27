import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PkbError } from "../core/errors.js";
import { ensureDir, exists } from "../core/files.js";
import type { JsonObject, JsonValue } from "../core/types.js";
import type {
  CreateTaskInput,
  JobDefinition,
  ResourceStatus,
  RuntimeError,
  RuntimeTask,
  SchedulerCheckpoint,
  TaskRun,
  TaskStatus,
} from "./domain.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function runtimePath(vaultRoot: string): string {
  return path.join(vaultRoot, "90-System", "State", "runtime.db");
}

interface BridgeEnvelope {
  ok: boolean;
  data?: JsonValue;
  code?: string;
  message?: string;
  details?: JsonValue;
}

export class RuntimeRepository {
  readonly databasePath: string;
  private closed = false;

  private constructor(databasePath: string) { this.databasePath = databasePath; }

  static async open(vaultRoot: string): Promise<RuntimeRepository> {
    const databasePath = runtimePath(vaultRoot);
    await ensureDir(path.dirname(databasePath));
    const repository = new RuntimeRepository(databasePath);
    repository.call("init");
    return repository;
  }

  private call<T extends JsonValue>(command: string, payload: JsonObject = {}): T {
    if (this.closed) throw new PkbError("RUNTIME_DB_CLOSED", "Runtime repository is closed.");
    const bridge = path.join(ENGINE_ROOT, "tools", "runtime_bridge.py");
    const result = spawnSync("python", ["-X", "utf8", bridge, command, this.databasePath], {
      encoding: "utf8", input: JSON.stringify(payload), windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    });
    let envelope: BridgeEnvelope | null = null;
    try { envelope = JSON.parse(result.stdout || result.stderr) as BridgeEnvelope; } catch { envelope = null; }
    if (result.error) throw new PkbError("RUNTIME_DB_UNAVAILABLE", result.error.message, result.error);
    if (result.status !== 0 || !envelope?.ok) {
      throw new PkbError(envelope?.code ?? "RUNTIME_DB_FAILED", envelope?.message ?? (result.stderr.trim() || `Runtime bridge exited with status ${result.status}.`), envelope?.details);
    }
    return envelope.data as T;
  }

  close(): void { this.closed = true; }
  integrityCheck(): string { return this.call<string>("integrity-check"); }
  schemaVersion(): number { return this.call<number>("schema-version"); }
  registerJob(job: JobDefinition): void { this.call("register-job", job); }
  listJobs(): JobDefinition[] { return this.call<JobDefinition[]>("list-jobs"); }
  createTask(input: CreateTaskInput): { task: RuntimeTask; deduplicated: boolean } {
    return this.call("create-task", input as unknown as JsonObject) as unknown as { task: RuntimeTask; deduplicated: boolean };
  }
  getTask(taskId: string): RuntimeTask | null { return this.call("get-task", { task_id: taskId }) as RuntimeTask | null; }
  listTasks(statuses?: TaskStatus[]): RuntimeTask[] { return this.call("list-tasks", { statuses: statuses ?? [] }); }
  transitionTask(taskId: string, to: TaskStatus, patch: { error?: RuntimeError | null; deferUntil?: string | null; nextRetryAt?: string | null; completionReason?: string | null } = {}): RuntimeTask {
    return this.call("transition-task", {
      task_id: taskId, to, error: patch.error ?? null, error_supplied: patch.error !== undefined,
      defer_until: patch.deferUntil ?? null, defer_until_supplied: patch.deferUntil !== undefined,
      next_retry_at: patch.nextRetryAt ?? null, next_retry_at_supplied: patch.nextRetryAt !== undefined,
      completion_reason: patch.completionReason ?? null, completion_reason_supplied: patch.completionReason !== undefined,
    });
  }
  startRun(taskId: string, workerId: string, resourcesChecked: JsonObject): TaskRun {
    return this.call("start-run", { task_id: taskId, worker_id: workerId, resources_checked: resourcesChecked });
  }
  getRuns(taskId: string): TaskRun[] { return this.call("get-runs", { task_id: taskId }); }
  setResourceStatus(status: ResourceStatus): void { this.call("set-resource-status", status); }
  getResourceStatuses(): ResourceStatus[] { return this.call("get-resource-statuses"); }
  setCheckpoint(checkpoint: SchedulerCheckpoint): void { this.call("set-checkpoint", checkpoint); }
  async backup(destination: string): Promise<void> {
    await ensureDir(path.dirname(destination));
    this.call("checkpoint");
    const temporary = `${destination}.tmp-${process.pid}`;
    await fs.copyFile(this.databasePath, temporary);
    await fs.rename(temporary, destination);
  }
}

export async function restoreRuntimeDatabase(vaultRoot: string, backupPath: string): Promise<void> {
  if (!(await exists(backupPath))) throw new PkbError("RUNTIME_BACKUP_NOT_FOUND", `Runtime backup does not exist: ${backupPath}`);
  const target = runtimePath(vaultRoot);
  await ensureDir(path.dirname(target));
  const damaged = `${target}.damaged-${Date.now()}`;
  if (await exists(target)) await fs.rename(target, damaged);
  try { await fs.copyFile(backupPath, target); }
  catch (error) {
    if (await exists(damaged)) await fs.rename(damaged, target);
    throw error;
  }
}
