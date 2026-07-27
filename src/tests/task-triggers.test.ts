import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeRepository } from "../runtime/repository.js";
import { enqueueManualTask, materializeFieldDueJobs, materializeStartupJobs, publishRuntimeEvent } from "../runtime/triggers.js";
import type { JobDefinition, TaskResources } from "../runtime/domain.js";
import type { JsonObject } from "../core/types.js";

const local: TaskResources = { filesystem: "required", network: "not-required", codex: "not-required", user: "not-required" };
const base = (id: string, trigger: JsonObject): JobDefinition => ({ job_id: id, source: "core", module: "core", scope: "core", enabled: true, task_type: "core-operation", workflow: "core:test", trigger, resources: local, catch_up: { policy: "none" }, retry: { max_attempts: 2 }, concurrency: { policy: "forbid", key: id }, idempotency: {}, priority: "normal", updated_at: new Date().toISOString() });

test("startup and event triggers persist tasks and deduplicate the same source", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-triggers-"));
  try {
    const repository = await RuntimeRepository.open(vault);
    repository.registerJob(base("core.start", { type: "startup" }));
    repository.registerJob(base("core.capture", { type: "event", event: "capture.created" }));
    repository.registerJob(base("core.manual", { type: "manual" }));
    repository.close();
    const first = await materializeStartupJobs(vault, "boot-1");
    const second = await materializeStartupJobs(vault, "boot-1");
    assert.equal(first.created.length, 1); assert.equal(second.deduplicated, 1);
    const event = { type: "capture.created", event_id: "EVT-fixed", payload: { capture_id: "CAP-1" } };
    assert.equal((await publishRuntimeEvent(vault, event)).created.length, 1);
    const manual = await enqueueManualTask(vault, "core.manual");
    const duplicateClick = await enqueueManualTask(vault, "core.manual");
    assert.equal(duplicateClick.task_id, manual.task_id); assert.equal(duplicateClick.deduplicated, true);
    const repo2 = await RuntimeRepository.open(vault);
    assert.equal(repo2.listEvents()[0]?.event_type, "capture.created");
    assert.equal(repo2.listTasks().length, 3);
    repo2.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("field-due trigger references the source file without copying its body", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-field-due-"));
  try {
    const records = path.join(vault, "20-Workspace", "Records"); await fs.mkdir(records, { recursive: true });
    await fs.writeFile(path.join(records, "record.md"), "---\ninstance_id: demo\nmonitoring:\n  next_check: '2026-01-01T00:00:00Z'\n---\nprivate body\n", "utf8");
    const repository = await RuntimeRepository.open(vault);
    repository.registerJob(base("core.field", { type: "field-due", source_root: "20-Workspace/Records", field: "monitoring.next_check", id_field: "instance_id" }));
    repository.close();
    const result = await materializeFieldDueJobs(vault, new Date("2026-02-01T00:00:00Z"));
    assert.equal(result.created.length, 1);
    const repo2 = await RuntimeRepository.open(vault); const task = repo2.listTasks()[0]!;
    assert.equal(task.payload.source_file, "20-Workspace/Records/record.md");
    assert.equal(JSON.stringify(task.payload).includes("private body"), false);
    repo2.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});
