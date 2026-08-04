import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseMarkdown, writeMarkdown } from "../core/bridge.js";
import { initializeVault } from "../core/vault.js";
import { createInstance } from "../platform/lifecycleWorkflow.js";
import { createModuleWorkflowRunner } from "../modules/workflowRunner.js";
import { materializeInboxAiTasks } from "../platform/inboxWorkflow.js";
import { dispatchOnce } from "../runtime/dispatcher.js";
import { RuntimeRepository } from "../runtime/repository.js";

test("a declared experience-log workflow executes through the generic Runner without a platform Handler", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-module-workflow-runner-"));
  try {
    await initializeVault(vault, "disabled");
    const instanceId = "internship-2026";
    await createInstance(vault, {
      module_id: "experience-log", instance_id: instanceId, display_name: "Internship 2026",
      fields: { organization: "Example", role: "Intern", start_date: "2026-01-01", end_date: null, timezone: "Asia/Shanghai" },
    });
    const dailyPath = path.join(vault, "20-Workspace", "Experience Log", instanceId, "Daily", "2026-07-27.md");
    await fs.mkdir(path.dirname(dailyPath), { recursive: true });
    await fs.writeFile(dailyPath, [
      "---", "daily_id: DAY-2026-07-27", "type: experience-daily-log", `instance_id: ${instanceId}`, "date: 2026-07-27", "entry_ids: [EXP-2026-000001]",
      "accomplishments: [Implemented the workflow runner]", "blockers: []", "learnings: [Keep execution declarative]", "next_actions: [Add tests]",
      `source_refs: [20-Workspace/Experience Log/${instanceId}/Inbox/entry.md]`, "created_at: '2026-07-27T18:00:00+08:00'", "schema_version: 1", "---", "", "# Daily", "",
    ].join("\n"), "utf8");
    const output = {
      summary_id: "WEEK-2026-W31", type: "experience-weekly-summary", instance_id: instanceId, week: "2026-W31",
      period_start: "2026-07-27", period_end: "2026-08-02", daily_log_ids: ["DAY-2026-07-27"], highlights: ["Implemented the workflow runner"],
      progress: ["Module workflows now execute"], blockers: [], learnings: ["Use registries at runtime"], next_week: ["Add capture routing"],
      source_refs: [`20-Workspace/Experience Log/${instanceId}/Daily/2026-07-27.md`], created_at: "2026-07-31T18:00:00+08:00", schema_version: 1,
    };

    const repository = await RuntimeRepository.open(vault);
    const task = repository.createTask({
      job_id: `experience-log.weekly-summary.${instanceId}`, module: "experience-log", instance_id: instanceId,
      task_type: "workflow", workflow: "experience-log:weekly-summary", priority: "normal",
      scheduled_for: "2026-07-31T10:00:00.000Z",
      resources: { filesystem: "required", network: "not-required", codex: "required", user: "not-required" },
      trigger: { type: "weekly", workflow_id: "build-weekly-summary", workflow_version: "1.0.0", timezone: "Asia/Shanghai" },
      catch_up_policy: "latest", idempotency_key: "experience-log:internship-2026:weekly:2026-W31",
    }).task;
    repository.setResourceStatus({ resource: "codex", status: "available", reason: null, checked_at: new Date().toISOString(), details: { test: true } });
    repository.close();

    const runner = createModuleWorkflowRunner(async () => ({ output, stderr: "" }));
    const dispatched = await dispatchOnce({ vaultRoot: vault, limit: 1, moduleWorkflowHandler: runner });
    assert.equal(dispatched.completed, 1);
    const weeklyPath = path.join(vault, "20-Workspace", "Experience Log", instanceId, "Weekly", "2026-W31.md");
    assert.equal(parseMarkdown(vault, weeklyPath).data.type, "experience-weekly-summary");
    assert.equal((parseMarkdown(vault, weeklyPath).data.generation as { prompt?: { id?: string } }).prompt?.id, "weekly-summary");

    const after = await RuntimeRepository.open(vault);
    assert.equal(after.getTask(task.task_id)?.status, "completed");
    assert.equal(after.listCodexInvocations(task.task_id)[0]?.prompt_id, "weekly-summary");
    after.close();
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test("a workflow module Inbox item materializes a generic capture Task", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-module-workflow-inbox-"));
  try {
    await initializeVault(vault, "disabled");
    const instanceId = "internship-inbox-2026";
    await createInstance(vault, {
      module_id: "experience-log", instance_id: instanceId, display_name: "Internship Inbox",
      fields: { organization: "Example", role: "Intern", start_date: "2026-01-01", end_date: null, timezone: "Asia/Shanghai" },
    });
    const source = path.join(vault, "20-Workspace", "Experience Log", instanceId, "Inbox", "notes.md");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, "# Monday\n\nFinished the onboarding checklist and documented the deployment process.\n", "utf8");

    const materialized = await materializeInboxAiTasks(vault);
    assert.equal(materialized.created.length, 1);
    const repository = await RuntimeRepository.open(vault);
    const task = repository.getTask(materialized.created[0]!);
    assert.equal(task?.workflow, "module:experience-log:capture");
    assert.equal(task?.trigger.entrypoint, "capture");
    repository.close();
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test("a configuration module uses the same generic Runner for an Inbox capture", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-module-config-runner-"));
  try {
    await initializeVault(vault, "disabled");
    const instanceId = "reading-2026";
    await createInstance(vault, {
      module_id: "reading-log", instance_id: instanceId, display_name: "Reading 2026",
      fields: { timezone: "Asia/Shanghai" },
    });
    const sourceRelative = `20-Workspace/Reading Log/${instanceId}/Inbox/paper.md`;
    const source = path.join(vault, ...sourceRelative.split("/"));
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, "# A practical paper\n\nNotes about the paper's method and a question to revisit.\n", "utf8");

    const materialized = await materializeInboxAiTasks(vault);
    assert.equal(materialized.created.length, 1);
    const repository = await RuntimeRepository.open(vault);
    const task = repository.getTask(materialized.created[0]!);
    assert.equal(task?.workflow, "module:reading-log:capture");
    repository.setResourceStatus({ resource: "codex", status: "available", reason: null, checked_at: new Date().toISOString(), details: { test: true } });
    repository.close();

    const output = {
      id: "READ-2026-000001", type: "reading-note", schema_id: "record", schema_version: 1, module_version: "0.1.0", instance_id: instanceId,
      title: "A practical paper", source_refs: [sourceRelative], created: "2026-08-04T10:00:00+08:00", updated: "2026-08-04T10:00:00+08:00",
    };
    const dispatched = await dispatchOnce({ vaultRoot: vault, limit: 1, moduleWorkflowHandler: createModuleWorkflowRunner(async () => ({ output, stderr: "" })) });
    assert.equal(dispatched.completed, 1);
    const note = path.join(vault, "20-Workspace", "Reading Log", instanceId, "Notes", `${String(task!.payload.item_id)}.md`);
    assert.equal(parseMarkdown(vault, note).data.type, "reading-note");
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test("application due-research work runs as a declared module workflow without a Platform Handler", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-module-due-research-"));
  try {
    await initializeVault(vault, "disabled");
    const instanceId = "applications-2027";
    await createInstance(vault, {
      module_id: "application-tracker", instance_id: instanceId, display_name: "Applications 2027",
      fields: { application_type: "masters", region: "Australia", intake: "2027-S1", default_currency: "AUD", "monitoring.enabled": true, "monitoring.default_check_interval_days": 30 },
    });
    const record = path.join(vault, "20-Workspace", "Applications", instanceId, "Records", "Monash-C6007.md");
    await fs.mkdir(path.dirname(record), { recursive: true });
    writeMarkdown(vault, record, { data: {
      id: "APP-2027-0001", source_module: "application-tracker", instance_id: instanceId, type: "application-record",
      institution: "Monash University", program_name: "Master of Artificial Intelligence", program_code: "C6007", country: "AU", intake: "2027-S1", application_status: "watching",
      monitoring: { active: true, check_interval_days: 30, last_checked: null, next_check: "2020-01-01T00:00:00Z", stopped: [] }, facts: {}, source_files: [],
      created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z", schema_version: 1,
    }, content: "# Monash C6007\n" });
    const repository = await RuntimeRepository.open(vault);
    const task = repository.createTask({
      job_id: "application-tracker.due-research-check", module: "application-tracker", instance_id: null, task_type: "workflow", workflow: "module:application-tracker:sync-due-research", priority: "normal",
      resources: { filesystem: "required", network: "not-required", codex: "not-required", user: "not-required" },
      trigger: { type: "field-due", workflow_id: "sync-due-research", workflow_version: "1.0.0" }, catch_up_policy: "latest", idempotency_key: "application:due-research:test",
    }).task;
    repository.close();
    const dispatched = await dispatchOnce({ vaultRoot: vault, limit: 1 });
    assert.equal(dispatched.completed, 1);
    const requestRoot = path.join(vault, "20-Workspace", "Applications", instanceId, "Research Requests");
    assert.equal((await fs.readdir(requestRoot)).filter((file) => file.endsWith(".md")).length, 1);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});
