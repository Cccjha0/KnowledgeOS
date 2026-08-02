import path from "node:path";
import { parseMarkdown } from "../core/bridge.js";
import { exists, fromVaultPath, listFilesRecursive, readJson, sha256File, toVaultPath } from "../core/files.js";
import type { JsonObject, JsonValue, OperationPlan, RunLog } from "../core/types.js";
import { QualityRepository } from "../quality/repository.js";
import { RuntimeRepository } from "../runtime/repository.js";

interface TransactionSnapshot extends JsonObject {
  vault_path: string;
  existed: boolean;
  backup_path: string | null;
  after_existed: boolean | null;
  after_sha256: string | null;
}

interface TransactionOperation extends JsonObject {
  operation_id: string;
  idempotency_key: string;
  status: string;
  error: string | null;
}

interface TransactionRecord extends JsonObject {
  transaction_id: string;
  plan_id: string;
  status: string;
  git_snapshot: string | null;
  created_at: string;
  updated_at: string;
  error: string | null;
  snapshots: TransactionSnapshot[];
  operations: TransactionOperation[];
}

export type RollbackLevel = "safe" | "confirmation-required" | "unavailable";

export interface RollbackAssessment extends JsonObject {
  level: RollbackLevel;
  can_rollback: boolean;
  requires_confirmation: boolean;
  reasons: string[];
  changed_paths: string[];
  later_dependent_runs: string[];
}

interface LocatedRun {
  log: RunLog;
  path: string;
  content: string;
}

function normalizeRun(data: JsonObject): RunLog {
  const legacyModule = typeof data.module === "string" ? data.module : null;
  const legacyInstance = typeof data.instance === "string" ? data.instance : null;
  return {
    run_id: String(data.run_id),
    task_id: typeof data.task_id === "string" ? data.task_id : null,
    plan_id: typeof data.plan_id === "string" ? data.plan_id : null,
    source_module: typeof data.source_module === "string" ? data.source_module : legacyModule ?? "core",
    instance_id: typeof data.instance_id === "string" ? data.instance_id : legacyInstance,
    review_id: typeof data.review_id === "string" ? data.review_id : null,
    status: data.status === "failed" ? "failed" : "completed",
    git_snapshot: typeof data.git_snapshot === "string" ? data.git_snapshot : null,
    started_at: typeof data.started_at === "string" ? data.started_at : new Date(0).toISOString(),
    completed_at: typeof data.completed_at === "string" ? data.completed_at : new Date(0).toISOString(),
    schema_version: 1,
  };
}

function transactionLogPath(vaultRoot: string, planId: string): string {
  return path.join(vaultRoot, "90-System", "Logs", "Transactions", `${planId}.json`);
}

async function loadTransaction(vaultRoot: string, planId: string | null): Promise<TransactionRecord | null> {
  return planId ? readJson<TransactionRecord | null>(transactionLogPath(vaultRoot, planId), null) : null;
}

async function loadPlan(vaultRoot: string, planId: string | null): Promise<OperationPlan | null> {
  return planId
    ? readJson<OperationPlan | null>(path.join(vaultRoot, "90-System", "State", "Plans", `${planId}.json`), null)
    : null;
}

export async function findRun(vaultRoot: string, runId: string): Promise<LocatedRun | null> {
  const file = path.join(vaultRoot, "90-System", "Logs", `${runId}.md`);
  if (!(await exists(file))) return null;
  const document = parseMarkdown(vaultRoot, file);
  return { log: normalizeRun(document.data), path: toVaultPath(vaultRoot, file), content: document.content };
}

async function allRuns(vaultRoot: string): Promise<LocatedRun[]> {
  const result: LocatedRun[] = [];
  for (const file of await listFilesRecursive(path.join(vaultRoot, "90-System", "Logs"), ".md")) {
    const document = parseMarkdown(vaultRoot, file);
    if (typeof document.data.run_id !== "string") continue;
    result.push({ log: normalizeRun(document.data), path: toVaultPath(vaultRoot, file), content: document.content });
  }
  return result;
}

