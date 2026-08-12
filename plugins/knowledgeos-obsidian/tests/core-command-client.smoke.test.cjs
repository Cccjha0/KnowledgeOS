const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { CoreCommandClient } = require("../services/core-command-client");
const { LatestRequestGate } = require("../services/latest-request");
const { createReviewCenterViews } = require("../views/review-center");
const { createInboxCenterViews } = require("../views/inbox-center");
const { createSystemCenterViews } = require("../views/system-center");
const { createTodayViews } = require("../views/today");
const { createSettingsViews } = require("../views/settings-tab");
const { createModuleBuilderViews } = require("../views/module-builder-modal");
const { affectedKnowledgeViews, affectedKnowledgeViewsForPaths } = require("../services/view-refresh-policy");
const { rollbackLabel } = require("../components/rollback-modal");

test("Vault changes invalidate only the affected KnowledgeOS views", () => {
  assert.deepEqual(affectedKnowledgeViews("Today.md"), []);
  assert.deepEqual(affectedKnowledgeViews("90-System/Logs/run.md"), ["today", "system"]);
  assert.deepEqual(affectedKnowledgeViews("00-Inbox/capture.md"), ["today", "inbox"]);
  assert.deepEqual(affectedKnowledgeViews("20-Workspace/Reading/Inbox/book.pdf"), ["today", "inbox"]);
  assert.deepEqual(affectedKnowledgeViews("90-System/Review Queue/REV-1.md"), ["today", "reviews", "system"]);
  assert.deepEqual(affectedKnowledgeViews("90-System/State/Sidecars/asset.json"), ["today", "inbox"]);
  assert.deepEqual(affectedKnowledgeViews("90-System/State/Inbox/item.json"), ["today", "inbox"]);
  assert.deepEqual(affectedKnowledgeViews("20-Workspace/Courses/course-1/Assignments/A1.md"), ["today", "system"]);
  assert.deepEqual(affectedKnowledgeViewsForPaths([
    "90-System/Review Queue/Pending/REV-1.md", "00-Inbox/capture.md",
  ]), ["today", "reviews", "system", "inbox"]);
});

test("shared rollback presentation describes unavailable and confirmable recovery", () => {
  assert.equal(rollbackLabel({ can_rollback: false }), "不可自动撤销");
  assert.equal(rollbackLabel({ can_rollback: true, requires_confirmation: false }), "安全撤销");
  assert.equal(rollbackLabel({ can_rollback: true, requires_confirmation: true }), "撤销（需要确认）");
});

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

test("CoreCommandClient reaches the real Command API server with a temporary Vault", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-plugin-api-"));
  const cli = path.resolve(__dirname, "..", "..", "..", "dist", "cli.js");
  const client = new CoreCommandClient({ nodePath: process.execPath, coreCliPath: cli, vaultPath: vault }, { requestTimeoutMs: 15_000 });
  try {
    const first = await client.invoke("getModules", {}, "PLUGIN-REAL-001");
    assert.equal(first.ok, true);
    assert.equal(first.api_version, "1");
    assert.equal(first.request_id, "PLUGIN-REAL-001");
    assert.equal(first.method, "getModules");
    assert.equal(Array.isArray(first.data), true);
    const server = client.server;
    const exited = server ? once(server, "exit") : Promise.resolve();
    client.close();
    await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("Core API server did not exit.")), 5_000))]);
    const second = await client.invoke("getModules", {}, "PLUGIN-REAL-002");
    assert.equal(second.ok, true);
    assert.equal(second.request_id, "PLUGIN-REAL-002");
  } finally {
    client.close();
    await fs.rm(vault, { recursive: true, force: true });
  }
});

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
  const instances = await client.invoke("getInstances", { scope: "plugin-smoke" });

  assert.equal(modules.ok, true);
  assert.equal(modules.data[0].id, "reading-log");
  assert.deepEqual(loadedModules, modules.data);
  assert.equal(instances.ok, true);
  assert.deepEqual(instances.data, { method: "getInstances", echoed: { scope: "plugin-smoke" } });
  assert.equal(spawnCount, 1);
  client.close();
});

test("CoreCommandClient recovers from a Core API server restart", async () => {
  const bridges = [createMockBridge(), createMockBridge()];
  let spawnCount = 0;
  const client = new CoreCommandClient(clientSettings, {
    spawn: () => bridges[spawnCount++],
  });

  assert.equal((await client.invoke("getModules")).ok, true);
  bridges[0].emit("exit", 1);
  assert.equal((await client.invoke("getModules")).ok, true);
  assert.equal(spawnCount, 2);
  client.close();
});

