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

function createMockBridge() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.stdin.on("data", (chunk) => {
    const request = JSON.parse(String(chunk));
    const data = request.method === "getModules"
      ? [{ id: "reading-log", ui: { display_name: "阅读记录" } }]
      : { method: request.method, echoed: request.params };
    child.stdout.write(`${JSON.stringify({ request_id: request.request_id, ok: true, data })}\n`);
  });
  return child;
}

test("CoreCommandClient sends requests through the persistent Command API bridge", async () => {
  const loadedModules = [];
  let spawnCount = 0;
  const client = new CoreCommandClient(
    { nodePath: "node", coreCliPath: "mock-cli.js", vaultPath: "mock-vault" },
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
