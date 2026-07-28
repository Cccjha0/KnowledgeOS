import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { JsonObject, MarkdownDocument, Operation, OperationPlan } from "./types.js";
import { parseMarkdown, parseYaml, validateSchema, writeMarkdown, writeYaml } from "./bridge.js";
import { PkbError } from "./errors.js";
import { assertOwnedMutation } from "./qualityOwnership.js";
import { deepMerge, ensureDir, exists, fromVaultPath, readJson, sha256File, toVaultPath, writeJsonAtomic } from "./files.js";
import { appendToSection } from "./markdown.js";

const PLAN_SCHEMA = "https://pkb.local/schemas/core/operation-plan.schema.json";
const SUPPORTED_TYPES = new Set(["create-file", "update-file", "update-frontmatter", "append-section", "move-file", "migrate-frontmatter", "update-instance"]);

export type TransactionStatus = "not-started" | "in-progress" | "completed" | "partially-failed" | "rolled-back" | "manual-action-required";
type OperationStatus = "pending" | "in-progress" | "completed" | "skipped" | "failed";

export interface ExecutionPolicy {
  allowedTypes?: readonly string[];
  allowedTargets?: readonly string[];
  requiredReviewId?: string | null;
  gitSnapshot?: string | null;
}

interface DurableSnapshot {
  vault_path: string;
  existed: boolean;
  backup_path: string | null;
  after_existed: boolean | null;
  after_sha256: string | null;
}

interface TransactionRecord {
  transaction_id: string;
  plan_id: string;
  status: TransactionStatus;
  git_snapshot: string | null;
  created_at: string;
  updated_at: string;
  error: string | null;
  snapshots: DurableSnapshot[];
  operations: Array<{ operation_id: string; idempotency_key: string; status: OperationStatus; error: string | null }>;
}

interface IdempotencyLedger {
  completed: Record<string, { plan_id: string; completed_at: string }>;
}

function transactionDirectory(vaultRoot: string, planId: string): string {
  return path.join(vaultRoot, "90-System", "State", "Transactions", planId);
}

function transactionPath(vaultRoot: string, planId: string): string {
  return path.join(transactionDirectory(vaultRoot, planId), "transaction.json");
}

function lockPath(vaultRoot: string): string {
  return path.join(vaultRoot, "90-System", "State", "Locks", "operation-plan.lock.json");
}

function resolveVaultPath(vaultRoot: string, vaultPath: string): string {
  const absolute = fromVaultPath(vaultRoot, vaultPath);
  const relative = path.relative(vaultRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PkbError("PERMISSION_DENIED", "Operation Plan points outside the Vault.", vaultPath);
  }
  return absolute;
}

function checkPermissions(plan: OperationPlan, policy: ExecutionPolicy): void {
  const allowedTypes = new Set(policy.allowedTypes ?? [...SUPPORTED_TYPES]);
  const allowedTargets = policy.allowedTargets ? new Set(policy.allowedTargets) : null;
  for (const operation of plan.operations) {
    if (!SUPPORTED_TYPES.has(operation.type) || !allowedTypes.has(operation.type)) {
      throw new PkbError("OPERATION_NOT_ALLOWED", `Operation type is not allowed: ${operation.type}`, operation);
    }
    if (!operation.target || (allowedTargets && !allowedTargets.has(operation.target))) {
      throw new PkbError("TARGET_NOT_ALLOWED", "Operation target is outside the authorized set.", operation);
    }
    if (policy.requiredReviewId !== undefined && operation.requires_review_id !== policy.requiredReviewId) {
      throw new PkbError("REVIEW_AUTHORIZATION_MISMATCH", "Operation review authorization does not match.", operation);
    }
  }
}

function requireObject(value: unknown, operation: Operation, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PkbError("INVALID_OPERATION", `${label} must be an object.`, operation);
  }
  return value as JsonObject;
}

