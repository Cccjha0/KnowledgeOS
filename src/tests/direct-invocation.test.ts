import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeVault } from "../core/vault.js";
import { executeModuleWorkflowNow } from "../modules/directInvocation.js";
import { createInstance } from "../platform/lifecycleWorkflow.js";
import { RuntimeRepository } from "../runtime/repository.js";

test("Direct Invocation uses Workflow resources, Dispatcher gating, and source-content idempotency", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-direct-invocation-"));
  try {
    await initializeVault(vault, "disabled");
    const instanceId = "direct-application";
    await createInstance(vault, {
      module_id: "application-tracker", instance_id: instanceId, display_name: "Direct application",
      fields: { application_type: "masters", region: "Australia", intake: "2027-S1", default_currency: "AUD", "monitoring.enabled": true, "monitoring.default_check_interval_days": 30 },
    });
    const sourceFile = `20-Workspace/Applications/${instanceId}/Inbox/report.md`;
    const source = path.join(vault, ...sourceFile.split("/"));
    await fs.writeFile(source, "---\ninstance_id: direct-application\n---\n\nFirst report body.\n", "utf8");

    const first = await executeModuleWorkflowNow({ vaultRoot: vault, moduleId: "application-tracker", instanceId, entrypoint: "capture", sourceFile, codexExecutable: "knowledgeos-test-missing-codex" });
    assert.equal(first.resources.codex, "required");
    assert.equal(first.status, "waiting-for-ai");
    assert.equal(first.trigger.workflow_id, "process-research-report");
    assert.equal(first.trigger.workflow_version, "1.0.0");

    const repeat = await executeModuleWorkflowNow({ vaultRoot: vault, moduleId: "application-tracker", instanceId, entrypoint: "capture", sourceFile, codexExecutable: "knowledgeos-test-missing-codex" });
    assert.equal(repeat.task_id, first.task_id, "unchanged content must reuse the durable Task");

    await fs.writeFile(source, "---\ninstance_id: direct-application\n---\n\nChanged report body.\n", "utf8");
    const changed = await executeModuleWorkflowNow({ vaultRoot: vault, moduleId: "application-tracker", instanceId, entrypoint: "capture", sourceFile, codexExecutable: "knowledgeos-test-missing-codex" });
    assert.notEqual(changed.task_id, first.task_id, "changed content must create a new Task");
    const repository = await RuntimeRepository.open(vault);
    assert.equal(repository.listTasks().filter((task) => task.job_id === "application-tracker.direct-invocation").length, 2);
    repository.close();
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});
