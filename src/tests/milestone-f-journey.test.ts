import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CommandApiMethod } from "../api/types.js";
import { exists } from "../core/files.js";
import type { JsonObject } from "../core/types.js";
import { initializeVault } from "../core/vault.js";
import { invokeCommandApi } from "../platform/commandApi.js";

async function call(vaultRoot: string, requestId: string, method: CommandApiMethod, params: JsonObject = {}) {
  return invokeCommandApi({ vaultRoot, requestId, method, params });
}

test("Milestone F journey survives view reloads and safely rolls back a Capture", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-f-journey-"));
  try {
    await initializeVault(vault, "disabled");

    const instanceParams = {
      module_id: "experience-log", instance_id: "journey-intern", display_name: "Journey Internship",
      fields: { organization: "Example Org", role: "Engineer", start_date: "2026-07-28", end_date: null, timezone: "Asia/Shanghai" },
    };
    const preview = await call(vault, "JOURNEY-INSTANCE-PREVIEW", "createInstance", { ...instanceParams, preview_only: true });
    assert.equal(preview.ok, true);
    assert.equal((preview.data as JsonObject).status, "preview");
    const created = await call(vault, "JOURNEY-INSTANCE-CREATE", "createInstance", instanceParams);
    assert.equal(created.ok, true);

    const capture = await call(vault, "JOURNEY-CAPTURE", "createCapture", {
      instance_id: "journey-intern", content_type: "log", title: "First day", content: "Completed onboarding and recorded one blocker.",
    });
    assert.equal(capture.ok, true);
    const captureData = capture.data as JsonObject;
    const capturePath = String(captureData.path);
    assert.match(capturePath, /^20-Workspace\/Experience Log\/journey-intern\/Inbox\//);
    assert.equal(await exists(path.join(vault, ...capturePath.split("/"))), true);

    const firstInbox = await call(vault, "JOURNEY-INBOX-1", "listInboxItems");
    const item = ((firstInbox.data as JsonObject).items as JsonObject[]).find((entry) => entry.path === capturePath)!;
    assert.equal(item.state, "waiting-for-ai");
    const handedOff = await call(vault, "JOURNEY-HANDOFF", "processInboxItem", { item_id: String(item.item_id), action: "process" });
    assert.equal(handedOff.ok, true);
    assert.equal(handedOff.state, "waiting-for-ai");

    // A new API request represents a plugin/Core restart: durable Vault state must reconstruct the same work.
    const afterRestart = await call(vault, "JOURNEY-AFTER-RESTART", "listInboxItems");
    const restored = ((afterRestart.data as JsonObject).items as JsonObject[]).find((entry) => entry.path === capturePath)!;
    assert.equal(restored.state, "waiting-for-ai");

    const paused = await call(vault, "JOURNEY-PAUSE", "manageInstance", { instance_id: "journey-intern", action: "pause" });
    assert.equal(paused.ok, true);
    const pausedToday = await call(vault, "JOURNEY-TODAY-PAUSED", "getTodayItems", { refresh_markdown: false });
    assert.equal(((pausedToday.data as JsonObject).counts as JsonObject).inbox, 0);
    const rejectedCapture = await call(vault, "JOURNEY-CAPTURE-PAUSED", "createCapture", { preview_only: true, instance_id: "journey-intern" });
    assert.equal(rejectedCapture.ok, false);

    const resumed = await call(vault, "JOURNEY-RESUME", "manageInstance", { instance_id: "journey-intern", action: "resume" });
    assert.equal(resumed.ok, true);
    const resumedToday = await call(vault, "JOURNEY-TODAY-RESUMED", "getTodayItems", { refresh_markdown: false });
    assert.equal(Number(((resumedToday.data as JsonObject).counts as JsonObject).inbox) > 0, true);

    const rolledBack = await call(vault, "JOURNEY-ROLLBACK", "rollbackRun", { run_id: String(captureData.run_id) });
    assert.equal(rolledBack.ok, true);
    assert.equal((rolledBack.data as JsonObject).status, "rolled-back");
    assert.equal(await exists(path.join(vault, ...capturePath.split("/"))), false);
    const finalInbox = await call(vault, "JOURNEY-INBOX-FINAL", "listInboxItems");
    assert.equal(((finalInbox.data as JsonObject).items as JsonObject[]).some((entry) => entry.path === capturePath), false);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test("F07 plugin contract includes shortcuts, bounded lists, accessible status, and offline fallback", async () => {
  const source = await fs.readFile(path.resolve("plugins/knowledgeos-obsidian/main.js"), "utf8");
  const styles = await fs.readFile(path.resolve("plugins/knowledgeos-obsidian/styles.css"), "utf8");
  assert.match(source, /LIST_PAGE_SIZE = 50/);
  assert.match(source, /id: "quick-capture"[\s\S]*modifiers: \["Mod", "Shift"\]/);
  assert.match(source, /id: "open-today"[\s\S]*modifiers: \["Mod", "Shift"\]/);
  assert.match(source, /aria-live/);
  assert.match(source, /打开上次生成的 Today\.md/);
  assert.match(source, /notifyOnCompletion/);
  assert.match(source, /allowBatchOperations/);
  assert.doesNotMatch(source, /renderReviewList\(\) \{\s*this\.listEl\.empty\(\);\s*this\.renderReviewList/);
  assert.match(styles, /:focus-visible/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.equal(/require\(["'](?:node:)?fs/.test(source), false);
});
