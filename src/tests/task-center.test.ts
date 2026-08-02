import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeVault } from "../core/vault.js";
import type { JsonObject } from "../core/types.js";
import type { TaskResources } from "../runtime/domain.js";
import { RuntimeRepository } from "../runtime/repository.js";
import { invokeCommandApi } from "../platform/commandApi.js";

const local: TaskResources = { filesystem: "required", network: "not-required", codex: "not-required", user: "not-required" };

test("Task Center API lists, explains, retries, defers, cancels, and runs Tasks", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-task-center-"));
  try {
    await initializeVault(vault, "disabled");
    let repository = await RuntimeRepository.open(vault);
    const task = repository.createTask({ job_id: "core.center", module: "core", task_type: "core-operation", workflow: "core:scan-inbox", resources: local, trigger: { type: "manual" }, catch_up_policy: "none", idempotency_key: "center:one", priority: "high" }).task;
    repository.close();
    const list = await invokeCommandApi({ vaultRoot: vault, requestId: "TASK-LIST", method: "listTasks", params: {} });
    assert.equal(list.ok, true);
    assert.equal((list.data as JsonObject[])[0]?.task_id, task.task_id);
    const detail = await invokeCommandApi({ vaultRoot: vault, requestId: "TASK-DETAIL", method: "getTaskDetails", params: { task_id: task.task_id } });
    assert.equal(((detail.data as JsonObject).runs as JsonObject[]).length, 0);
    const cycle = await invokeCommandApi({ vaultRoot: vault, requestId: "TASK-CYCLE", method: "runTaskCycle", params: { limit: 2 } });
    assert.equal(cycle.ok, true);
    const completed = await invokeCommandApi({ vaultRoot: vault, requestId: "TASK-DETAIL-2", method: "getTaskDetails", params: { task_id: task.task_id } });
    assert.equal(((completed.data as JsonObject).task as JsonObject).status, "completed");

    repository = await RuntimeRepository.open(vault);
    const cancellable = repository.createTask({ job_id: "core.cancel", module: "core", task_type: "core-operation", workflow: "core:scan-inbox", resources: local, trigger: { type: "manual" }, catch_up_policy: "none", idempotency_key: "center:cancel" }).task;
    repository.close();
    const deferred = await invokeCommandApi({ vaultRoot: vault, requestId: "TASK-DEFER", method: "manageTask", params: { task_id: cancellable.task_id, action: "defer", defer_until: new Date(Date.now() + 86_400_000).toISOString() } });
    assert.equal((deferred.data as JsonObject).status, "deferred");
    const cancelled = await invokeCommandApi({ vaultRoot: vault, requestId: "TASK-CANCEL", method: "manageTask", params: { task_id: cancellable.task_id, action: "cancel" } });
    assert.equal((cancelled.data as JsonObject).status, "cancelled");
    const runtime = await invokeCommandApi({ vaultRoot: vault, requestId: "TASK-STATUS", method: "getTaskRuntimeStatus", params: {} });
    assert.equal((runtime.data as JsonObject).integrity, "ok");
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("Today surfaces only actionable runtime Tasks and plugin exposes Task Center", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-task-today-"));
  try {
    await initializeVault(vault, "disabled");
    const repository = await RuntimeRepository.open(vault);
    const waiting = repository.createTask({ job_id: "ai.summary", module: "experience-log", task_type: "workflow", workflow: "experience-log:weekly", resources: { ...local, codex: "required" }, trigger: { type: "schedule" }, catch_up_policy: "latest", idempotency_key: "today:ai" }).task;
    repository.transitionTask(waiting.task_id, "waiting-for-ai", { error: { code: "CODEX_UNAVAILABLE", message: "Codex unavailable", retryable: true, occurred_at: new Date().toISOString(), details: {} } });
    const lowNetwork = repository.createTask({ job_id: "core.links", module: "core", task_type: "core-operation", workflow: "core:external-link-audit", priority: "low", resources: { ...local, network: "required" }, trigger: { type: "schedule" }, catch_up_policy: "latest", idempotency_key: "today:network" }).task;
    repository.transitionTask(lowNetwork.task_id, "waiting-for-network", { error: { code: "RESOURCE_UNAVAILABLE", message: "Network unknown", retryable: true, occurred_at: new Date().toISOString(), details: {} } });
    repository.close();
    const today = await invokeCommandApi({ vaultRoot: vault, requestId: "TASK-TODAY", method: "getTodayItems", params: { refresh_markdown: false } });
    assert.equal(today.ok, true, JSON.stringify(today.error));
    const snapshot = today.data as JsonObject;
    assert.equal((snapshot.waiting_external as JsonObject[]).some((item) => item.item_id === `DSH-TASK-${waiting.task_id}`), true);
    assert.equal((snapshot.waiting_external as JsonObject[]).some((item) => item.item_id === `DSH-TASK-${lowNetwork.task_id}`), false);
    const plugin = await fs.readFile(path.resolve("plugins/knowledgeos-obsidian/main.js"), "utf8");
    assert.match(plugin, /class TaskDetailsModal/);
    assert.match(plugin, /renderTasks\(root\)/);
    assert.match(plugin, /runTaskCycle/);
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});