async function changedPaths(vaultRoot: string, transaction: TransactionRecord): Promise<string[]> {
  const changed: string[] = [];
  for (const snapshot of transaction.snapshots) {
    if (snapshot.after_existed === null) { changed.push(snapshot.vault_path); continue; }
    const absolute = fromVaultPath(vaultRoot, snapshot.vault_path);
    const present = await exists(absolute);
    const hash = present ? await sha256File(absolute) : null;
    if (present !== snapshot.after_existed || hash !== snapshot.after_sha256) changed.push(snapshot.vault_path);
  }
  return changed;
}

export async function assessRunRollback(vaultRoot: string, run: RunLog): Promise<RollbackAssessment> {
  const unavailable = (reason: string, changed: string[] = []): RollbackAssessment => ({
    level: "unavailable", can_rollback: false, requires_confirmation: false,
    reasons: [reason], changed_paths: changed, later_dependent_runs: [],
  });
  if (run.status !== "completed") return unavailable("Only completed runs can be rolled back.");
  if (!run.plan_id) return unavailable("This run has no Operation Plan transaction.");
  const transaction = await loadTransaction(vaultRoot, run.plan_id);
  if (!transaction) return unavailable("The durable transaction record is missing.");
  if (transaction.status === "rolled-back") return unavailable("This run has already been rolled back.");
  if (transaction.status !== "completed") return unavailable(`Transaction status is ${transaction.status}.`);
  const changed = await changedPaths(vaultRoot, transaction);
  if (changed.length > 0) return unavailable("One or more affected files changed after the run.", changed);

  const targets = new Set(transaction.snapshots.map((snapshot) => snapshot.vault_path));
  const laterDependentRuns: string[] = [];
  for (const candidate of await allRuns(vaultRoot)) {
    if (candidate.log.run_id === run.run_id || candidate.log.status !== "completed" || Date.parse(candidate.log.completed_at) <= Date.parse(run.completed_at)) continue;
    const later = await loadTransaction(vaultRoot, candidate.log.plan_id);
    if (later?.snapshots.some((snapshot) => targets.has(snapshot.vault_path))) laterDependentRuns.push(candidate.log.run_id);
  }
  if (laterDependentRuns.length > 0) {
    return {
      level: "confirmation-required", can_rollback: true, requires_confirmation: true,
      reasons: ["A later completed run references one or more of the same files."],
      changed_paths: [], later_dependent_runs: laterDependentRuns,
    };
  }
  return {
    level: "safe", can_rollback: true, requires_confirmation: false,
    reasons: ["Transaction backups are complete and affected files still match the recorded result."],
    changed_paths: [], later_dependent_runs: [],
  };
}

function firstSummaryLine(content: string): string | null {
  return content.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#") && !line.startsWith("-")) ?? null;
}

async function runSummary(vaultRoot: string, located: LocatedRun, includeRollback = true): Promise<JsonObject> {
  const transaction = await loadTransaction(vaultRoot, located.log.plan_id);
  const plan = await loadPlan(vaultRoot, located.log.plan_id);
  const rollback = includeRollback ? await assessRunRollback(vaultRoot, located.log) : null;
  return {
    run_id: located.log.run_id,
    completed_at: located.log.completed_at,
    started_at: located.log.started_at,
    duration_ms: Math.max(0, Date.parse(located.log.completed_at) - Date.parse(located.log.started_at)),
    source_module: located.log.source_module,
    instance_id: located.log.instance_id,
    status: located.log.status,
    source_action: plan?.summary ?? firstSummaryLine(located.content) ?? located.log.task_id ?? "Core operation",
    modified_file_count: transaction?.snapshots.length ?? 0,
    operation_count: transaction?.operations.length ?? plan?.operations.length ?? 0,
    completed_operation_count: transaction?.operations.filter((operation) => operation.status === "completed").length ?? 0,
    review_count: plan?.review_items.length ?? (located.log.review_id ? 1 : 0),
    vault_path: located.path,
    rollback,
  };
}

export async function listRunViews(vaultRoot: string, params: JsonObject): Promise<JsonValue> {
  const limit = typeof params.limit === "number" ? Math.max(1, Math.min(100, Math.floor(params.limit))) : 20;
  const requestedStatus = typeof params.status === "string" ? params.status : null;
  const includeRollback = params.include_rollback !== false;
  const runs = (await allRuns(vaultRoot))
    .filter((located) => !requestedStatus || located.log.status === requestedStatus)
    .sort((a, b) => Date.parse(b.log.completed_at) - Date.parse(a.log.completed_at))
    .slice(0, limit);
  return await Promise.all(runs.map((run) => runSummary(vaultRoot, run, includeRollback))) as unknown as JsonValue;
}

