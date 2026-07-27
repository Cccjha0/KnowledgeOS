import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PkbError } from "../core/errors.js";
import { initializeVault } from "../core/vault.js";
import { dispatchOnce } from "../runtime/dispatcher.js";
import type { TaskResources } from "../runtime/domain.js";
import { RuntimeRepository } from "../runtime/repository.js";

const local: TaskResources = { filesystem: "required", network: "not-required", codex: "not-required", user: "not-required" };

test("red-risk and sensitive payloads never enter unattended execution", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-task-safety-"));
  try {
    await initializeVault(vault, "disabled");
    let repository = await RuntimeRepository.open(vault);
    assert.throws(() => repository.createTask({
      job_id: "unsafe.payload", module: "core", task_type: "core-operation", workflow: "core:scan-inbox", resources: local,
      trigger: { type: "manual" }, catch_up_policy: "none", idempotency_key: "unsafe:payload", payload: { api_token: "secret" },
    }), (error: unknown) => error instanceof PkbError && error.code === "TASK_PAYLOAD_SENSITIVE");
    const red = repository.createTask({
      job_id: "red.operation", module: "core", task_type: "core-operation", workflow: "core:scan-inbox", resources: local,
      trigger: { type: "schedule" }, catch_up_policy: "none", idempotency_key: "red:one", payload: { risk: "red", target_ref: "record-1" },
    }).task;
    repository.close();
    await dispatchOnce({ vaultRoot: vault, limit: 2 });
    repository = await RuntimeRepository.open(vault);
    assert.equal(repository.getTask(red.task_id)?.status, "waiting-for-user");
    assert.equal(repository.getRuns(red.task_id).length, 0);
    repository.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("running cancellation is cooperative and leaves a cancelled Run", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-task-cancel-"));
  try {
    await initializeVault(vault, "disabled");
    let repository = await RuntimeRepository.open(vault);
    const task = repository.createTask({ job_id: "cancel.running", module: "core", task_type: "core-operation", workflow: "test:cooperative", resources: local, trigger: { type: "manual" }, catch_up_policy: "none", idempotency_key: "cancel:running" }).task;
    repository.close();
    await dispatchOnce({ vaultRoot: vault, limit: 1, handlers: {
      "test:cooperative": async ({ checkpoint }) => {
        const external = await RuntimeRepository.open(vault); external.cancelTask(task.task_id); external.close();
        checkpoint();
        return { completion_reason: "should-not-complete" };
      },
    } });
    repository = await RuntimeRepository.open(vault);
    assert.equal(repository.getTask(task.task_id)?.status, "cancelled");
    assert.equal(repository.getRuns(task.task_id)[0]?.status, "cancelled");
    repository.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("invalid Codex output is retryable on the same Task and separate Run", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-task-codex-"));
  try {
    await initializeVault(vault, "disabled");
    let repository = await RuntimeRepository.open(vault);
    repository.setResourceStatus({ resource: "codex", status: "available", reason: null, checked_at: new Date().toISOString(), details: { adapter: "test" } });
    const task = repository.createTask({ job_id: "codex.schema", module: "experience-log", task_type: "workflow", workflow: "test:bad-output", resources: { ...local, codex: "required" }, trigger: { type: "manual" }, catch_up_policy: "none", idempotency_key: "codex:schema", max_attempts: 2 }).task;
    repository.close();
    await dispatchOnce({ vaultRoot: vault, limit: 1, handlers: { "test:bad-output": async () => { throw new PkbError("CODEX_OUTPUT_INVALID", "Output failed schema validation."); } } });
    repository = await RuntimeRepository.open(vault);
    assert.equal(repository.getTask(task.task_id)?.status, "queued");
    assert.equal(repository.getTask(task.task_id)?.next_retry_at !== null, true);
    assert.equal(repository.getRuns(task.task_id)[0]?.status, "failed");
    repository.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});
