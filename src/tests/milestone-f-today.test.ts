import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { invokeCommandApi } from "../platform/commandApi.js";
import { buildTodaySnapshot, writeTodayMarkdown } from "../core/dashboard.js";
import { initializeVault } from "../core/vault.js";
import type { DashboardItem } from "../core/types.js";

function item(id: number, overrides: Partial<DashboardItem> = {}): DashboardItem {
  return {
    item_id: `DSH-TEST-${id}`,
    source_module: "test-module",
    instance_id: null,
    category: "action",
    priority: "medium",
    title: `Item ${id}`,
    description: "Test item",
    target: `00-Inbox/item-${id}.md`,
    due_at: null,
    actions: ["open"],
    created_at: `2026-07-${String(id).padStart(2, "0")}T00:00:00Z`,
    blocks_count: 0,
    active_context: true,
    ...overrides,
  };
}

test("Today uses one ranked, deduplicated snapshot and preserves the user area", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-today-"));
  try {
    await initializeVault(vault, "disabled");
    const inputs = [item(1, { priority: "critical" }), item(1, { priority: "critical" }), ...[2, 3, 4, 5, 6, 7].map((id) => item(id))];
    const snapshot = await buildTodaySnapshot(vault, inputs);
    assert.equal(snapshot.focus.length, 5);
    assert.equal(snapshot.focus[0]?.item_id, "DSH-TEST-1");
    assert.equal(snapshot.inbox.reduce((sum, group) => sum + group.count, 0), 7);

    await writeTodayMarkdown(vault, snapshot);
    const today = path.join(vault, "Today.md");
    const first = await fs.readFile(today, "utf8");
    await fs.writeFile(today, first.replace("<!-- knowledgeos:user:end -->", "保留这句话\n<!-- knowledgeos:user:end -->"), "utf8");
    await writeTodayMarkdown(vault, snapshot);
    const second = await fs.readFile(today, "utf8");
    assert.match(second, /保留这句话/);
    assert.equal((second.match(/## 今日重点/g) ?? []).length, 1);
    assert.equal((second.match(/\[\[00-Inbox\/item-1\]\]/g) ?? []).length, 1);
    assert.doesNotMatch(second, /## 异常与失败/);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test("missing Inbox items fail through the stable user-facing envelope", async () => {
  const response = await invokeCommandApi({
    vaultRoot: "unused",
    requestId: "REQ-TEST",
    method: "processInboxItem",
    params: { item_id: "INBOX-TEST" },
  });
  assert.equal(response.ok, false);
  assert.equal(response.state, "failed");
  assert.equal(response.error?.code, "INBOX_ITEM_NOT_FOUND");
  assert.equal(response.error?.technical_details !== undefined, true);
});

test("Obsidian UI delegates data access to the Core API", async () => {
  const plugin = await fs.readFile(path.resolve("plugins", "knowledgeos-obsidian", "main.js"), "utf8");
  for (const forbidden of ["node:fs", "Review Queue", "operationExecutor", "parseMarkdown", "git "]) {
    assert.equal(plugin.includes(forbidden), false, `plugin contains forbidden access: ${forbidden}`);
  }
  assert.match(plugin, /invoke\("getTodayItems"/);
  assert.match(plugin, /invoke\("createCapture"/);
  assert.match(plugin, /class ReviewCenterView/);
  assert.match(plugin, /invoke\("resolveReview"/);
  assert.match(plugin, /class InboxCenterView/);
  assert.match(plugin, /invoke\("listInboxItems"/);
  assert.match(plugin, /invoke\("processInboxItem"/);
  assert.match(plugin, /invoke\("processInboxBatch"/);
  assert.match(plugin, /class SystemCenterView/);
  assert.match(plugin, /invoke\("getRecentRuns"/);
  assert.match(plugin, /invoke\("getRunDetails"/);
  assert.match(plugin, /invoke\("rollbackRun"/);
  assert.match(plugin, /invoke\("manageModule"/);
  assert.match(plugin, /invoke\("createInstance"/);
  assert.match(plugin, /invoke\("manageInstance"/);
});
