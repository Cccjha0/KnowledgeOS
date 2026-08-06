import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeRepository } from "../runtime/repository.js";
import { enqueueManualTask, materializeFieldDueJobs, materializeStartupJobs, publishRuntimeEvent, replayRuntimeEvent } from "../runtime/triggers.js";
import type { JobDefinition, TaskResources } from "../runtime/domain.js";
import type { JsonObject } from "../core/types.js";

const local: TaskResources = { filesystem: "required", network: "not-required", codex: "not-required", user: "not-required" };
const base = (id: string, trigger: JsonObject): JobDefinition => ({ job_id: id, source: "core", module: "core", scope: "core", enabled: true, task_type: "core-operation", workflow: "core:test", trigger, resources: local, catch_up: { policy: "none" }, retry: { max_attempts: 2 }, concurrency: { policy: "forbid", key: id }, idempotency: {}, priority: "normal", updated_at: new Date().toISOString() });
const eventJob = (id: string, module: string, scope: JobDefinition["scope"], subscriptionScope: "instance" | "module" | "global", instanceId: string | null = null): JobDefinition => ({
  ...base(id, { type: "event", event: "application.updated", subscription_scope: subscriptionScope, ...(instanceId ? { instance_id: instanceId } : {}) }),
  source: "module", module, scope,
});

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
    const repeat = await publishRuntimeEvent(vault, { ...event, event_id: "EVT-same-fact-different-id" });
    assert.equal(repeat.event_deduplicated, true);
    assert.equal(repeat.created.length, 0);
    const manual = await enqueueManualTask(vault, "core.manual");
    const duplicateClick = await enqueueManualTask(vault, "core.manual");
    assert.equal(duplicateClick.task_id, manual.task_id); assert.equal(duplicateClick.deduplicated, true);
    const repo2 = await RuntimeRepository.open(vault);
    assert.equal(repo2.listEvents()[0]?.event_type, "capture.created");
    assert.equal(repo2.listEvents()[0]?.status, "published");
    assert.equal(typeof repo2.listEvents()[0]?.fingerprint, "string");
    assert.equal(repo2.listTasks().length, 3);
    repo2.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("Event Store preserves a dead-letter event for a failed dispatch", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-event-dead-letter-"));
  try {
    const repository = await RuntimeRepository.open(vault);
    const stored = repository.recordEvent({
      event_id: "EVT-dead-letter", event_type: "capture.created", module: "core", instance_id: null,
      occurred_at: new Date().toISOString(), fingerprint: "dead-letter-test", payload: {},
    });
    assert.equal(stored.created, true);
    repository.failEvent("EVT-dead-letter", { code: "EVENT_DISPATCH_FAILED", message: "fixture failure" });
    const event = repository.listEvents()[0]!;
    assert.equal(event.status, "dead-letter");
    assert.equal((event.error as JsonObject).code, "EVENT_DISPATCH_FAILED");
    repository.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("Event payloads retain only minimal identifiers in the Event Store and downstream Task", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-event-privacy-"));
  try {
    const repository = await RuntimeRepository.open(vault);
    repository.registerJob(base("core.private-event", { type: "event", event: "capture.private" }));
    repository.close();
    await publishRuntimeEvent(vault, {
      type: "capture.private", event_id: "EVT-private", payload: {
        capture_id: "CAP-private", path: "20-Workspace/private.md", run_id: "RUN-private",
        journal_body: "private journal body", extracted_text: "private attachment text", api_token: "secret-token", nested: { email_body: "also private" },
      },
    });
    const after = await RuntimeRepository.open(vault);
    const stored = after.getEvent("EVT-private")!;
    assert.deepEqual(stored.payload, { entity_id: "CAP-private", file_ref: "20-Workspace/private.md", run_id: "RUN-private" });
    const task = after.listTasks().find((item) => item.job_id === "core.private-event")!;
    assert.equal(JSON.stringify(task.payload).includes("private journal body"), false);
    assert.equal(JSON.stringify(task.payload).includes("secret-token"), false);
    after.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("Event subscriptions keep instance tasks isolated and audit both source and consumer instances", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-event-scope-"));
  try {
    const repository = await RuntimeRepository.open(vault);
    repository.registerJob(eventJob("application.consume.a", "application-tracker", "instance", "instance", "australia-masters-2027"));
    repository.registerJob(eventJob("application.consume.b", "application-tracker", "instance", "instance", "uk-masters-2027"));
    repository.registerJob(eventJob("application.module-audit", "application-tracker", "module", "module"));
    repository.registerJob(eventJob("other.module-audit", "other-module", "module", "module"));
    repository.registerJob(eventJob("core.explicit-global-audit", "core", "core", "global"));
    repository.close();

    const published = await publishRuntimeEvent(vault, {
      type: "application.updated", event_id: "EVT-application-a", module: "application-tracker", instance_id: "australia-masters-2027", payload: { entity_id: "APP-A" },
    });
    assert.equal(published.created.length, 3);
    const after = await RuntimeRepository.open(vault);
    const tasks = after.listTasks();
    const aTask = tasks.find((task) => task.job_id === "application.consume.a")!;
    assert.equal(aTask.instance_id, "australia-masters-2027");
    assert.equal(tasks.some((task) => task.job_id === "application.consume.b"), false);
    assert.equal(tasks.some((task) => task.job_id === "other.module-audit"), false);
    const moduleTask = tasks.find((task) => task.job_id === "application.module-audit")!;
    const globalTask = tasks.find((task) => task.job_id === "core.explicit-global-audit")!;
    for (const task of [aTask, moduleTask, globalTask]) {
      assert.equal(task.trigger.event_source_instance_id, "australia-masters-2027");
      assert.equal(task.trigger.event_source_module, "application-tracker");
      assert.equal(task.payload.event_source_instance_id, "australia-masters-2027");
    }
    assert.equal(aTask.trigger.event_consumer_instance_id, "australia-masters-2027");
    assert.equal(moduleTask.instance_id, null);
    assert.equal(moduleTask.trigger.event_consumer_instance_id, null);
    assert.equal(globalTask.instance_id, null);
    assert.equal(globalTask.trigger.event_subscription_scope, "global");
    after.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("Event replay preserves the original subscription scope instead of crossing into another instance", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-event-scope-replay-"));
  try {
    const repository = await RuntimeRepository.open(vault);
    repository.recordEvent({ event_id: "EVT-application-a-replay", event_type: "application.updated", module: "application-tracker", instance_id: "australia-masters-2027", occurred_at: new Date().toISOString(), fingerprint: "application-a-replay", payload: { entity_id: "APP-A" } });
    repository.failEvent("EVT-application-a-replay", { code: "EVENT_DISPATCH_FAILED", message: "fixture before ledger" });
    repository.registerJob(eventJob("application.replay.a", "application-tracker", "instance", "instance", "australia-masters-2027"));
    repository.registerJob(eventJob("application.replay.b", "application-tracker", "instance", "instance", "uk-masters-2027"));
    repository.registerJob(eventJob("core.replay.global", "core", "core", "global"));
    repository.close();

    const replay = await replayRuntimeEvent(vault, "EVT-application-a-replay");
    assert.equal(replay.created.length, 2);
    const after = await RuntimeRepository.open(vault);
    const tasks = after.listTasks();
    assert.equal(tasks.some((task) => task.job_id === "application.replay.b"), false);
    const replayTask = tasks.find((task) => task.job_id === "application.replay.a")!;
    assert.equal(replayTask.instance_id, "australia-masters-2027");
    assert.equal(replayTask.trigger.event_source_instance_id, "australia-masters-2027");
    assert.equal(replayTask.trigger.event_consumer_instance_id, "australia-masters-2027");
    assert.equal(after.listEventDeliveries("EVT-application-a-replay").length, 2);
    after.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("dead-letter replay rebuilds the Delivery Ledger when failure occurred before any delivery row", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-event-ledger-recovery-"));
  try {
    const repository = await RuntimeRepository.open(vault);
    repository.recordEvent({ event_id: "EVT-no-delivery", event_type: "capture.recover", module: "core", instance_id: null, occurred_at: new Date().toISOString(), fingerprint: "no-delivery", payload: { entity_id: "CAP-recover" } });
    repository.failEvent("EVT-no-delivery", { code: "EVENT_DISPATCH_FAILED", message: "failed before delivery ledger" });
    repository.registerJob(base("core.recover-event", { type: "event", event: "capture.recover" }));
    repository.close();
    const replay = await replayRuntimeEvent(vault, "EVT-no-delivery");
    assert.equal(replay.created.length, 1);
    const after = await RuntimeRepository.open(vault);
    assert.equal(after.getEvent("EVT-no-delivery")?.status, "published");
    assert.equal(after.listEventDeliveries("EVT-no-delivery").length, 1);
    assert.equal(after.listEventDeliveries("EVT-no-delivery")[0]?.status, "created");
    after.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("Event Delivery Ledger records a failed subscription and replays only that delivery", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-event-replay-"));
  try {
    const repository = await RuntimeRepository.open(vault);
    repository.registerJob(base("core.replay", { type: "event", event: "capture.replay" }));
    repository.close();
    const published = await publishRuntimeEvent(vault, { type: "capture.replay", event_id: "EVT-replay", payload: { capture_id: "CAP-REPLAY" } });
    const taskId = published.created[0]!;
    const before = await RuntimeRepository.open(vault);
    before.transitionTask(taskId, "running"); before.transitionTask(taskId, "failed");
    before.finishEventDelivery("EVT-replay", "core.replay", "failed", taskId, { code: "FIXTURE", message: "delivery failed after task creation" });
    before.completeEvent("EVT-replay", [taskId], "dead-letter", { code: "FIXTURE", message: "fixture failure" });
    before.close();

    const replay = await replayRuntimeEvent(vault, "EVT-replay", ["core.replay"]);
    assert.deepEqual(replay.requeued, [taskId]);
    const after = await RuntimeRepository.open(vault);
    assert.equal(after.getEvent("EVT-replay")?.status, "published");
    assert.equal(after.getTask(taskId)?.status, "queued");
    const delivery = after.listEventDeliveries("EVT-replay")[0]!;
    assert.equal(delivery.status, "requeued");
    assert.equal(Number(delivery.attempts), 1);
    after.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("daily startup jobs deduplicate restarts within the configured business day", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-daily-startup-"));
  try {
    const repository = await RuntimeRepository.open(vault);
    repository.registerJob(base("core.daily-start", { type: "startup", dedupe: "daily", timezone: "Asia/Shanghai" }));
    repository.close();

    const first = await materializeStartupJobs(vault, "boot-1", new Date("2026-08-01T00:30:00Z"));
    const sameBusinessDay = await materializeStartupJobs(vault, "boot-2", new Date("2026-08-01T12:30:00Z"));
    const nextBusinessDay = await materializeStartupJobs(vault, "boot-3", new Date("2026-08-01T16:30:00Z"));

    assert.equal(first.created.length, 1);
    assert.equal(sameBusinessDay.deduplicated, 1);
    assert.equal(nextBusinessDay.created.length, 1);
    const repo2 = await RuntimeRepository.open(vault);
    const tasks = repo2.listTasks();
    assert.equal(tasks.length, 2);
    assert.deepEqual(new Set(tasks.map((task) => task.trigger.window)), new Set([
      "2026-08-01@Asia/Shanghai",
      "2026-08-02@Asia/Shanghai",
    ]));
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
