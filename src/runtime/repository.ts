import { spawnSync } from "node:child_process";
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
import { incrementPerformanceDiagnostic } from "../core/performanceDiagnostics.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const initializedDatabases = new Set<string>();

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
    if (!initializedDatabases.has(databasePath) || !(await exists(databasePath))) {
      repository.call("init");
      initializedDatabases.add(databasePath);
    }
    return repository;
  }

  static restore(databasePath: string, backupPath: string): void {
    const repository = new RuntimeRepository(databasePath);
    repository.call("restore", { backup_path: path.resolve(backupPath) });
    repository.close();
  }

  private call<T extends JsonValue>(command: string, payload: JsonObject = {}): T {
    if (this.closed) throw new PkbError("RUNTIME_DB_CLOSED", "Runtime repository is closed.");
    const bridge = path.join(ENGINE_ROOT, "tools", "runtime_bridge.py");
    incrementPerformanceDiagnostic("python_subprocesses");
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
  runtimeStats(): JsonObject { return this.call<JsonObject>("runtime-stats"); }
  systemCenterData(since: string): JsonObject { return this.call<JsonObject>("system-center-data", { since }); }
  todayData(): JsonObject { return this.call<JsonObject>("today-data"); }
  registerJob(job: JobDefinition): void { this.call("register-job", job); }
  listJobs(): JobDefinition[] { return this.call<JobDefinition[]>("list-jobs"); }
  createTask(input: CreateTaskInput): { task: RuntimeTask; deduplicated: boolean } {
    const forbidden = new Set(["content", "body", "document_text", "email_body", "api_token", "api_key", "authorization"]);
    const inspect = (value: unknown, trail = "payload"): void => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (forbidden.has(key.toLowerCase())) throw new PkbError("TASK_PAYLOAD_SENSITIVE", `Task payload must reference source data instead of storing ${trail}.${key}.`);
        inspect(child, `${trail}.${key}`);
      }
    };
    inspect(input.payload ?? {});
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
  finishRun(runId: string, result: {
    runStatus: "completed" | "failed" | "cancelled" | "interrupted";
    taskStatus: TaskStatus;
    error?: RuntimeError | null;
    operationPlanId?: string | null;
    gitSnapshotId?: string | null;
    inputFiles?: string[];
    outputFiles?: string[];
    metrics?: JsonObject;
    completionReason?: string | null;
    nextRetryAt?: string | null;
  }): { run: TaskRun; task: RuntimeTask } {
    return this.call("finish-run", {
      run_id: runId, run_status: result.runStatus, task_status: result.taskStatus, error: result.error ?? null,
      operation_plan_id: result.operationPlanId ?? null, git_snapshot_id: result.gitSnapshotId ?? null,
      input_files: result.inputFiles ?? [], output_files: result.outputFiles ?? [], metrics: result.metrics ?? {},
      completion_reason: result.completionReason ?? null, next_retry_at: result.nextRetryAt ?? null,
    }) as unknown as { run: TaskRun; task: RuntimeTask };
  }
  heartbeatRun(runId: string): string { return String((this.call("heartbeat-run", { run_id: runId }) as JsonObject).heartbeat_at); }
  getRuns(taskId: string): TaskRun[] { return this.call("get-runs", { task_id: taskId }); }
  setResourceStatus(status: ResourceStatus): void { this.call("set-resource-status", status); }
  getResourceStatuses(): ResourceStatus[] { return this.call("get-resource-statuses"); }
  wakeResourceTasks(resource: ResourceStatus["resource"]): number {
    return Number((this.call("wake-resource-tasks", { resource }) as JsonObject).woken);
  }
  setCheckpoint(checkpoint: SchedulerCheckpoint): void { this.call("set-checkpoint", checkpoint); }
  getCheckpoints(): SchedulerCheckpoint[] { return this.call("get-checkpoints"); }
  reconcile(now: string, heartbeatCutoff: string): JsonObject { return this.call("reconcile", { now, heartbeat_cutoff: heartbeatCutoff }); }
  retryTask(taskId: string): RuntimeTask { return this.call("retry-task", { task_id: taskId }); }
  refreshWaitingTask(taskId: string, resources: RuntimeTask["resources"], payload: JsonObject): RuntimeTask {
    return this.call("refresh-waiting-task", { task_id: taskId, resources, payload });
  }
  cancelTask(taskId: string): RuntimeTask { return this.call("cancel-task", { task_id: taskId }); }
  setTaskPriority(taskId: string, priority: RuntimeTask["priority"]): RuntimeTask { return this.call("set-priority", { task_id: taskId, priority }); }
  recordEvent(event: JsonObject): { created: boolean; event: JsonObject } { return this.call("record-event", event) as unknown as { created: boolean; event: JsonObject }; }
  completeEvent(eventId: string, taskIds: string[], status: "published" | "partial" | "dead-letter" = "published", error: JsonObject | null = null): void { this.call("complete-event", { event_id: eventId, tasks_created: taskIds, status, ...(error ? { error } : {}) }); }
  failEvent(eventId: string, error: JsonObject): void { this.call("fail-event", { event_id: eventId, error }); }
  listEvents(limit = 100): JsonObject[] { return this.call("list-events", { limit }); }
  getEvent(eventId: string): JsonObject | null { return this.call("get-event", { event_id: eventId }); }
  recordEventDelivery(eventId: string, subscriptionKey: string, jobId: string): JsonObject { return this.call("record-event-delivery", { event_id: eventId, subscription_key: subscriptionKey, job_id: jobId }); }
  finishEventDelivery(eventId: string, subscriptionKey: string, status: "created" | "deduplicated" | "failed" | "requeued", taskId: string | null, error: JsonObject | null = null): JsonObject { return this.call("finish-event-delivery", { event_id: eventId, subscription_key: subscriptionKey, status, task_id: taskId, ...(error ? { error } : {}) }); }
  listEventDeliveries(eventId: string): JsonObject[] { return this.call("list-event-deliveries", { event_id: eventId }); }
  startCodexInvocation(invocation: JsonObject): void { this.call("start-codex-invocation", invocation); }
  finishCodexInvocation(invocation: JsonObject): void { this.call("finish-codex-invocation", invocation); }
  listCodexInvocations(taskId: string): JsonObject[] { return this.call("list-codex-invocations", { task_id: taskId }); }
  upsertEvidence(record: JsonObject): JsonObject { return this.call("upsert-evidence", record); }
  getEvidence(evidenceId: string): JsonObject | null { return this.call("get-evidence", { evidence_id: evidenceId }); }
  listEvidence(limit = 100): JsonObject[] { return this.call("list-evidence", { limit }); }
  upsertQualityIssue(issue: JsonObject): JsonObject { return this.call("upsert-quality-issue", issue); }
  listQualityIssues(filters: JsonObject = {}): JsonObject[] { return this.call("list-quality-issues", filters); }
  updateQualityIssue(patch: JsonObject): JsonObject { return this.call("update-quality-issue", patch); }
  recordMetricEvent(event: JsonObject): JsonObject { return this.call("record-metric-event", event); }
  aggregateMetrics(since: string): JsonObject { return this.call("aggregate-metrics", { since }); }
  recordChange(record: JsonObject): JsonObject { return this.call("record-change", record); }
  listChanges(filters: JsonObject = {}): JsonObject[] { return this.call("list-changes", filters); }
  startQualityAudit(frequency: string): JsonObject { return this.call("start-audit", { frequency }); }
  finishQualityAudit(auditId: string, status: string, summary: JsonObject): JsonObject { return this.call("finish-audit", { audit_id: auditId, status, summary }); }
  listQualityAudits(limit = 50): JsonObject[] { return this.call("list-audits", { limit }); }
  rememberReviewRejection(memory: JsonObject): JsonObject { return this.call("remember-rejection", memory); }
  getReviewRejection(fingerprint: string): JsonObject | null { return this.call("get-rejection-memory", { fingerprint }); }
  cleanupHistory(retainDays = 90): JsonObject { return this.call("cleanup-history", { retain_days: retainDays }); }
  async backup(destination: string): Promise<void> {
    await ensureDir(path.dirname(destination));
    this.call("backup", { destination });
  }
}

export async function restoreRuntimeDatabase(vaultRoot: string, backupPath: string): Promise<void> {
  if (!(await exists(backupPath))) throw new PkbError("RUNTIME_BACKUP_NOT_FOUND", `Runtime backup does not exist: ${backupPath}`);
  const target = runtimePath(vaultRoot);
  await ensureDir(path.dirname(target));
  RuntimeRepository.restore(target, backupPath);
  initializedDatabases.delete(target);
}
