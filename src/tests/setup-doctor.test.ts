import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { JsonObject } from "../core/types.js";
import { initializeVault } from "../core/vault.js";
import { invokeCommandApi } from "../platform/commandApi.js";

test("Setup Doctor reports actionable read-only checks without repairing the Vault", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-setup-doctor-"));
  try {
    await initializeVault(vault, "disabled");
    const before = await fs.readFile(path.join(vault, "90-System", "Core", "engine.json"), "utf8");
    const response = await invokeCommandApi({ vaultRoot: vault, requestId: "SETUP-DOCTOR", method: "getSetupDoctor", params: {} });
    assert.equal(response.ok, true);
    const data = response.data as JsonObject;
    const checks = data.checks as JsonObject[];
    assert.deepEqual(checks.map((item) => item.id), [
      "vault", "node", "core-cli", "python", "python-dependencies", "command-api", "vault-doctor", "config-sync", "runtime-db", "enabled-modules",
    ]);
    assert.equal(checks.find((item) => item.id === "command-api")?.status, "ready");
    assert.equal(checks.find((item) => item.id === "config-sync")?.status, "needs-action");
    assert.equal(checks.find((item) => item.id === "config-sync")?.will_modify_vault, true);
    assert.equal(checks.find((item) => item.id === "runtime-db")?.status, "needs-action");
    assert.equal(await fs.readFile(path.join(vault, "90-System", "Core", "engine.json"), "utf8"), before);
    await assert.rejects(() => fs.access(path.join(vault, "90-System", "State", "runtime.db")));
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});
