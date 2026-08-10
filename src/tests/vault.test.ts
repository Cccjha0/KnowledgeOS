import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { doctorVault, initializeVault } from "../core/vault.js";
import { syncInstalledConfiguration } from "../platform/configuration.js";

async function temporaryVault(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-vault-test-"));
}

test("vault init is additive and idempotent", async () => {
  const vault = await temporaryVault();
  try {
    await fs.writeFile(path.join(vault, "Today.md"), "# My existing dashboard\n", "utf8");
    await fs.writeFile(path.join(vault, ".gitignore"), "private/\n", "utf8");

    const first = await initializeVault(vault, "disabled");
    const second = await initializeVault(vault, "initialize");

    assert.equal(first.status, "initialized");
    assert.equal(second.status, "already-initialized");
    assert.equal(second.gitMode, "disabled");
    assert.equal(await fs.readFile(path.join(vault, "Today.md"), "utf8"), "# My existing dashboard\n");
    const ignore = await fs.readFile(path.join(vault, ".gitignore"), "utf8");
    assert.match(ignore, /^private\/$/m);
    assert.match(ignore, /^90-System\/Cache\/$/m);
    assert.match(ignore, /^90-System\/State\/Locks\/$/m);
    await fs.rm(path.join(vault, "90-System", "State", "Inbox"), { recursive: true, force: true });
    const repaired = await initializeVault(vault, "disabled");
    assert.equal(repaired.createdDirectories.includes("90-System/State/Inbox"), true);
    assert.equal((await doctorVault(vault)).status, "ok");
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test("vault init can create a Git repository and doctor validates it", async () => {
  const vault = await temporaryVault();
  try {
    const initialized = await initializeVault(vault, "initialize");
    const diagnosis = await doctorVault(vault);

    assert.equal(initialized.gitInitialized, true);
    assert.equal(diagnosis.status, "ok");
    assert.equal(diagnosis.gitMode, "initialize");
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test("vault init stays Core-only while configuration sync provisions enabled module directories", async () => {
  const vault = await temporaryVault();
  try {
    await initializeVault(vault, "disabled");
    await assert.rejects(() => fs.access(path.join(vault, "20-Workspace", "Applications", "Inbox")));

    await syncInstalledConfiguration(vault);
    await fs.access(path.join(vault, "20-Workspace", "Applications", "Inbox"));
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test("existing Git mode fails before modifying a non-Git Vault", async () => {
  const vault = await temporaryVault();
  try {
    await assert.rejects(() => initializeVault(vault, "existing"), /不是 Git 仓库/);
    assert.deepEqual(await fs.readdir(vault), []);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});
