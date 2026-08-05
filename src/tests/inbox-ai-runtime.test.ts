import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeMarkdown } from "../core/bridge.js";
import { exists, readJson, writeJsonAtomic } from "../core/files.js";
import type { JsonObject } from "../core/types.js";
import { initializeVault } from "../core/vault.js";
import { invokeCommandApi } from "../platform/commandApi.js";
import { createModuleWorkflowRunner } from "../modules/workflowRunner.js";
import { materializeInboxAiTasks } from "../platform/inboxWorkflow.js";
import { dispatchOnce } from "../runtime/dispatcher.js";
import { RuntimeRepository } from "../runtime/repository.js";

test("application Inbox AI Task completes through the managed Run and archives the report", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-inbox-ai-runtime-"));
  try {
    await initializeVault(vault, "disabled");
    const instanceId = "applications-2027";
    const created = await invokeCommandApi({
      vaultRoot: vault,
      requestId: "AI-INSTANCE",
      method: "createInstance",
      params: {
        module_id: "application-tracker",
        instance_id: instanceId,
        display_name: "Applications 2027",
        fields: {
          application_type: "masters",
          region: "Australia",
          intake: "2027-S1",
          default_currency: "AUD",
          "monitoring.enabled": true,
          "monitoring.default_check_interval_days": 30,
        },
      },
    });
    assert.equal(created.ok, true);

    const root = path.join(vault, "20-Workspace", "Applications", instanceId);
    const recordPath = path.join(root, "Records", "Monash-C6007.md");
    await fs.mkdir(path.dirname(recordPath), { recursive: true });
    writeMarkdown(vault, recordPath, {
      data: {
        id: "APP-2027-0001",
        source_module: "application-tracker",
        instance_id: instanceId,
        type: "application-record",
        institution: "Monash University",
        program_name: "Master of Artificial Intelligence",
        program_code: "C6007",
        country: "AU",
        intake: "2027-S1",
        application_status: "watching",
        monitoring: { active: true, check_interval_days: 30, last_checked: null, next_check: null, stopped: [] },
        facts: {},
        source_files: [],
        created: "2026-08-03T00:00:00Z",
        updated: "2026-08-03T00:00:00Z",
        schema_version: 1,
      },
      content: "# Monash C6007\n",
    });

    const sourcePath = path.join(root, "Inbox", "Monash-report.md");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, "---\ntitle: Monash research\ncourse_code: C6007\n---\n\nOfficial application facts.\n", "utf8");

    const materialized = await materializeInboxAiTasks(vault, "gpt-5.6-terra", "high");
    assert.equal(materialized.created.length, 1);
    const taskId = materialized.created[0]!;
    let repository = await RuntimeRepository.open(vault);
    const itemId = String(repository.getTask(taskId)?.payload.item_id);
    assert.equal(repository.getTask(taskId)?.workflow, "module:application-tracker:capture");
    repository.setResourceStatus({ resource: "codex", status: "available", reason: null, checked_at: new Date().toISOString(), details: { test: true } });
    repository.close();

    let receivedModel: string | undefined;
    let receivedReasoningEffort: string | undefined;
    const runner = createModuleWorkflowRunner(async (options) => {
      receivedModel = options.model;
      receivedReasoningEffort = options.reasoningEffort;
      return ({
      output: {
        institution: "Monash University",
        program_name: "Master of Artificial Intelligence",
        program_code: "C6007",
        intake: "2027 Semester 1 / February intake",
        checked_at: "2026-08-03T00:00:00Z",
        material_change: false,
        confidence: 0.95,
        sources: [{
          source_id: "SRC-001",
          source_type: "official-course-page",
          title: "Monash C6007 official course page",
          url: "https://www.monash.edu/study/courses/find-a-course/artificial-intelligence-c6007",
          accessed_at: "2026-08-03T00:00:00Z",
          notes: "Fixture source",
        }],
        findings: {},
        unresolved: [],
        summary: "No material change detected.",
      },
      stderr: "",
      });
    });
    const dispatched = await dispatchOnce({
      vaultRoot: vault,
      limit: 1,
      moduleWorkflowHandler: runner,
    });
    assert.equal(dispatched.completed, 1, JSON.stringify(dispatched.tasks));
    assert.equal(dispatched.failed, 0);
    assert.equal(receivedModel, "gpt-5.6-terra");
    assert.equal(receivedReasoningEffort, "high");

    repository = await RuntimeRepository.open(vault);
    assert.equal(repository.getTask(taskId)?.status, "completed");
    assert.equal(repository.getRuns(taskId).length, 1);
    assert.ok(repository.getRuns(taskId)[0]?.input_files.some((item) => item.endsWith("Records/Monash-C6007.md")), "Application Record lookup must not require a date field or time window.");
    assert.equal(repository.listCodexInvocations(taskId).length, 1);
    repository.close();
    assert.equal(await exists(sourcePath), false);
    assert.equal(await exists(path.join(root, "Research", "Monash-report.md")), true);

    const state = await readJson<JsonObject | null>(
      path.join(vault, "90-System", "State", "Inbox", `${itemId}.json`),
      null,
    );
    assert.equal(state?.state, "processed");
    assert.equal(state?.task_id, taskId);

    // Putting the exact processed report back into Inbox is a lifecycle event,
    // not a request for the user to repeat the review or for AI to normalize it again.
    const archivedPath = path.join(root, "Research", "Monash-report.md");
    await writeJsonAtomic(
      path.join(vault, "90-System", "State", "Inbox", `${itemId}.json`),
      { ...state!, updated_at: "2000-01-01T00:00:00Z" },
    );
    await fs.rename(archivedPath, sourcePath);
    const rematerialized = await materializeInboxAiTasks(vault, "gpt-5.6-terra", "high");
    assert.equal(rematerialized.created.length, 1);
    const restoreTaskId = rematerialized.created[0]!;
    repository = await RuntimeRepository.open(vault);
    assert.equal(repository.getTask(restoreTaskId)?.resources.codex, "not-required");
    repository.close();

    const restored = await dispatchOnce({
      vaultRoot: vault,
      limit: 1,
      moduleWorkflowHandler: runner,
    });
    assert.equal(restored.completed, 1);
    assert.equal(await exists(sourcePath), false);
    assert.equal(await exists(archivedPath), true);

    const today = await invokeCommandApi({ vaultRoot: vault, requestId: "TODAY-AFTER-RESTORE", method: "getTodayItems", params: {} });
    assert.equal(today.ok, true);
    const focus = ((today.data as JsonObject).focus as JsonObject[]) ?? [];
    assert.equal(focus.some((item) => item.title === "Process application Inbox item"), false);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});
