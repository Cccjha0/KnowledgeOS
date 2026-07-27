import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { probeRuntimeResources } from "../runtime/resourceMonitor.js";

test("resource monitor probes real Vault and CLI capabilities without guessing network", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-resource-monitor-"));
  try {
    const statuses = await probeRuntimeResources(vault, { codexExecutable: process.execPath });
    assert.equal(statuses.find((item) => item.resource === "filesystem")?.status, "available");
    const codex = statuses.find((item) => item.resource === "codex")!;
    assert.equal(["available", "unavailable"].includes(codex.status), true);
    assert.notEqual(codex.status, "unknown");
    assert.equal(statuses.find((item) => item.resource === "network")?.status, "unknown");
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});
