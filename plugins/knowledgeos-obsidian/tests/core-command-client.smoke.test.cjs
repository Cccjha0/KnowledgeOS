const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const { CoreCommandClient } = require("../services/core-command-client");
const { createReviewCenterViews } = require("../views/review-center");
const { createInboxCenterViews } = require("../views/inbox-center");
const { createSystemCenterViews } = require("../views/system-center");
const { createTodayViews } = require("../views/today");
const { createSettingsViews } = require("../views/settings-tab");

function createMockBridge(onRequest) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.stdin.on("data", (chunk) => {
    const request = JSON.parse(String(chunk));
    if (onRequest) return onRequest(child, request);
    const data = request.method === "getModules"
      ? [{ id: "reading-log", ui: { display_name: "阅读记录" } }]
      : { method: request.method, echoed: request.params };
    child.stdout.write(`${JSON.stringify({ request_id: request.request_id, ok: true, data })}\n`);
  });
  return child;
}

const clientSettings = { nodePath: "node", coreCliPath: "mock-cli.js", vaultPath: "mock-vault" };

test("CoreCommandClient sends requests through the persistent Command API bridge", async () => {
  const loadedModules = [];
  let spawnCount = 0;
  const client = new CoreCommandClient(
    clientSettings,
    {
      spawn: () => {
        spawnCount += 1;
        return createMockBridge();
      },
      execFile: () => assert.fail("the persistent bridge should be used when it starts successfully"),
      onModulesLoaded: (modules) => loadedModules.push(...modules),
    },
  );

  const modules = await client.invoke("getModules", {});
  const health = await client.invoke("healthCheck", { scope: "plugin-smoke" });

  assert.equal(modules.ok, true);
  assert.equal(modules.data[0].id, "reading-log");
  assert.deepEqual(loadedModules, modules.data);
  assert.equal(health.ok, true);
  assert.deepEqual(health.data, { method: "healthCheck", echoed: { scope: "plugin-smoke" } });
  assert.equal(spawnCount, 1);
  client.close();
});

test("CoreCommandClient recovers from a Core API server restart", async () => {
  const bridges = [createMockBridge(), createMockBridge()];
  let spawnCount = 0;
  const client = new CoreCommandClient(clientSettings, {
    spawn: () => bridges[spawnCount++],
  });

  assert.equal((await client.invoke("healthCheck")).ok, true);
  bridges[0].emit("exit", 1);
  assert.equal((await client.invoke("healthCheck")).ok, true);
  assert.equal(spawnCount, 2);
  client.close();
});

test("CoreCommandClient times out stalled requests and removes them from pending", async () => {
  const client = new CoreCommandClient(clientSettings, {
    requestTimeoutMs: 10,
    spawn: () => createMockBridge(() => {}),
  });

  const response = await client.invoke("healthCheck");
  assert.equal(response.ok, false);
  assert.match(response.error.message, /timed out/i);
  assert.equal(client.pending.size, 0);
  client.close();
});

test("CoreCommandClient matches concurrent requests to their own responses", async () => {
  const client = new CoreCommandClient(clientSettings, {
    spawn: () => createMockBridge((bridge, request) => {
      const delay = request.params.order === 1 ? 10 : 0;
      setTimeout(() => bridge.stdout.write(`${JSON.stringify({ request_id: request.request_id, ok: true, data: request.params })}\n`), delay);
    }),
  });

  const [first, second] = await Promise.all([
    client.invoke("healthCheck", { order: 1 }),
    client.invoke("healthCheck", { order: 2 }),
  ]);
  assert.deepEqual(first.data, { order: 1 });
  assert.deepEqual(second.data, { order: 2 });
  assert.equal(client.pending.size, 0);
  client.close();
});

