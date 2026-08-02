import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exists } from "../core/files.js";
import { initializeVault } from "../core/vault.js";
import type { TaskResources } from "../runtime/domain.js";
import { dispatchOnce } from "../runtime/dispatcher.js";
import { RuntimeRepository } from "../runtime/repository.js";
import { updateResourceStatus } from "../runtime/resourceGate.js";

const resources = (network = false, codex = false, user = false): TaskResources => ({
  filesystem: "required", network: network ? "required" : "not-required",
  codex: codex ? "required" : "not-required", user: user ? "required" : "not-required",
});

test("Dispatcher runs deterministic work while unavailable resources wait independently", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-dispatch-"));
  try {
    await initializeVault(vault, "disabled");
    let repository = await RuntimeRepository.open(vault);
    repository.setResourceStatus({ resource: "network", status: "unavailable", reason: "offline-test", checked_at: new Date().toISOString(), details: {} });
    repository.setResourceStatus({ resource: "codex", status: "unavailable", reason: "codex-test", checked_at: new Date().toISOString(), details: {} });
    const local = repository.createTask({ job_id: "core.today", module: "core", task_type: "core-operation", workflow: "core:build-today", resources: resources(), trigger: { type: "manual" }, catch_up_policy: "latest", idempotency_key: "dispatch:local" }).task;
    const network = repository.createTask({ job_id: "test.network", module: "core", task_type: "core-operation", workflow: "core:scan-inbox", resources: resources(true), trigger: { type: "manual" }, catch_up_policy: "none", idempotency_key: "dispatch:network" }).task;
    const ai = repository.createTask({ job_id: "test.ai", module: "core", task_type: "core-operation", workflow: "core:scan-inbox", resources: resources(false, true), trigger: { type: "manual" }, catch_up_policy: "none", idempotency_key: "dispatch:ai" }).task;
    const user = repository.createTask({ job_id: "test.user", module: "core", task_type: "core-operation", workflow: "core:scan-inbox", resources: resources(false, false, true), trigger: { type: "manual" }, catch_up_policy: "none", idempotency_key: "dispatch:user" }).task;
    repository.close();

    const dispatched = await dispatchOnce({ vaultRoot: vault, limit: 10 });
    assert.equal(dispatched.completed, 1);
    assert.equal(dispatched.waiting, 3);
    assert.equal(await exists(path.join(vault, "Today.md")), true);
    repository = await RuntimeRepository.open(vault);
    assert.equal(repository.getTask(local.task_id)?.status, "completed");
    assert.equal(repository.getTask(network.task_id)?.status, "waiting-for-network");
    assert.equal(repository.getTask(ai.task_id)?.status, "waiting-for-ai");
    assert.equal(repository.getTask(user.task_id)?.status, "waiting-for-user");
    assert.equal(repository.getRuns(local.task_id).length, 1);
    assert.equal(repository.getRuns(network.task_id).length, 0);

    const woken = updateResourceStatus(repository, { resource: "network", status: "available", reason: null, checked_at: new Date().toISOString(), details: {} });
    assert.equal(woken, 1);
    assert.equal(repository.getTask(network.task_id)?.status, "queued");
    repository.close();
    const resumed = await dispatchOnce({ vaultRoot: vault, limit: 10 });
    assert.equal(resumed.completed, 1);
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("Worker records a separate failed Run for an unknown workflow", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-worker-fail-"));
  try {
    await initializeVault(vault, "disabled");
    let repository = await RuntimeRepository.open(vault);
    const task = repository.createTask({ job_id: "test.missing", module: "core", task_type: "core-operation", workflow: "missing:workflow", resources: resources(), trigger: { type: "manual" }, catch_up_policy: "none", idempotency_key: "missing:one" }).task;
    repository.close();
    const result = await dispatchOnce({ vaultRoot: vault, limit: 1 });
    assert.equal(result.failed, 1);
    repository = await RuntimeRepository.open(vault);
    assert.equal(repository.getTask(task.task_id)?.last_error?.code, "WORKFLOW_NOT_FOUND");
    assert.equal(repository.getRuns(task.task_id)[0]?.status, "failed");
    repository.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("Today rebuild records an unchanged run without rewriting the file", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-today-unchanged-"));
  try {
    await initializeVault(vault, "disabled");
    let repository = await RuntimeRepository.open(vault);
    const first = repository.createTask({ job_id: "core.today", module: "core", task_type: "core-operation", workflow: "core:build-today", resources: resources(), trigger: { type: "manual" }, catch_up_policy: "none", idempotency_key: "today:first" }).task;
    repository.close();
    await dispatchOnce({ vaultRoot: vault, limit: 1 });
    const today = path.join(vault, "Today.md");
    const firstStat = await fs.stat(today);

    repository = await RuntimeRepository.open(vault);
    const second = repository.createTask({ job_id: "core.today", module: "core", task_type: "core-operation", workflow: "core:build-today", resources: resources(), trigger: { type: "manual" }, catch_up_policy: "none", idempotency_key: "today:second" }).task;
    repository.close();
    await dispatchOnce({ vaultRoot: vault, limit: 1 });

    repository = await RuntimeRepository.open(vault);
    assert.equal(repository.getTask(first.task_id)?.completion_reason, "today-rebuilt");
    assert.equal(repository.getTask(second.task_id)?.completion_reason, "today-unchanged");
    const secondRun = repository.getRuns(second.task_id)[0]!;
    assert.equal(secondRun.metrics.files_written, 0);
    assert.deepEqual(secondRun.output_files, []);
    repository.close();
    assert.equal((await fs.stat(today)).mtimeMs, firstStat.mtimeMs);
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});
