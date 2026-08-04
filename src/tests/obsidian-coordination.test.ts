import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PkbError } from "../core/errors.js";
import { readJson, writeJsonAtomic } from "../core/files.js";
import { initializeVault } from "../core/vault.js";
import { assertMoveSourceNotOpen, resumeTasksAfterObsidianFileClose, syncObsidianOpenFiles } from "../platform/obsidianCoordination.js";
import { dispatchOnce } from "../runtime/dispatcher.js";
import { RuntimeRepository } from "../runtime/repository.js";

test("an open Obsidian note blocks a move and its Task resumes only after a fresh close snapshot", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-obsidian-coordination-"));
  const sourceFile = "20-Workspace/Applications/demo/Inbox/report.md";
  try {
    await initializeVault(vault, "disabled");
    await syncObsidianOpenFiles(vault, [sourceFile]);
    await assert.rejects(
      () => assertMoveSourceNotOpen(vault, sourceFile),
      (error: unknown) => error instanceof PkbError && error.code === "OBSIDIAN_FILE_OPEN",
    );

    let repository = await RuntimeRepository.open(vault);
    const task = repository.createTask({
      job_id: "application.inbox-processing", module: "application-tracker", instance_id: "demo",
      task_type: "workflow", workflow: "test:move-open-file", priority: "normal",
      resources: { filesystem: "required", network: "not-required", codex: "not-required", user: "not-required" },
      trigger: { type: "inbox" }, catch_up_policy: "latest", idempotency_key: "coordination:open-file",
      payload: { source_file: sourceFile }, concurrency_key: "coordination:open-file", concurrency_policy: "forbid",
    }).task;
    repository.close();

    const blocked = await dispatchOnce({
      vaultRoot: vault,
      limit: 1,
      handlers: { "test:move-open-file": async () => { throw new PkbError("OBSIDIAN_FILE_OPEN", "Open in Obsidian"); } },
    });
    assert.equal(blocked.tasks[0]?.status, "waiting-for-user");
    repository = await RuntimeRepository.open(vault);
    assert.equal(repository.getTask(task.task_id)?.last_error?.code, "OBSIDIAN_FILE_OPEN");
    assert.equal(repository.getRuns(task.task_id)[0]?.status, "failed");
    repository.close();

    const statePath = path.join(vault, "90-System", "State", "obsidian-file-state.json");
    const staleSnapshot = await readJson<Record<string, unknown>>(statePath, {});
    await writeJsonAtomic(statePath, { ...staleSnapshot, observed_at: "2000-01-01T00:00:00.000Z" });
    assert.equal(await resumeTasksAfterObsidianFileClose(vault), 0);

    await syncObsidianOpenFiles(vault, []);
    assert.equal(await resumeTasksAfterObsidianFileClose(vault), 1);
    repository = await RuntimeRepository.open(vault);
    assert.equal(repository.getTask(task.task_id)?.status, "queued");
    repository.close();

    const resumed = await dispatchOnce({
      vaultRoot: vault,
      limit: 1,
      handlers: { "test:move-open-file": async () => ({ completion_reason: "moved-after-close" }) },
    });
    assert.equal(resumed.tasks[0]?.status, "completed");
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});