test("CoreCommandClient fails malformed JSON safely and starts a fresh bridge", async () => {
  const broken = createMockBridge((bridge) => bridge.stdout.write("not-json\n"));
  const healthy = createMockBridge();
  let spawnCount = 0;
  const client = new CoreCommandClient(clientSettings, {
    spawn: () => [broken, healthy][spawnCount++],
  });

  const malformed = await client.invoke("healthCheck");
  assert.equal(malformed.ok, false);
  assert.match(malformed.error.message, /malformed JSON/i);
  assert.equal(client.pending.size, 0);
  assert.equal((await client.invoke("healthCheck")).ok, true);
  assert.equal(spawnCount, 2);
  client.close();
});

test("CoreCommandClient clears pending requests when the plugin unloads", async () => {
  const client = new CoreCommandClient(clientSettings, {
    requestTimeoutMs: 1_000,
    spawn: () => createMockBridge(() => {}),
  });

  const request = client.invoke("healthCheck");
  assert.equal(client.pending.size, 1);
  client.close();
  const response = await request;
  assert.equal(response.ok, false);
  assert.match(response.error.message, /restarting/i);
  assert.equal(client.pending.size, 0);
});

test("CoreCommandClient gives a recoverable explanation when Core is not configured", async () => {
  const client = new CoreCommandClient({ nodePath: "node", coreCliPath: "", vaultPath: "" });
  const response = await client.invoke("healthCheck");

  assert.equal(response.ok, false);
  assert.match(response.error.impact, /Today/);
  assert.deepEqual(response.error.recovery_actions, ["打开 KnowledgeOS 设置并填写路径"]);
});

test("view factories expose the existing view and settings constructors", () => {
  class ItemView { constructor(leaf) { this.leaf = leaf; } }
  class Modal { constructor(app) { this.app = app; } }
  class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }
  class Setting {}
  const dependencies = {
    ItemView, Modal, Notice: class {}, PluginSettingTab, Setting, setIcon: () => {},
    VIEW_TYPE: "knowledgeos-today", REVIEW_VIEW_TYPE: "knowledgeos-review", INBOX_VIEW_TYPE: "knowledgeos-inbox", SYSTEM_VIEW_TYPE: "knowledgeos-system",
    settingsDefaults: {}, moduleUiMetadata: {}, manifestFormatters: {}, LIST_PAGE_SIZE: 50, FALLBACK_CODEX_MODELS: [], REASONING_LABELS: {},
    markLiveRegion: (value) => value, taskCycleChanged: () => false, shouldAutoRefreshPath: () => false, missingBuiltCliFailure: () => null,
    labelStatus: String, labelModule: String, labelJob: String, labelField: String, friendlyAction: String, calendarDayDifference: () => null, formatTime: String, formatVerificationSchedule: String, createTime: () => {},
    friendlyDashboardDescription: String, friendlyDashboardTitle: String, createToolbarButton: () => {}, renderLoadingSkeleton: () => {}, addCardArrow: () => {}, renderDeveloperDetails: () => {}, renderRecoverableError: () => {},
  };
  const constructors = {
    ...createReviewCenterViews(dependencies),
    ...createInboxCenterViews(dependencies),
    ...createSystemCenterViews(dependencies),
    ...createTodayViews(dependencies),
    ...createSettingsViews(dependencies),
  };

  assert.equal(typeof constructors.ReviewCenterView, "function");
  assert.equal(typeof constructors.InboxCenterView, "function");
  assert.equal(typeof constructors.SystemCenterView, "function");
  assert.equal(typeof constructors.TodayView, "function");
  assert.equal(typeof constructors.KnowledgeOSSettingTab, "function");
  assert.equal(new constructors.TodayView({}, {}).getViewType(), "knowledgeos-today");
  assert.equal(new constructors.InboxCenterView({}, {}).getViewType(), "knowledgeos-inbox");
  assert.equal(new constructors.ReviewCenterView({}, {}).getViewType(), "knowledgeos-review");
  assert.equal(new constructors.SystemCenterView({}, {}).getViewType(), "knowledgeos-system");
});
