const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const { CoreCommandClient } = require("../services/core-command-client");

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