async function writeTransaction(vaultRoot: string, record: TransactionRecord): Promise<void> {
  record.updated_at = new Date().toISOString();
  await writeJsonAtomic(transactionPath(vaultRoot, record.plan_id), record);
  await writeJsonAtomic(path.join(vaultRoot, "90-System", "Logs", "Transactions", `${record.plan_id}.json`), record);
}

async function snapshotPaths(vaultRoot: string, plan: OperationPlan, record: TransactionRecord): Promise<void> {
  const paths: string[] = [];
  for (const operation of plan.operations) {
    if (operation.target) paths.push(operation.target);
    if (operation.type === "move-file" && typeof operation.payload.destination === "string") paths.push(operation.payload.destination);
  }
  const unique = [...new Set(paths)];
  const backupRoot = path.join(transactionDirectory(vaultRoot, plan.plan_id), "backups");
  await ensureDir(backupRoot);
  for (const [index, vaultPath] of unique.entries()) {
    const absolute = resolveVaultPath(vaultRoot, vaultPath);
    const present = await exists(absolute);
    const backup = present ? path.join(backupRoot, `${String(index).padStart(4, "0")}.bin`) : null;
    if (backup) await fs.copyFile(absolute, backup);
    record.snapshots.push({
      vault_path: vaultPath,
      existed: present,
      backup_path: backup ? toVaultPath(vaultRoot, backup) : null,
      after_existed: null,
      after_sha256: null,
    });
    await writeTransaction(vaultRoot, record);
  }
}

async function recordResultHashes(vaultRoot: string, record: TransactionRecord): Promise<void> {
  for (const snapshot of record.snapshots) {
    const target = resolveVaultPath(vaultRoot, snapshot.vault_path);
    snapshot.after_existed = await exists(target);
    snapshot.after_sha256 = snapshot.after_existed ? await sha256File(target) : null;
  }
  await writeTransaction(vaultRoot, record);
}

