import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PkbError } from "../core/errors.js";
import { initializeVault } from "../core/vault.js";
import { dispatchOnce } from "../runtime/dispatcher.js";
import type { JobDefinition, TaskResources } from "../runtime/domain.js";
import { reconcileStartup } from "../runtime/reconciler.js";
import { RuntimeRepository } from "../runtime/repository.js";
import { evaluateScheduler } from "../runtime/scheduler.js";

const local: TaskResources = { filesystem: "required", network: "not-required", codex: "not-required", user: "not-required" };

function scheduledJob(policy: "latest" | "all" | "aggregate"): JobDefinition {
  return {
    job_id: `core.daily-${policy}`, source: "core", module: "core", scope: "core", enabled: true,
    task_type: "core-operation", workflow: "core:scan-inbox", trigger: { type: "daily", at: "08:00", timezone: "UTC" },
    resources: local, catch_up: { policy, max_tasks: 10 }, retry: { max_attempts: 3 },
    concurrency: { policy: "forbid", key: `daily:${policy}` }, idempotency: { key_pattern: "window" }, priority: "normal",
    updated_at: new Date().toISOString(),
  };
}

test("Scheduler applies latest, all, and aggregate catch-up without duplicate windows", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-schedule-"));
  try {
    const repository = await RuntimeRepository.open(vault);
    const from = "2026-07-25T07:59:00.000Z";
    for (const policy of ["latest", "all", "aggregate"] as const) {
      const job = scheduledJob(policy); repository.registerJob(job);
      repository.setCheckpoint({ job_id: job.job_id, last_evaluated_at: from, last_created_window: null, next_evaluation_at: null });
    }
    repository.close();
    const now = new Date("2026-07-28T08:01:00.000Z");
    const first = await evaluateScheduler(vault, now);
    assert.equal(first.created.length, 6); // latest 1, all 4, aggregate 1
    const second = await evaluateScheduler(vault, now);
    assert.equal(second.created.length, 0);
    const reopened = await RuntimeRepository.open(vault);
    const aggregate = reopened.listTasks().find((task) => task.job_id === "core.daily-aggregate")!;
    assert.equal((aggregate.payload.windows as string[]).length, 4);
    const checkpoint = reopened.getCheckpoints().find((item) => item.job_id === "core.daily-latest");
    assert.equal(checkpoint?.next_evaluation_at, "2026-07-29T08:00:00.000Z");
    reopened.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("cron matching honors all five fields, lists, ranges, and steps", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-cron-"));
  try {
    const repository = await RuntimeRepository.open(vault);
    const job: JobDefinition = { ...scheduledJob("all"), job_id: "core.cron", trigger: { type: "cron", expression: "*/15 8-10 28 7 2", timezone: "UTC" }, concurrency: { policy: "forbid", key: "cron" } };
    repository.registerJob(job);
    repository.setCheckpoint({ job_id: job.job_id, last_evaluated_at: "2026-07-28T07:59:00.000Z", last_created_window: null, next_evaluation_at: null });
    repository.close();
    const result = await evaluateScheduler(vault, new Date("2026-07-28T10:01:00.000Z"));
    assert.equal(result.created.length, 9);
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("Startup reconciles stale running and due deferred Tasks", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-reconcile-"));
  try {
    await initializeVault(vault, "disabled");
    let repository = await RuntimeRepository.open(vault);
    const interrupted = repository.createTask({ job_id: "core.scan", module: "core", task_type: "core-operation", workflow: "core:scan-inbox", resources: local, trigger: { type: "startup" }, catch_up_policy: "latest", idempotency_key: "reconcile:running" }).task;
    repository.startRun(interrupted.task_id, "worker-crashed", { filesystem: "available" });
    const deferred = repository.createTask({ job_id: "core.defer", module: "core", task_type: "core-operation", workflow: "core:scan-inbox", resources: local, trigger: { type: "manual" }, catch_up_policy: "none", idempotency_key: "reconcile:defer" }).task;
    repository.transitionTask(deferred.task_id, "deferred", { deferUntil: new Date(Date.now() + 1_000).toISOString() });
    repository.close();
    const future = new Date(Date.now() + 180_000);
    await reconcileStartup(vault, future);
    repository = await RuntimeRepository.open(vault);
    assert.equal(repository.getTask(interrupted.task_id)?.status, "queued");
    assert.equal(repository.getRuns(interrupted.task_id)[0]?.status, "interrupted");
    assert.equal(repository.getTask(deferred.task_id)?.status, "queued");
    repository.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("retry, dependency, cancellation, and concurrency lock preserve one Task identity", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-control-"));
  try {
    await initializeVault(vault, "disabled");
    let repository = await RuntimeRepository.open(vault);
    const first = repository.createTask({ job_id: "lock.one", module: "core", task_type: "core-operation", workflow: "test:timeout", resources: local, trigger: { type: "manual" }, catch_up_policy: "none", idempotency_key: "lock:one", concurrency_key: "shared", max_attempts: 3 }).task;
    const second = repository.createTask({ job_id: "lock.two", module: "core", task_type: "core-operation", workflow: "core:scan-inbox", resources: local, trigger: { type: "manual" }, catch_up_policy: "none", idempotency_key: "lock:two", concurrency_key: "shared" }).task;
    const heldRun = repository.startRun(first.task_id, "holder", { filesystem: "available" });
    assert.throws(() => repository.startRun(second.task_id, "blocked", { filesystem: "available" }), (error: unknown) => error instanceof PkbError && error.code === "TASK_LOCKED");
    repository.finishRun(heldRun.run_id, { runStatus: "failed", taskStatus: "failed", completionReason: "test" });
    repository.retryTask(first.task_id);
    repository.close();
    const retried = await dispatchOnce({ vaultRoot: vault, limit: 1, handlers: { "test:timeout": async () => { throw new PkbError("ETIMEDOUT", "temporary"); } } });
    assert.equal(retried.tasks[0]?.status, "queued");
    repository = await RuntimeRepository.open(vault);
    assert.equal(repository.getTask(first.task_id)?.attempt_count, 2);
    assert.equal(repository.getRuns(first.task_id).length, 2);
    const dependent = repository.createTask({ job_id: "dependent", module: "core", task_type: "core-operation", workflow: "core:scan-inbox", resources: local, trigger: { type: "manual" }, catch_up_policy: "none", idempotency_key: "dependent:one", dependency_task_ids: [first.task_id] }).task;
    const cancelled = repository.cancelTask(dependent.task_id);
    assert.equal(cancelled.status, "cancelled");
    repository.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});