export async function getRunView(vaultRoot: string, runId: string, developerMode = false): Promise<JsonObject | null> {
  const located = await findRun(vaultRoot, runId);
  if (!located) return null;
  const transaction = await loadTransaction(vaultRoot, located.log.plan_id);
  const plan = await loadPlan(vaultRoot, located.log.plan_id);
  const summary = await runSummary(vaultRoot, located);
  const operations = (plan?.operations ?? []).map((operation, index) => ({
    operation_id: operation.operation_id,
    type: operation.type,
    target: operation.target,
    risk: operation.risk,
    status: transaction?.operations[index]?.status ?? (located.log.status === "completed" ? "completed" : "unknown"),
    error: transaction?.operations[index]?.error ?? null,
  }));
  const runtime = await RuntimeRepository.open(vaultRoot);
  const quality = await QualityRepository.open(vaultRoot);
  let task = null; let runtimeRun = null; let codexInvocations: JsonObject[] = []; let changes: JsonObject[] = [];
  try {
    task = located.log.task_id ? runtime.getTask(located.log.task_id) : null;
    runtimeRun = located.log.task_id ? runtime.getRuns(located.log.task_id).find((entry) => entry.run_id === runId) ?? null : null;
    codexInvocations = located.log.task_id ? runtime.listCodexInvocations(located.log.task_id).filter((entry) => entry.run_id === runId) : [];
    changes = quality.listChanges().filter((entry) => entry.generation?.run_id === runId || entry.review?.review_id === located.log.review_id);
  } finally { runtime.close(); quality.close(); }
  const blockedOperations = operations.filter((operation) => operation.status !== "completed");
  const triggerReason = task?.trigger?.type === "schedule" ? "周期任务到期" : task?.trigger?.type === "event" ? "系统事件触发" : task?.trigger?.type === "startup" ? "启动补偿" : located.log.review_id ? "用户审核恢复" : task?.trigger?.type === "manual" ? "用户手动触发" : "Core 操作触发";
  return {
    ...summary,
    task_id: located.log.task_id,
    plan_id: located.log.plan_id,
    review_id: located.log.review_id,
    git_snapshot: located.log.git_snapshot,
    input_summary: plan?.summary ?? firstSummaryLine(located.content),
    execution_context: { read_level: runtimeRun?.metrics?.read_level ?? null, input_files: runtimeRun?.input_files ?? [], ai_usage: codexInvocations.length ? "recorded" : "none", codex_invocations: codexInvocations.map((entry) => ({ prompt_id: entry.prompt_id ?? null, prompt_version: entry.prompt_version ?? null, adapter: entry.adapter ?? null, model: entry.model ?? "unknown", status: entry.status ?? null })) },
    affected_files: transaction?.snapshots.map((snapshot) => ({
      path: snapshot.vault_path,
      existed_before: snapshot.existed,
      exists_after: snapshot.after_existed,
    })) ?? [],
    operations,
    reviews: plan?.review_items.map((review) => ({ review_id: review.review_id, action: review.action, target: review.target })) ?? [],
    explanation_chain: {
      trigger: { reason: triggerReason, details: task?.trigger ?? {} },
      inputs: runtimeRun?.input_files ?? [],
      decision: { module: located.log.source_module, workflow: task?.workflow ?? null, prompts: codexInvocations.map((entry) => ({ id: entry.prompt_id ?? null, version: entry.prompt_version ?? null })), risks: operations.map((entry) => ({ operation: entry.type, risk: entry.risk })) },
      review: { review_id: located.log.review_id, created: (plan?.review_items.length ?? 0) > 0 },
      execution: { plan_id: located.log.plan_id, git_snapshot: located.log.git_snapshot, operations },
      changes,
      not_changed: blockedOperations.map((entry) => ({ operation_id: entry.operation_id, reason: entry.error ?? entry.status })),
    },
    error_summary: transaction?.error ?? (located.log.status === "failed" ? firstSummaryLine(located.content) : null),
    developer: developerMode ? { log_content: located.content, transaction, plan } : null,
  };
}