test("CoreCommandClient times out stalled requests and removes them from pending", async () => {
  const client = new CoreCommandClient(clientSettings, {
    requestTimeoutMs: 10,
    spawn: () => createMockBridge(() => {}),
  });

  const response = await client.invoke("getModules");
  assert.equal(response.ok, false);
  assert.match(response.error.message, /timed out/i);
  assert.equal(client.pending.size, 0);
  client.close();
});

test("CoreCommandClient does not resubmit a mutating request after its UI wait expires", async () => {
  let requestCount = 0;
  const settled = [];
  let bridge;
  const client = new CoreCommandClient(clientSettings, {
    requestTimeoutMs: 1,
    onOperationSettled: (event) => settled.push(event),
    spawn: () => (bridge = createMockBridge((child, request) => {
      requestCount += 1;
      setTimeout(() => child.stdout.write(`${JSON.stringify({ request_id: request.request_id, ok: true, data: { saved: true } })}\n`), 20);
    })),
  });
  const first = await client.invoke("createCapture", { content: "one" }, null, { timeoutMs: 5 });
  assert.equal(first.state, "running");
  const duplicate = await client.invoke("createCapture", { content: "one" }, null, { timeoutMs: 5 });
  assert.equal(duplicate.state, "running");
  assert.equal(requestCount, 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(settled.length, 1);
  assert.equal(settled[0].method, "createCapture");
  assert.equal(settled[0].response.data.saved, true);
  const completed = await client.invoke("createCapture", { content: "one" });
  assert.equal(completed.ok, true);
  assert.equal(requestCount, 1);
  client.close();
});

test("CoreCommandClient does not emit background completion for operations resolved in the UI", async () => {
  const settled = [];
  const client = new CoreCommandClient(clientSettings, {
    onOperationSettled: (event) => settled.push(event), spawn: () => createMockBridge(),
  });
  assert.equal((await client.invoke("manageTask", { task_id: "TASK-1", action: "retry" })).ok, true);
  assert.deepEqual(settled, []);
  client.close();
});

test("CoreCommandClient reports a bridge failure after a mutation outlives its UI wait", async () => {
  const settled = [];
  let bridge;
  const client = new CoreCommandClient(clientSettings, {
    requestTimeoutMs: 1, onOperationSettled: (event) => settled.push(event),
    spawn: () => (bridge = createMockBridge(() => {})),
  });
  assert.equal((await client.invoke("manageTask", { task_id: "TASK-2", action: "retry" }, null, { timeoutMs: 5 })).state, "running");
  bridge.emit("exit", 1);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].response.ok, false);
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
    client.invoke("getInstances", { order: 1 }),
    client.invoke("getInstances", { order: 2 }),
  ]);
  assert.deepEqual(first.data, { order: 1 });
  assert.deepEqual(second.data, { order: 2 });
  assert.equal(client.pending.size, 0);
  client.close();
});

test("CoreCommandClient deduplicates canonical concurrent reads and clears them after success or failure", async () => {
  let requestCount = 0;
  let fail = false;
  const client = new CoreCommandClient(clientSettings, {
    spawn: () => createMockBridge((bridge, request) => {
      requestCount += 1;
      setTimeout(() => bridge.stdout.write(`${JSON.stringify(fail
        ? { request_id: request.request_id, ok: false, state: "failed", error: { message: "synthetic failure" } }
        : { request_id: request.request_id, ok: true, data: request.params })}\n`), 10);
    }),
  });
  const [first, second] = await Promise.all([
    client.invoke("getInstances", { module_id: "reading-log", filters: { active: true, status: "open" } }),
    client.invoke("getInstances", { filters: { status: "open", active: true }, module_id: "reading-log" }),
  ]);
  assert.deepEqual(first.data, second.data);
  assert.equal(requestCount, 1);
  assert.equal(client.inFlightReads.size, 0);
  fail = true;
  assert.equal((await client.invoke("getInstances", { module_id: "reading-log" })).ok, false);
  assert.equal(client.inFlightReads.size, 0);
  fail = false;
  assert.equal((await client.invoke("getInstances", { module_id: "reading-log" })).ok, true);
  assert.equal(requestCount, 3, "a completed or failed read must not become a persistent cache");
  client.close();
});

