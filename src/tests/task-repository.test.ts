import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import type { JobDefinition, TaskResources } from "../runtime/domain.js";
import { RuntimeRepository, restoreRuntimeDatabase } from "../runtime/repository.js";

const localResources: TaskResources = { filesystem: "required", network: "not-required", codex: "not-required", user: "not-required" };

function job(now: string): JobDefinition {
  return {
    job_id: "core.today-build", source: "core", module: "core", scope: "core", enabled: true,
    task_type: "core-operation", workflow: "core:build-today", trigger: { type: "manual" }, resources: localResources,
    catch_up: { policy: "latest" }, retry: { max_attempts: 3 }, concurrency: { policy: "replace", key: "core:today" },
    idempotency: { key_pattern: "core:today:{date}" }, priority: "normal", updated_at: now,
  };
}

test("runtime repository persists Tasks and deduplicates one business window", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-runtime-db-"));
  try {
    const now = new Date().toISOString();
    let repository = await RuntimeRepository.open(vault);
    assert.equal(repository.schemaVersion(), 6);
    assert.equal(repository.integrityCheck(), "ok");
    repository.registerJob(job(now));
    const input = {
      job_id: "core.today-build", module: "core", task_type: "core-operation" as const, workflow: "core:build-today",
      resources: localResources, trigger: { type: "manual" }, catch_up_policy: "latest" as const,
      idempotency_key: "core:today:2026-07-28", payload: {},
    };
    const first = repository.createTask(input);
    const duplicate = repository.createTask(input);
    assert.equal(first.deduplicated, false);
    assert.equal(duplicate.deduplicated, true);
    assert.equal(duplicate.task.task_id, first.task.task_id);
    assert.equal(repository.listTasks(["queued"]).length, 1);
    assert.equal((repository.runtimeStats().metrics as Record<string, number>).idempotency_deduplicated, 1);
    repository.close();

    repository = await RuntimeRepository.open(vault);
    assert.equal(repository.getTask(first.task.task_id)?.idempotency_key, input.idempotency_key);
    assert.equal(repository.listJobs()[0]?.job_id, "core.today-build");
    repository.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("runtime wake hints include runnable, retry, and deferred work without polling blocked dependencies", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-runtime-wake-"));
  try {
    const repository = await RuntimeRepository.open(vault);
    const now = new Date("2026-08-13T00:00:00.000Z");
    const future = new Date(now.getTime() + 90_000).toISOString();
    const base = {
      job_id: "core.wake", module: "core", task_type: "core-operation" as const, workflow: "core:test",
      resources: localResources, trigger: { type: "manual" }, catch_up_policy: "none" as const,
    };
    const dependency = repository.createTask({ ...base, idempotency_key: "wake:dependency", available_after: future }).task;
    repository.createTask({
      ...base, idempotency_key: "wake:blocked", available_after: now.toISOString(),
      dependency_task_ids: [dependency.task_id], dependency_policy: "all-success",
    });
    assert.deepEqual(repository.nextWake(now.toISOString()), {
      has_work: false, next_wake_at: future, waiting_for_resources: 0,
    });

    const deferred = repository.createTask({ ...base, idempotency_key: "wake:deferred" }).task;
    repository.transitionTask(deferred.task_id, "deferred", { deferUntil: future });
    assert.equal(repository.nextWake(now.toISOString()).next_wake_at, future);
    const woken = repository.wakeDueTasks(new Date(now.getTime() + 91_000).toISOString());
    assert.deepEqual(woken.requeued, [deferred.task_id]);
    assert.equal(repository.getTask(deferred.task_id)?.status, "queued");
    assert.equal(repository.nextWake(new Date(now.getTime() + 91_000).toISOString()).has_work, true);
    repository.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("Today runtime projection excludes terminal history and unrelated queued work", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-runtime-today-projection-"));
  try {
    const repository = await RuntimeRepository.open(vault);
    const base = { job_id: "core.today-projection", module: "core", task_type: "core-operation" as const, workflow: "core:test",
      resources: localResources, trigger: { type: "manual" }, catch_up_policy: "none" as const };
    const create = (key: string, patch: Record<string, unknown> = {}) => repository.createTask({ ...base, idempotency_key: key, ...patch }).task;
    const completed = create("today:completed");
    repository.transitionTask(completed.task_id, "running"); repository.transitionTask(completed.task_id, "completed");
    const cancelled = create("today:cancelled"); repository.transitionTask(cancelled.task_id, "cancelled");
    create("today:low-queued", { priority: "low" });
    create("today:far-high", { priority: "high", scheduled_for: new Date(Date.now() + 7 * 86_400_000).toISOString() });
    const nearHigh = create("today:near-high", { priority: "high", scheduled_for: new Date(Date.now() + 3_600_000).toISOString() });
    const waiting = create("today:waiting", { priority: "normal" }); repository.transitionTask(waiting.task_id, "waiting-for-user");
    const failed = create("today:failed", { priority: "normal" }); repository.transitionTask(failed.task_id, "running"); repository.transitionTask(failed.task_id, "failed");
    const interrupted = create("today:interrupted", { priority: "normal" }); repository.transitionTask(interrupted.task_id, "running"); repository.transitionTask(interrupted.task_id, "interrupted");
    const projection = repository.todayData();
    const projectedIds = new Set((projection.tasks as unknown as Array<{ task_id: string }>).map((task) => task.task_id));
    assert.deepEqual(projectedIds, new Set([nearHigh.task_id, waiting.task_id, failed.task_id, interrupted.task_id]));
    assert.equal(repository.listTasks().length, 8, "Task Center history remains complete");
    repository.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("runtime transitions and Runs remain separate, atomic records", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-runtime-run-"));
  try {
    const repository = await RuntimeRepository.open(vault);
    const created = repository.createTask({
      job_id: "core.audit", module: "core", task_type: "core-operation", workflow: "core:vault-audit",
      resources: localResources, trigger: { type: "manual" }, catch_up_policy: "none", idempotency_key: "audit:one",
    });
    const run = repository.startRun(created.task.task_id, "worker-test", { filesystem: "available" });
    assert.equal(repository.getTask(created.task.task_id)?.status, "running");
    assert.equal(run.attempt_number, 1);
    assert.equal(repository.getRuns(created.task.task_id).length, 1);
    const completed = repository.transitionTask(created.task.task_id, "completed", { completionReason: "success" });
    assert.equal(completed.status, "completed");
    assert.throws(() => repository.transitionTask(created.task.task_id, "queued"), /Invalid task transition/);
    repository.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("runtime database backup can restore durable queue state", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-runtime-backup-"));
  try {
    const repository = await RuntimeRepository.open(vault);
    const task = repository.createTask({
      job_id: "core.scan", module: "core", task_type: "core-operation", workflow: "core:scan-inbox",
      resources: localResources, trigger: { type: "startup" }, catch_up_policy: "latest", idempotency_key: "scan:startup:1",
    }).task;
    const backup = path.join(vault, "90-System", "Backups", "runtime-test.db");
    await repository.backup(backup);
    repository.close();
    await fs.writeFile(path.join(vault, "90-System", "State", "runtime.db"), "damaged", "utf8");
    await restoreRuntimeDatabase(vault, backup);
    const restored = await RuntimeRepository.open(vault);
    assert.equal(restored.integrityCheck(), "ok");
    assert.equal(restored.getTask(task.task_id)?.idempotency_key, "scan:startup:1");
    restored.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("runtime restore rejects a corrupt backup without replacing the active database", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-runtime-invalid-backup-"));
  try {
    const repository = await RuntimeRepository.open(vault);
    const task = repository.createTask({
      job_id: "core.scan", module: "core", task_type: "core-operation", workflow: "core:scan-inbox",
      resources: localResources, trigger: { type: "manual" }, catch_up_policy: "none", idempotency_key: "scan:survives-invalid-restore",
    }).task;
    repository.close();
    const invalidBackup = path.join(vault, "90-System", "Backups", "invalid-runtime.db");
    await fs.mkdir(path.dirname(invalidBackup), { recursive: true });
    await fs.writeFile(invalidBackup, "not a sqlite database", "utf8");
    await assert.rejects(restoreRuntimeDatabase(vault, invalidBackup), /file is not a database|malformed/i);
    const active = await RuntimeRepository.open(vault);
    assert.equal(active.getTask(task.task_id)?.idempotency_key, "scan:survives-invalid-restore");
    active.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("replace and merge concurrency policies have deterministic queue semantics", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-runtime-concurrency-"));
  try {
    const repository = await RuntimeRepository.open(vault);
    const input = { job_id: "core.refresh", module: "core", task_type: "core-operation" as const, workflow: "core:test", resources: localResources, trigger: { type: "manual" }, catch_up_policy: "none" as const, concurrency_key: "refresh" };
    const old = repository.createTask({ ...input, concurrency_policy: "replace", idempotency_key: "refresh:old" }).task;
    const replacement = repository.createTask({ ...input, concurrency_policy: "replace", idempotency_key: "refresh:new" }).task;
    assert.equal(repository.getTask(old.task_id)?.completion_reason, "replaced");
    assert.equal(replacement.status, "queued");
    const merged = repository.createTask({ ...input, concurrency_key: "merge", concurrency_policy: "merge", idempotency_key: "merge:1", payload: { source_file: "a.md" } }).task;
    const same = repository.createTask({ ...input, concurrency_key: "merge", concurrency_policy: "merge", idempotency_key: "merge:2", payload: { source_file: "b.md" } });
    assert.equal(same.task.task_id, merged.task_id); assert.equal(same.deduplicated, true);
    assert.equal((same.task.payload.merged_requests as unknown[]).length, 1);
    const repeated = repository.createTask({ ...input, concurrency_key: "merge", concurrency_policy: "merge", idempotency_key: "merge:3", payload: { source_file: "b.md" } });
    assert.equal((repeated.task.payload.merged_requests as unknown[]).length, 1);
    repository.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("opening a v1 runtime database creates a pre-migration snapshot", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-runtime-migrate-"));
  try {
    const repository = await RuntimeRepository.open(vault); const database = repository.databasePath; repository.close();
    const script = "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('DROP TABLE codex_invocations'); c.execute('DROP TABLE runtime_events'); c.execute(\"UPDATE runtime_metadata SET value='1' WHERE key='schema_version'\"); c.commit(); c.close()";
    const downgraded = spawnSync("python", ["-c", script, database], { encoding: "utf8", windowsHide: true });
    assert.equal(downgraded.status, 0, downgraded.stderr);
    const migrated = await RuntimeRepository.open(vault); assert.equal(migrated.schemaVersion(), 6); migrated.close();
    const backups = await fs.readdir(path.join(vault, "90-System", "Backups"));
    assert.equal(backups.some((name) => name.startsWith("runtime-schema-v1-") && name.endsWith(".db")), true);
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});
