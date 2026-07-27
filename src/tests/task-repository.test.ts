import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
    assert.equal(repository.schemaVersion(), 1);
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
    repository.close();

    repository = await RuntimeRepository.open(vault);
    assert.equal(repository.getTask(first.task.task_id)?.idempotency_key, input.idempotency_key);
    assert.equal(repository.listJobs()[0]?.job_id, "core.today-build");
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