test("LatestRequestGate discards out-of-order responses and accepts only the newest generation", async () => {
  const gate = new LatestRequestGate();
  const committed = [];
  const firstGeneration = gate.request();
  const first = new Promise((resolve) => setTimeout(() => {
    if (gate.isCurrent(firstGeneration)) committed.push("old");
    resolve();
  }, 20));
  const secondGeneration = gate.request();
  const second = new Promise((resolve) => setTimeout(() => {
    if (gate.isCurrent(secondGeneration)) committed.push("new");
    resolve();
  }, 1));
  await Promise.all([first, second]);
  assert.deepEqual(committed, ["new"]);
  gate.invalidate();
  assert.equal(gate.isCurrent(secondGeneration), false);
});

test("CoreCommandClient fails malformed JSON safely and starts a fresh bridge", async () => {
  const broken = createMockBridge((bridge) => bridge.stdout.write("not-json\n"));
  const healthy = createMockBridge();
  let spawnCount = 0;
  const client = new CoreCommandClient(clientSettings, {
    spawn: () => [broken, healthy][spawnCount++],
  });

  const malformed = await client.invoke("getModules");
  assert.equal(malformed.ok, false);
  assert.match(malformed.error.message, /malformed JSON/i);
  assert.equal(client.pending.size, 0);
  assert.equal((await client.invoke("getModules")).ok, true);
  assert.equal(spawnCount, 2);
  client.close();
});

test("CoreCommandClient clears pending requests when the plugin unloads", async () => {
  const client = new CoreCommandClient(clientSettings, {
    requestTimeoutMs: 1_000,
    spawn: () => createMockBridge(() => {}),
  });

  const request = client.invoke("getModules");
  assert.equal(client.pending.size, 1);
  client.close();
  const response = await request;
  assert.equal(response.ok, false);
  assert.match(response.error.message, /restarting/i);
  assert.equal(client.pending.size, 0);
});

test("CoreCommandClient gives a recoverable explanation when Core is not configured", async () => {
  const client = new CoreCommandClient({ nodePath: "node", coreCliPath: "", vaultPath: "" });
  const response = await client.invoke("getModules");

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
    ...createModuleBuilderViews(dependencies),
  };

  assert.equal(typeof constructors.ReviewCenterView, "function");
  assert.equal(typeof constructors.InboxCenterView, "function");
  assert.equal(typeof constructors.SystemCenterView, "function");
  assert.equal(typeof constructors.TodayView, "function");
  assert.equal(typeof constructors.KnowledgeOSSettingTab, "function");
  assert.equal(typeof constructors.ModuleBuilderModal, "function");
  assert.equal(new constructors.TodayView({}, {}).getViewType(), "knowledgeos-today");
  assert.equal(new constructors.InboxCenterView({}, {}).getViewType(), "knowledgeos-inbox");
  assert.equal(new constructors.ReviewCenterView({}, {}).getViewType(), "knowledgeos-review");
  assert.equal(new constructors.SystemCenterView({}, {}).getViewType(), "knowledgeos-system");
});

test("Setup Doctor presents every check state and explicit Vault mutation warnings", () => {
  const source = require("node:fs").readFileSync(require("node:path").resolve(__dirname, "../views/settings-tab.js"), "utf8");
  assert.match(source, /invoke\("getSetupDoctor", \{\}\)/);
  assert.match(source, /Ready.*Needs action.*Failed/s);
  assert.match(source, /执行建议的修复会修改 Vault/);
  assert.match(source, /打开 Today/);
  assert.doesNotMatch(source, /invoke\("getModules", \{\}\)/);
});

test("plugin presentation time follows the Vault timezone without fixed locale assumptions", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const main = fs.readFileSync(path.resolve(__dirname, "../main.js"), "utf8");
  const today = fs.readFileSync(path.resolve(__dirname, "../views/today.js"), "utf8");
  const reviews = fs.readFileSync(path.resolve(__dirname, "../views/review-center.js"), "utf8");
  assert.doesNotMatch(`${main}\n${today}\n${reviews}`, /timeZone: "Asia\/Shanghai"|new Intl\.DateTimeFormat\("zh-CN"|getTimezoneOffset\(\)/);
  assert.match(main, /vault-config\.json/);
  assert.match(today, /formatTodayHeading/);
  assert.match(reviews, /zonedLocalToIso/);
});