async function restoreTransaction(vaultRoot: string, record: TransactionRecord): Promise<void> {
  const errors: string[] = [];
  if (record.status === "completed") {
    for (const snapshot of record.snapshots) {
      if (snapshot.after_existed === null || snapshot.after_existed === undefined) continue;
      const target = resolveVaultPath(vaultRoot, snapshot.vault_path);
      const present = await exists(target);
      const hash = present ? await sha256File(target) : null;
      if (present !== snapshot.after_existed || hash !== snapshot.after_sha256) {
        errors.push(`${snapshot.vault_path}: changed after transaction completion`);
      }
    }
    if (errors.length > 0) {
      record.status = "manual-action-required";
      record.error = errors.join("; ");
      await writeTransaction(vaultRoot, record);
      throw new PkbError("ROLLBACK_CONFLICT", "Rollback would overwrite newer changes.", errors);
    }
  }
  for (const snapshot of [...record.snapshots].reverse()) {
    const target = resolveVaultPath(vaultRoot, snapshot.vault_path);
    try {
      if (snapshot.existed && snapshot.backup_path) {
        await ensureDir(path.dirname(target));
        await fs.copyFile(resolveVaultPath(vaultRoot, snapshot.backup_path), target);
      } else if (await exists(target)) {
        await fs.unlink(target);
      }
    } catch (error) {
      errors.push(`${snapshot.vault_path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  record.status = errors.length === 0 ? "rolled-back" : "manual-action-required";
  record.error = errors.length === 0 ? record.error : errors.join("; ");
  await writeTransaction(vaultRoot, record);
  if (errors.length > 0) throw new PkbError("ROLLBACK_INCOMPLETE", "Rollback requires manual intervention.", errors);
}

async function removeIdempotencyEntries(vaultRoot: string, record: TransactionRecord): Promise<void> {
  const ledgerPath = path.join(vaultRoot, "90-System", "State", "idempotency.json");
  const ledger = await readJson<IdempotencyLedger>(ledgerPath, { completed: {} });
  for (const operation of record.operations) {
    if (ledger.completed[operation.idempotency_key]?.plan_id === record.plan_id) delete ledger.completed[operation.idempotency_key];
  }
  await writeJsonAtomic(ledgerPath, ledger);
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function acquireLock(vaultRoot: string, planId: string): Promise<FileHandle> {
  const file = lockPath(vaultRoot);
  await ensureDir(path.dirname(file));
  try {
    const handle = await fs.open(file, "wx");
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, plan_id: planId, acquired_at: new Date().toISOString() })}\n`, "utf8");
    return handle;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const lock = await readJson<{ pid?: number; plan_id?: string }>(file, {});
    if (typeof lock.pid === "number" && processAlive(lock.pid)) {
      throw new PkbError("EXECUTION_LOCKED", `Another Operation Plan is running in process ${lock.pid}.`, lock);
    }
    await recoverInterruptedTransactions(vaultRoot);
    await fs.unlink(file).catch(() => undefined);
    const handle = await fs.open(file, "wx");
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, plan_id: planId, acquired_at: new Date().toISOString() })}\n`, "utf8");
    return handle;
  }
}

async function releaseLock(vaultRoot: string, handle: FileHandle): Promise<void> {
  await handle.close().catch(() => undefined);
  await fs.unlink(lockPath(vaultRoot)).catch(() => undefined);
}

function setNested(target: JsonObject, dottedPath: string, value: unknown): void {
  const parts = dottedPath.split(".");
  let current: JsonObject = target;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) current[part] = {};
    current = current[part] as JsonObject;
  }
  current[parts.at(-1)!] = structuredClone(value) as JsonObject[string];
}

function deleteNested(target: JsonObject, dottedPath: string): void {
  const parts = dottedPath.split(".");
  let current: JsonObject = target;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) return;
    current = next as JsonObject;
  }
  delete current[parts.at(-1)!];
}

async function executeOperation(vaultRoot: string, operation: Operation): Promise<void> {
  const target = resolveVaultPath(vaultRoot, operation.target!);
  if (operation.type === "create-file") {
    if (await exists(target)) throw new PkbError("TARGET_EXISTS", "create-file target already exists.", operation.target);
    if (operation.payload.format === "yaml") {
      const data = requireObject(operation.payload.data, operation, "data");
      if (typeof operation.payload.schema_id === "string") validateSchema(vaultRoot, operation.payload.schema_id, data);
      writeYaml(vaultRoot, target, data);
      return;
    }
    if (operation.payload.format === "text" && typeof operation.payload.text === "string") {
      await ensureDir(path.dirname(target));
      await fs.writeFile(target, operation.payload.text, "utf8");
      return;
    }
    const document = requireObject(operation.payload.document, operation, "document");
    const data = requireObject(document.data, operation, "document.data");
    if (typeof document.content !== "string") throw new PkbError("INVALID_OPERATION", "document.content must be a string.", operation);
    if (typeof operation.payload.schema_id === "string") validateSchema(vaultRoot, operation.payload.schema_id, data);
    await ensureDir(path.dirname(target));
    writeMarkdown(vaultRoot, target, { data, content: document.content });
    return;
  }
  if (operation.type === "update-file") {
    if (operation.payload.format !== "json") throw new PkbError("INVALID_OPERATION", "update-file currently requires format=json.", operation);
    const data = requireObject(operation.payload.data, operation, "data");
    await writeJsonAtomic(target, data);
    return;
  }
  if (operation.type === "update-frontmatter") {
    const document = parseMarkdown(vaultRoot, target);
    const patch = requireObject(operation.payload.patch, operation, "patch");
    assertOwnedMutation(document.data, { actor: operation.payload.actor === "ai" ? "ai" : operation.payload.actor === "user" ? "user" : "system", fields: Object.keys(patch), reviewId: operation.requires_review_id });
    const data = deepMerge(document.data, patch); const replaceTopLevel = Array.isArray(operation.payload.replace_top_level) ? operation.payload.replace_top_level.filter((value): value is string => typeof value === "string") : [];
    for (const key of replaceTopLevel) if (key in patch) data[key] = structuredClone(patch[key]!);
    const updated: MarkdownDocument = { data, content: document.content };
    if (typeof operation.payload.schema_id === "string") validateSchema(vaultRoot, operation.payload.schema_id, updated.data);
    writeMarkdown(vaultRoot, target, updated);
    return;
  }
  if (operation.type === "migrate-frontmatter") {
    const document = parseMarkdown(vaultRoot, target);
    const fromVersion = Number(operation.payload.from_version);
    const toVersion = Number(operation.payload.to_version);
    if (document.data.schema_version !== fromVersion) throw new PkbError("MIGRATION_VERSION_MISMATCH", `Expected schema_version ${fromVersion}.`, operation);
    const steps = operation.payload.steps;
    if (!Array.isArray(steps)) throw new PkbError("INVALID_OPERATION", "Migration steps must be an array.", operation);
    const data = structuredClone(document.data);
    for (const raw of steps) {
      const step = requireObject(raw, operation, "migration step");
      const field = String(step.path ?? "");
      if (!field) throw new PkbError("INVALID_OPERATION", "Migration step path is required.", step);
      if (step.op === "set") setNested(data, field, step.value);
      else if (step.op === "remove") deleteNested(data, field);
      else if (step.op === "rename") {
        const destination = String(step.to ?? "");
        const value = field.split(".").reduce<unknown>((current, part) => current && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined, data);
        if (value !== undefined) { setNested(data, destination, value); deleteNested(data, field); }
      } else throw new PkbError("INVALID_OPERATION", `Unsupported migration step: ${String(step.op)}`, step);
    }
    data.schema_version = toVersion;
    if (typeof operation.payload.schema_id === "string") validateSchema(vaultRoot, operation.payload.schema_id, data);
    writeMarkdown(vaultRoot, target, { data, content: document.content });
    return;
  }
  if (operation.type === "update-instance") {
    const data = deepMerge(parseYaml(vaultRoot, target), requireObject(operation.payload.patch, operation, "patch"));
    if (typeof operation.payload.schema_id === "string") validateSchema(vaultRoot, operation.payload.schema_id, data);
    writeYaml(vaultRoot, target, data);
    return;
  }
  if (operation.type === "append-section") {
    const document = parseMarkdown(vaultRoot, target);
    assertOwnedMutation(document.data, { actor: operation.payload.actor === "ai" ? "ai" : operation.payload.actor === "user" ? "user" : "system", section: String(operation.payload.section ?? "Changes"), reviewId: operation.requires_review_id });
    writeMarkdown(vaultRoot, target, {
      data: document.data,
      content: appendToSection(document.content, String(operation.payload.section ?? "Changes"), String(operation.payload.content ?? ""), String(operation.payload.marker ?? operation.idempotency_key)),
    });
    return;
  }
  if (operation.type === "move-file") {
    if (typeof operation.payload.destination !== "string") throw new PkbError("INVALID_OPERATION", "move-file requires a Vault-relative destination.", operation);
    const destination = resolveVaultPath(vaultRoot, operation.payload.destination);
    if (await exists(destination)) throw new PkbError("DESTINATION_EXISTS", "Move destination already exists.", operation.payload.destination);
    await ensureDir(path.dirname(destination));
    await fs.rename(target, destination);
  }
}

export async function recoverInterruptedTransactions(vaultRoot: string): Promise<string[]> {
  const root = path.join(vaultRoot, "90-System", "State", "Transactions");
  const recovered: string[] = [];
  if (!(await exists(root))) return recovered;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, "transaction.json");
    if (!(await exists(file))) continue;
    const record = await readJson<TransactionRecord | null>(file, null);
    if (!record || !["in-progress", "partially-failed"].includes(record.status)) continue;
    await restoreTransaction(vaultRoot, record);
    await removeIdempotencyEntries(vaultRoot, record);
    recovered.push(record.plan_id);
  }
  return recovered;
}

async function rollbackTransactionUnlocked(vaultRoot: string, planId: string): Promise<TransactionStatus> {
  const record = await readJson<TransactionRecord | null>(transactionPath(vaultRoot, planId), null);
  if (!record) throw new PkbError("TRANSACTION_NOT_FOUND", `Transaction ${planId} was not found.`);
  if (record.status === "rolled-back") return record.status;
  await restoreTransaction(vaultRoot, record);
  await removeIdempotencyEntries(vaultRoot, record);
  const migrationRoot = path.join(vaultRoot, "90-System", "State", "Migrations");
  if (await exists(migrationRoot)) {
    for (const file of await fs.readdir(migrationRoot)) {
      if (!file.endsWith(".json")) continue;
      const migration = await readJson<Record<string, unknown> | null>(path.join(migrationRoot, file), null);
      const plan = migration?.plan;
      if (plan && typeof plan === "object" && (plan as Record<string, unknown>).plan_id === planId) {
        migration!.status = "rolled-back";
        migration!.updated_at = new Date().toISOString();
        await writeJsonAtomic(path.join(migrationRoot, file), migration);
      }
    }
  }
  return record.status;
}

export async function rollbackTransaction(vaultRoot: string, planId: string): Promise<TransactionStatus> {
  const lock = await acquireLock(vaultRoot, `rollback-${planId}`);
  try {
    return await rollbackTransactionUnlocked(vaultRoot, planId);
  } finally {
    await releaseLock(vaultRoot, lock);
  }
}

export async function executeOperationPlan(vaultRoot: string, plan: OperationPlan, policy: ExecutionPolicy = {}): Promise<void> {
  validateSchema(vaultRoot, PLAN_SCHEMA, plan);
  checkPermissions(plan, policy);
  const existing = await readJson<TransactionRecord | null>(transactionPath(vaultRoot, plan.plan_id), null);
  if (existing?.status === "completed") return;
  if (existing) throw new PkbError("TRANSACTION_REQUIRES_NEW_PLAN", `Plan ${plan.plan_id} already has transaction status ${existing.status}.`);
  const lock = await acquireLock(vaultRoot, plan.plan_id);
  const now = new Date().toISOString();
  const record: TransactionRecord = {
    transaction_id: `TX-${plan.plan_id}`, plan_id: plan.plan_id, status: "not-started",
    git_snapshot: policy.gitSnapshot ?? null, created_at: now, updated_at: now, error: null, snapshots: [],
    operations: plan.operations.map((operation) => ({ operation_id: operation.operation_id, idempotency_key: operation.idempotency_key, status: "pending", error: null })),
  };
  try {
    await writeTransaction(vaultRoot, record);
    await snapshotPaths(vaultRoot, plan, record);
    record.status = "in-progress";
    await writeTransaction(vaultRoot, record);
    const ledgerPath = path.join(vaultRoot, "90-System", "State", "idempotency.json");
    const ledger = await readJson<IdempotencyLedger>(ledgerPath, { completed: {} });
    for (const [index, operation] of plan.operations.entries()) {
      const state = record.operations[index]!;
      if (ledger.completed[operation.idempotency_key]) {
        state.status = "skipped";
        await writeTransaction(vaultRoot, record);
        continue;
      }
      state.status = "in-progress";
      await writeTransaction(vaultRoot, record);
      try {
        await executeOperation(vaultRoot, operation);
        state.status = "completed";
      } catch (error) {
        state.status = "failed";
        state.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
      await writeTransaction(vaultRoot, record);
    }
    const completedAt = new Date().toISOString();
    await recordResultHashes(vaultRoot, record);
    for (const operation of plan.operations) ledger.completed[operation.idempotency_key] = { plan_id: plan.plan_id, completed_at: completedAt };
    await writeJsonAtomic(ledgerPath, ledger);
    record.status = "completed";
    await writeTransaction(vaultRoot, record);
  } catch (error) {
    record.status = "partially-failed";
    record.error = error instanceof Error ? error.message : String(error);
    await writeTransaction(vaultRoot, record).catch(() => undefined);
    await restoreTransaction(vaultRoot, record);
    throw error;
  } finally {
    await releaseLock(vaultRoot, lock);
  }
}
