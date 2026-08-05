import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeMarkdown } from "../core/bridge.js";
import { initializeVault } from "../core/vault.js";
import { createModuleWorkflowRunner } from "../modules/workflowRunner.js";
import { createInstance } from "../platform/lifecycleWorkflow.js";
import { dispatchOnce } from "../runtime/dispatcher.js";
import { RuntimeRepository } from "../runtime/repository.js";

function experienceEntry(instanceId: string, entryId: string, occurredAt: string, sourcePath: string) {
  return {
    entry_id: entryId, type: "experience-entry", instance_id: instanceId, occurred_at: occurredAt,
    raw_text: `Work completed for ${entryId}.`, project: null, tags: [], source_path: sourcePath,
    captured_at: occurredAt, schema_version: 1,
  };
}

test("daily query uses the Capture business day and rejects matching entries without occurred_at", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-document-query-daily-"));
  try {
    await initializeVault(vault, "disabled");
    const instanceId = "internship-query-2026";
    await createInstance(vault, {
      module_id: "experience-log", instance_id: instanceId, display_name: "Query test",
      fields: { organization: "Example", role: "Intern", start_date: "2026-01-01", end_date: null, timezone: "Asia/Shanghai" },
    });
    const inboxRoot = `20-Workspace/Experience Log/${instanceId}/Inbox`;
    const monday = `${inboxRoot}/monday.md`;
    const tuesday = `${inboxRoot}/tuesday.md`;
    const friday = `${inboxRoot}/friday.md`;
    for (const [relativePath, entryId, occurredAt] of [
      [monday, "EXP-2026-000001", "2026-07-27T09:00:00+08:00"],
      [tuesday, "EXP-2026-000002", "2026-07-28T09:00:00+08:00"],
      [friday, "EXP-2026-000003", "2026-07-31T09:00:00+08:00"],
    ] as const) {
      const absolute = path.join(vault, ...relativePath.split("/"));
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      writeMarkdown(vault, absolute, { data: experienceEntry(instanceId, entryId, occurredAt, relativePath), content: `# ${entryId}\n` });
    }
    const repository = await RuntimeRepository.open(vault);
    const task = repository.createTask({
      job_id: "experience-log.daily-query", module: "experience-log", instance_id: instanceId, task_type: "workflow", workflow: "experience-log:build-daily-log", priority: "normal",
      scheduled_for: "2026-07-31T10:00:00.000Z", resources: { filesystem: "required", network: "not-required", codex: "required", user: "not-required" },
      trigger: { type: "manual", workflow_id: "build-daily-log", workflow_version: "1.0.0" }, catch_up_policy: "none", idempotency_key: "experience-log:daily-query:old-entry",
      payload: { source_file: monday },
    }).task;
    repository.setResourceStatus({ resource: "codex", status: "available", reason: null, checked_at: new Date().toISOString(), details: { test: true } });
    repository.close();

    let approvedInputs: string[] = [];
    const output = {
      daily_id: "DAY-2026-07-27", type: "experience-daily-log", instance_id: instanceId, date: "2026-07-27", entry_ids: ["EXP-2026-000001"],
      accomplishments: ["Completed Monday work"], blockers: [], learnings: [], next_actions: [], source_refs: [monday], created_at: "2026-07-31T10:00:00+08:00", schema_version: 1,
    };
    const dispatched = await dispatchOnce({ vaultRoot: vault, limit: 1, moduleWorkflowHandler: createModuleWorkflowRunner(async (options) => {
      const manifest = JSON.parse(await fs.readFile(path.join(options.contextRoot, "context-manifest.json"), "utf8")) as { primary_input: { source_path: string }; related_inputs: Array<{ source_path: string }> };
      approvedInputs = [manifest.primary_input.source_path, ...manifest.related_inputs.map((item) => item.source_path)];
      return { output, stderr: "" };
    }) });
    assert.equal(dispatched.completed, 1, JSON.stringify(dispatched.tasks[0]?.last_error));
    assert.deepEqual(approvedInputs, [monday]);
    await fs.access(path.join(vault, "20-Workspace", "Experience Log", instanceId, "Daily", "2026-07-27.md"));
    await assert.rejects(fs.access(path.join(vault, "20-Workspace", "Experience Log", instanceId, "Daily", "2026-07-31.md")));

    const missing = `${inboxRoot}/missing-date.md`;
    writeMarkdown(vault, path.join(vault, ...missing.split("/")), { data: { entry_id: "EXP-2026-000004", type: "experience-entry", instance_id: instanceId }, content: "# Missing date\n" });
    const repositoryAfter = await RuntimeRepository.open(vault);
    repositoryAfter.createTask({
      job_id: "experience-log.daily-query", module: "experience-log", instance_id: instanceId, task_type: "workflow", workflow: "experience-log:build-daily-log", priority: "normal",
      scheduled_for: "2026-07-31T10:00:00.000Z", resources: { filesystem: "required", network: "not-required", codex: "required", user: "not-required" },
      trigger: { type: "manual", workflow_id: "build-daily-log", workflow_version: "1.0.0" }, catch_up_policy: "none", idempotency_key: "experience-log:daily-query:missing-date",
      payload: { source_file: monday },
    });
    repositoryAfter.close();
    const failed = await dispatchOnce({ vaultRoot: vault, limit: 1, moduleWorkflowHandler: createModuleWorkflowRunner(async () => ({ output, stderr: "" })) });
    assert.equal(failed.failed, 1);
    assert.equal(failed.tasks[0]?.last_error?.code, "MODULE_QUERY_TIME_MISSING");
    const completedRepository = await RuntimeRepository.open(vault);
    assert.equal(completedRepository.getTask(task.task_id)?.status, "completed");
    completedRepository.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("reading weekly query filters by created week rather than scanning historical notes", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-document-query-reading-"));
  try {
    await initializeVault(vault, "disabled");
    const instanceId = "reading-query-2026";
    await createInstance(vault, { module_id: "reading-log", instance_id: instanceId, display_name: "Reading query", fields: { timezone: "Asia/Shanghai" } });
    const notesRoot = `20-Workspace/Reading Log/${instanceId}/Notes`;
    const current = `${notesRoot}/current.md`;
    const old = `${notesRoot}/old.md`;
    for (const [relativePath, id, created] of [[current, "READ-current", "2026-08-04T09:00:00+08:00"], [old, "READ-old", "2026-07-20T09:00:00+08:00"]] as const) {
      const absolute = path.join(vault, ...relativePath.split("/"));
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      writeMarkdown(vault, absolute, { data: { id, type: "reading-note", schema_id: "record", schema_version: 1, module_version: "0.1.0", instance_id: instanceId, title: id, source_refs: [], created, updated: created }, content: `# ${id}\n` });
    }
    const repository = await RuntimeRepository.open(vault);
    repository.createTask({
      job_id: "reading-log.weekly", module: "reading-log", instance_id: instanceId, task_type: "workflow", workflow: "reading-log:weekly-summary", priority: "normal",
      scheduled_for: "2026-08-04T10:00:00.000Z", resources: { filesystem: "required", network: "not-required", codex: "required", user: "not-required" },
      trigger: { type: "weekly", workflow_id: "weekly-summary", workflow_version: "1.0.0" }, catch_up_policy: "latest", idempotency_key: "reading-log:weekly-query:2026-W32",
    });
    repository.setResourceStatus({ resource: "codex", status: "available", reason: null, checked_at: new Date().toISOString(), details: { test: true } });
    repository.close();
    let approvedInputs: string[] = [];
    const output = { id: "READ-WEEK-32", type: "reading-weekly-summary", schema_id: "weekly-summary", schema_version: 1, module_version: "0.1.0", instance_id: instanceId, iso_week: "2026-W32", note_refs: [current], themes: [], questions: [], created: "2026-08-04T10:00:00+08:00" };
    const dispatched = await dispatchOnce({ vaultRoot: vault, limit: 1, moduleWorkflowHandler: createModuleWorkflowRunner(async (options) => {
      const manifest = JSON.parse(await fs.readFile(path.join(options.contextRoot, "context-manifest.json"), "utf8")) as { primary_input: { source_path: string }; related_inputs: Array<{ source_path: string }> };
      approvedInputs = [manifest.primary_input.source_path, ...manifest.related_inputs.map((item) => item.source_path)];
      return { output, stderr: "" };
    }) });
    assert.equal(dispatched.completed, 1, JSON.stringify(dispatched.tasks[0]?.last_error));
    assert.deepEqual(approvedInputs, [current]);
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});
