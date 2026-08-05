import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeVault } from "../core/vault.js";
import type { JsonObject } from "../core/types.js";
import { invokeCommandApi } from "../platform/commandApi.js";
import { registerDeclaredJobs } from "../runtime/jobRegistry.js";
import { RuntimeRepository } from "../runtime/repository.js";

test("Core and modules register standard Jobs without direct scheduler access", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-jobs-"));
  try {
    await initializeVault(vault, "disabled");
    const created = await invokeCommandApi({ vaultRoot: vault, requestId: "JOB-INSTANCE", method: "createInstance", params: {
      module_id: "experience-log", instance_id: "job-intern", display_name: "Job Internship",
      fields: { organization: "Example", role: "Engineer", start_date: "2026-07-01", end_date: null, timezone: "Asia/Shanghai" },
    } });
    assert.equal(created.ok, true);
    const jobs = await registerDeclaredJobs(vault);
    assert.equal(jobs.some((job) => job.job_id === "core.daily-today"), true);
    const startupToday = jobs.find((job) => job.job_id === "core.startup-today")!;
    assert.equal(startupToday.trigger.dedupe, "daily");
    assert.equal(startupToday.trigger.timezone, "Asia/Shanghai");
    assert.equal(jobs.some((job) => job.job_id === "application-tracker.due-research-check"), true);
    const weekly = jobs.find((job) => job.job_id === "experience-log.weekly-summary.job-intern")!;
    assert.equal(weekly.resources.codex, "required");
    assert.equal(weekly.resources.network, "not-required");
    assert.equal(weekly.trigger.timezone, "Asia/Shanghai");

    let repository = await RuntimeRepository.open(vault);
    const queued = repository.createTask({
      job_id: weekly.job_id, module: "experience-log", instance_id: "job-intern", task_type: "workflow", workflow: weekly.workflow,
      resources: weekly.resources, trigger: { type: "manual" }, catch_up_policy: "none", idempotency_key: "job-intern:queued",
    }).task;
    repository.close();
    const paused = await invokeCommandApi({ vaultRoot: vault, requestId: "JOB-PAUSE", method: "manageInstance", params: { instance_id: "job-intern", action: "pause" } });
    assert.equal(paused.ok, true, JSON.stringify(paused.error));
    repository = await RuntimeRepository.open(vault);
    assert.equal(repository.getTask(queued.task_id)?.status, "cancelled");
    assert.equal(repository.listJobs().find((job) => job.job_id === weekly.job_id)?.enabled, false);
    repository.close();
    const effects = (paused.data as JsonObject).task_effects as JsonObject;
    assert.equal((effects.cancelled as string[]).includes(queued.task_id), true);
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});
