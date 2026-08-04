import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseMarkdown } from "../core/bridge.js";
import { exists, listFilesRecursive, readJson } from "../core/files.js";
import type { JsonObject } from "../core/types.js";
import { initializeVault } from "../core/vault.js";
import { invokeCommandApi } from "../platform/commandApi.js";
import { materializeInboxAiTasks } from "../platform/inboxWorkflow.js";
import { RuntimeRepository } from "../runtime/repository.js";

async function writeCapture(vault: string, filename: string, frontmatter: string[], body = "Inbox test"): Promise<string> {
  const target = path.join(vault, "00-Inbox", filename);
  await fs.writeFile(target, ["---", ...frontmatter, "---", "", body, ""].join("\n"), "utf8");
  return target;
}

test("Inbox Center discovers only managed inboxes and explains routing without writing", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-inbox-list-"));
  try {
    await initializeVault(vault, "disabled");
    await fs.mkdir(path.join(vault, "20-Workspace", "Experience Log", "Inbox"), { recursive: true });
    await writeCapture(vault, "routed.md", ["type: capture", "title: Routed", "source_module: experience-log", "instance_id: null", "content_type: log"]);
    await writeCapture(vault, "unknown.md", ["type: note", "title: Unknown"]);
    await fs.writeFile(path.join(vault, "30-Knowledge", "not-managed.md"), "not an inbox item", "utf8");

    const listed = await invokeCommandApi({ vaultRoot: vault, requestId: "LIST-1", method: "listInboxItems", params: {} });
    assert.equal(listed.ok, true);
    const listing = listed.data as JsonObject;
    const items = listing.items as JsonObject[];
    assert.equal(items.length, 2);
    assert.equal(items.some((item) => item.path === "30-Knowledge/not-managed.md"), false);
    const routed = items.find((item) => item.title === "Routed")!;
    assert.equal(routed.suggested_module_id, "experience-log");
    assert.equal(routed.confidence, 0.95);
    const unknown = items.find((item) => item.title === "Unknown")!;
    assert.equal(unknown.state, "waiting-for-user");

    const center = await invokeCommandApi({ vaultRoot: vault, requestId: "CENTER-1", method: "getInboxCenterSnapshot", params: {} });
    assert.equal(center.ok, true);
    const centerData = center.data as JsonObject;
    assert.equal(((centerData.inbox as JsonObject).items as JsonObject[]).length, 2);
    assert.equal((centerData.modules as JsonObject[]).every((module) => module.status === "enabled"), true);
    assert.equal((centerData.modules as JsonObject[]).every((module) => !("health" in module)), true);

    const before = (await listFilesRecursive(path.join(vault, "90-System", "State", "Plans"))).length;
    const preview = await invokeCommandApi({ vaultRoot: vault, requestId: "PREVIEW-1", method: "processInboxItem", params: { item_id: String(routed.item_id), action: "preview" } });
    assert.equal(preview.ok, true);
    assert.equal((preview.data as JsonObject).status, "preview");
    assert.equal(((preview.data as JsonObject).operation_summary as JsonObject).estimated_operations, 1);
    assert.equal((await listFilesRecursive(path.join(vault, "90-System", "State", "Plans"))).length, before);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test("Inbox routing uses an Operation Plan and module items wait for Codex instead of pretending success", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-inbox-route-"));
  try {
    await initializeVault(vault, "disabled");
    await fs.mkdir(path.join(vault, "20-Workspace", "Experience Log", "Inbox"), { recursive: true });
    await writeCapture(vault, "daily-note.md", ["type: capture", "title: Daily note", "source_module: experience-log", "instance_id: null", "content_type: log"]);
    const firstList = await invokeCommandApi({ vaultRoot: vault, requestId: "LIST-2", method: "listInboxItems", params: {} });
    const item = ((firstList.data as JsonObject).items as JsonObject[])[0]!;
    const routed = await invokeCommandApi({ vaultRoot: vault, requestId: "ROUTE-1", method: "processInboxItem", params: { item_id: String(item.item_id), action: "process" } });
    assert.equal(routed.ok, true);
    assert.equal((routed.data as JsonObject).status, "routed");
    assert.equal(await exists(path.join(vault, "00-Inbox", "daily-note.md")), false);
    const destination = path.join(vault, "20-Workspace", "Experience Log", "Inbox", "daily-note.md");
    assert.equal(await exists(destination), true);
    assert.equal(typeof (routed.data as JsonObject).plan_id, "string");
    assert.equal(typeof (routed.data as JsonObject).run_id, "string");

    const secondList = await invokeCommandApi({ vaultRoot: vault, requestId: "LIST-3", method: "listInboxItems", params: {} });
    const moduleItem = ((secondList.data as JsonObject).items as JsonObject[])[0]!;
    assert.equal(moduleItem.state, "waiting-for-ai");
    const waitingToday = await invokeCommandApi({ vaultRoot: vault, requestId: "TODAY-WAITING-AI", method: "getTodayItems", params: {} });
    assert.equal(waitingToday.ok, true);
    assert.equal((((waitingToday.data as JsonObject).focus as JsonObject[]) ?? []).some((entry) => entry.target === moduleItem.path), false);
    const process = await invokeCommandApi({ vaultRoot: vault, requestId: "PROCESS-2", method: "processInboxItem", params: { item_id: String(moduleItem.item_id), action: "process" } });
    assert.equal(process.ok, true);
    assert.equal(process.state, "waiting-for-ai");
    assert.equal((process.data as JsonObject).status, "waiting-for-ai");
    assert.equal(parseMarkdown(vault, destination).content.includes("Inbox test"), true);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test("application Inbox AI work creates one durable Task and repeated Continue reuses it", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-inbox-ai-task-"));
  try {
    await initializeVault(vault, "disabled");
    const instanceDirectory = path.join(vault, "90-System", "Instances", "applications-2027");
    await fs.mkdir(instanceDirectory, { recursive: true });
    await fs.writeFile(path.join(instanceDirectory, "instance.yaml"), [
      "instance_id: applications-2027", "module_id: application-tracker", "status: active", "display_name: Applications 2027",
      "content_root: 20-Workspace/Applications/applications-2027", "inbox_path: 20-Workspace/Applications/applications-2027/Inbox",
      'created: "2026-08-03T00:00:00Z"', 'updated: "2026-08-03T00:00:00Z"', "",
    ].join("\n"), "utf8");
    const inbox = path.join(vault, "20-Workspace", "Applications", "applications-2027", "Inbox");
    await fs.mkdir(inbox, { recursive: true });
    await fs.writeFile(path.join(inbox, "unstructured-report.md"), "---\ntitle: Application research\n---\n\nOfficial facts to normalize.\n", "utf8");

    const materialized = await materializeInboxAiTasks(vault, "gpt-5.6-terra", "high");
    assert.equal(materialized.created.length, 1);
    const listed = await invokeCommandApi({ vaultRoot: vault, requestId: "AI-LIST", method: "listInboxItems", params: {} });
    const item = ((listed.data as JsonObject).items as JsonObject[])[0]!;
    assert.equal(item.state, "waiting-for-ai");
    assert.equal(typeof item.task_id, "string");
    let repository = await RuntimeRepository.open(vault);
    assert.equal(repository.getTask(String(item.task_id))?.payload.codex_model, "gpt-5.6-terra");
    assert.equal(repository.getTask(String(item.task_id))?.payload.codex_reasoning_effort, "high");
    repository.close();

    const first = await invokeCommandApi({ vaultRoot: vault, requestId: "AI-CONTINUE-1", method: "processInboxItem", params: { item_id: String(item.item_id), action: "process" } });
    const second = await invokeCommandApi({ vaultRoot: vault, requestId: "AI-CONTINUE-2", method: "processInboxItem", params: { item_id: String(item.item_id), action: "process" } });
    assert.equal((first.data as JsonObject).task_id, item.task_id);
    assert.equal((second.data as JsonObject).task_id, item.task_id);
    repository = await RuntimeRepository.open(vault);
    assert.equal(repository.listTasks().filter((task) => task.payload.item_id === item.item_id).length, 1);
    repository.close();
    const again = await materializeInboxAiTasks(vault, "gpt-5.6-terra", "high");
    assert.equal(again.created.length, 0);
    assert.equal(again.deduplicated, 1);

    const changedProfile = await materializeInboxAiTasks(vault, "gpt-5.4", "medium");
    assert.equal(changedProfile.created.length, 1);
    repository = await RuntimeRepository.open(vault);
    assert.equal(repository.getTask(changedProfile.created[0]!)?.payload.codex_model, "gpt-5.4");
    assert.equal(repository.getTask(changedProfile.created[0]!)?.payload.codex_reasoning_effort, "medium");
    repository.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("empty Inbox copies never reach Codex and can be moved to the recovery area", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-inbox-empty-"));
  try {
    await initializeVault(vault, "disabled");
    const instanceId = "empty-application";
    const created = await invokeCommandApi({
      vaultRoot: vault, requestId: "EMPTY-INSTANCE", method: "createInstance",
      params: { module_id: "application-tracker", instance_id: instanceId, display_name: "Empty application", fields: { application_type: "masters", region: "Australia", intake: "2027-S1", default_currency: "AUD" } },
    });
    assert.equal(created.ok, true);
    const inbox = path.join(vault, "20-Workspace", "Applications", instanceId, "Inbox");
    const source = path.join(inbox, "stale-copy.md");
    await fs.writeFile(source, "", "utf8");
    await fs.writeFile(path.join(inbox, "normalized-empty-copy.md"), [
      "---", "research_type: application-update", "institution: unknown", "program_name: unknown", "confidence: 0", "sources:", "  - source_type: unknown",
      "generation:", "  prompt:", "    id: normalize-application-report", "---", "",
    ].join("\n"), "utf8");

    const listed = await invokeCommandApi({ vaultRoot: vault, requestId: "EMPTY-LIST", method: "listInboxItems", params: {} });
    assert.equal(listed.ok, true);
    const item = ((listed.data as JsonObject).items as JsonObject[]).find((candidate) => candidate.path === `20-Workspace/Applications/${instanceId}/Inbox/stale-copy.md`)!;
    assert.equal(item.state, "empty");
    assert.match(String(item.error), /没有可处理的正文内容/);
    const artifact = ((listed.data as JsonObject).items as JsonObject[]).find((candidate) => candidate.path === `20-Workspace/Applications/${instanceId}/Inbox/normalized-empty-copy.md`)!;
    assert.equal(artifact.state, "empty");
    assert.ok((artifact.reasons as string[]).includes("empty-normalization-artifact"));

    const materialized = await materializeInboxAiTasks(vault, "gpt-5.6-terra", "medium");
    assert.equal(materialized.checked, 0);
    const preview = await invokeCommandApi({ vaultRoot: vault, requestId: "EMPTY-PREVIEW", method: "processInboxItem", params: { item_id: String(item.item_id), action: "preview" } });
    assert.equal(preview.ok, true);
    assert.equal(((preview.data as JsonObject).operation_summary as JsonObject).kind, "quarantine-empty-inbox-file");

    const process = await invokeCommandApi({ vaultRoot: vault, requestId: "EMPTY-PROCESS", method: "processInboxItem", params: { item_id: String(item.item_id), action: "process" } });
    assert.equal(process.ok, false);
    assert.equal(process.error?.code, "INBOX_EMPTY_SOURCE");

    const quarantined = await invokeCommandApi({ vaultRoot: vault, requestId: "EMPTY-QUARANTINE", method: "processInboxItem", params: { item_id: String(item.item_id), action: "quarantine-empty" } });
    assert.equal(quarantined.ok, true);
    assert.equal((quarantined.data as JsonObject).status, "quarantined-empty-source");
    assert.equal(await exists(source), false);
    const destination = path.join(vault, String((quarantined.data as JsonObject).destination));
    assert.equal(await exists(destination), true);
    assert.equal((await fs.stat(destination)).size, 0);
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("Inbox defer, ignore and explicit high-confidence batch preserve low-confidence work", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-inbox-batch-"));
  try {
    await initializeVault(vault, "disabled");
    await fs.mkdir(path.join(vault, "20-Workspace", "Experience Log", "Inbox"), { recursive: true });
    await writeCapture(vault, "high.md", ["type: capture", "title: High", "source_module: experience-log", "instance_id: null", "content_type: log"]);
    await writeCapture(vault, "low.md", ["type: note", "title: Low"]);
    const listing = await invokeCommandApi({ vaultRoot: vault, requestId: "LIST-4", method: "listInboxItems", params: {} });
    const items = (listing.data as JsonObject).items as JsonObject[];
    const high = items.find((item) => item.title === "High")!;
    const low = items.find((item) => item.title === "Low")!;

    const missingExplicit = await invokeCommandApi({ vaultRoot: vault, requestId: "BATCH-EMPTY", method: "processInboxBatch", params: { mode: "high-confidence", item_ids: [] } });
    assert.equal(missingExplicit.ok, false);
    const batch = await invokeCommandApi({ vaultRoot: vault, requestId: "BATCH-1", method: "processInboxBatch", params: { mode: "high-confidence", item_ids: [String(high.item_id), String(low.item_id)] } });
    assert.equal(batch.ok, true);
    assert.equal((batch.data as JsonObject).completed, 1);
    assert.equal((batch.data as JsonObject).skipped, 1);
    assert.equal(await exists(path.join(vault, "00-Inbox", "low.md")), true);

    const after = await invokeCommandApi({ vaultRoot: vault, requestId: "LIST-5", method: "listInboxItems", params: {} });
    const lowAfter = ((after.data as JsonObject).items as JsonObject[]).find((item) => item.title === "Low")!;
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const deferred = await invokeCommandApi({ vaultRoot: vault, requestId: "DEFER-1", method: "processInboxItem", params: { item_id: String(lowAfter.item_id), action: "defer", review_after: future } });
    assert.equal(deferred.ok, true);
    const ignored = await invokeCommandApi({ vaultRoot: vault, requestId: "IGNORE-1", method: "processInboxItem", params: { item_id: String(lowAfter.item_id), action: "ignore" } });
    assert.equal(ignored.ok, true);
    const state = await readJson<JsonObject | null>(path.join(vault, "90-System", "State", "Inbox", `${String(lowAfter.item_id)}.json`), null);
    assert.equal(state?.state, "ignored");
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test("Inbox and Review refreshes preserve rendered content after their first load", async () => {
  const source = await fs.readFile(path.resolve("plugins", "knowledgeos-obsidian", "main.js"), "utf8");
  const reviewSource = source.slice(source.indexOf("class ReviewCenterView"), source.indexOf("class InboxCenterView"));
  const inboxSource = source.slice(source.indexOf("class InboxCenterView"), source.indexOf("function rollbackLabel"));

  assert.match(reviewSource, /this\.loadPromise = null/);
  assert.match(reviewSource, /const preserveContent = Array\.isArray\(this\.reviews\)/);
  assert.match(reviewSource, /if \(preserveContent\) this\.renderReviewBackgroundStatus\("更新中…"\)/);
  assert.match(reviewSource, /else renderLoadingSkeleton\(this\.listEl, "正在加载审核事项…"\)/);

  assert.match(inboxSource, /this\.refreshPromise = null/);
  assert.match(inboxSource, /invoke\("getInboxCenterSnapshot"/);
  assert.doesNotMatch(inboxSource, /invoke\("getModules"/);
  assert.doesNotMatch(inboxSource, /invoke\("getInstances"/);
  assert.doesNotMatch(inboxSource, /invoke\("listInboxItems"/);
  assert.match(inboxSource, /const preserveContent = this\.listing !== null/);
  assert.match(inboxSource, /if \(preserveContent\) this\.renderBackgroundStatus\("更新中…"\)/);
  assert.match(inboxSource, /else renderLoadingSkeleton\(root, "正在加载 Inbox…"\)/);
  assert.match(inboxSource, /blocked_by_open_editor/);
  assert.match(inboxSource, /已关闭，继续/);
  assert.match(source, /getOpenMarkdownPaths\(\)/);
  assert.match(source, /obsidian_open_paths: this\.getOpenMarkdownPaths\(\)/);
});
