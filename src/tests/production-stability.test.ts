import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createVaultBackup, restoreVaultBackup, verifyVaultBackup } from "../core/backup.js";
import { parseMarkdown, writeMarkdown } from "../core/bridge.js";
import { readJson, writeJsonAtomic } from "../core/files.js";
import { applyMigration, planMigrations } from "../core/migrations.js";
import { executeOperationPlan, recoverInterruptedTransactions, rollbackTransaction } from "../core/operationExecutor.js";
import type { JsonObject, OperationPlan } from "../core/types.js";
import { initializeVault } from "../core/vault.js";
import { syncInstalledConfiguration } from "../platform/configuration.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-production-"));
}

test("Vault initialization separates configuration, user data, state, logs, and cache", async () => {
  const root = await tempRoot();
  const vault = path.join(root, "vault");
  try {
    await initializeVault(vault, "disabled");
    const synced = await syncInstalledConfiguration(vault);
    for (const relative of [
      "20-Workspace", "30-Knowledge", "90-System/Core", "90-System/Modules", "90-System/Components",
      "90-System/State", "90-System/Logs", "90-System/Cache",
    ]) assert.equal((await fs.stat(path.join(vault, ...relative.split("/")))).isDirectory(), true);
    assert.deepEqual(synced.modules.map((module) => module.id), ["application-tracker", "experience-log", "reading-log"]);
    assert.equal((await readJson<{ version: string }>(path.join(vault, "90-System", "Core", "engine.json"), { version: "" })).version, "0.1.0");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("schema migration plans, snapshots, validates, and can be rolled back", async () => {
  const root = await tempRoot();
  const vault = path.join(root, "vault");
  try {
    await initializeVault(vault, "disabled");
    const fixture = JSON.parse(await fs.readFile(path.join(ENGINE_ROOT, "examples", "monash-application-record.json"), "utf8")) as JsonObject;
    fixture.schema_version = 1;
    const target = path.join(vault, "20-Workspace", "Applications", "demo", "Records", "record.md");
    writeMarkdown(vault, target, { data: fixture, content: "# Record\n" });
    const runs = await planMigrations(vault, ENGINE_ROOT);
    assert.equal(runs.length, 1);
    const completed = await applyMigration(vault, runs[0]!.migration_run_id);
    assert.equal(completed.status, "completed");
    assert.equal(parseMarkdown(vault, target).data.schema_version, 2);
    assert.equal(await rollbackTransaction(vault, completed.plan.plan_id), "rolled-back");
    assert.equal(parseMarkdown(vault, target).data.schema_version, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("an interrupted durable transaction is recovered without replay", async () => {
  const root = await tempRoot();
  const vault = path.join(root, "vault");
  const target = path.join(vault, "record.md");
  try {
    await initializeVault(vault, "disabled");
    await fs.writeFile(target, "---\nvalue: old\n---\n\n# Record\n", "utf8");
    const plan: OperationPlan = {
      plan_id: "PLAN-2026-009001", task_id: "TASK-2026-009001", source_module: "experience-log", instance_id: "demo",
      summary: "Crash recovery test", review_items: [], operations: [{
        operation_id: "OP-001", type: "update-frontmatter", target: "record.md", risk: "green", confidence: 1,
        idempotency_key: "production:crash-recovery", payload: { patch: { value: "new" } }, requires_review_id: null,
      }],
    };
    await executeOperationPlan(vault, plan, { allowedTargets: ["record.md"], allowedTypes: ["update-frontmatter"] });
    const journalPath = path.join(vault, "90-System", "State", "Transactions", plan.plan_id, "transaction.json");
    const journal = await readJson<Record<string, unknown>>(journalPath, {});
    journal.status = "in-progress";
    await writeJsonAtomic(journalPath, journal);
    await fs.writeFile(target, "corrupted partial write", "utf8");
    assert.deepEqual(await recoverInterruptedTransactions(vault), [plan.plan_id]);
    assert.match(await fs.readFile(target, "utf8"), /value: old/);
    const recovered = await readJson<{ status: string }>(journalPath, { status: "" });
    assert.equal(recovered.status, "rolled-back");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("rollback refuses to overwrite a file changed after completion", async () => {
  const root = await tempRoot();
  const vault = path.join(root, "vault");
  try {
    await initializeVault(vault, "disabled");
    await fs.writeFile(path.join(vault, "record.md"), "---\nvalue: old\n---\n", "utf8");
    const plan: OperationPlan = {
      plan_id: "PLAN-2026-009002", task_id: "TASK-2026-009002", source_module: "experience-log", instance_id: "demo",
      summary: "Rollback conflict test", review_items: [], operations: [{
        operation_id: "OP-001", type: "update-frontmatter", target: "record.md", risk: "green", confidence: 1,
        idempotency_key: "production:rollback-conflict", payload: { patch: { value: "system" } }, requires_review_id: null,
      }],
    };
    await executeOperationPlan(vault, plan);
    await fs.writeFile(path.join(vault, "record.md"), "user edit after completion", "utf8");
    await assert.rejects(() => rollbackTransaction(vault, plan.plan_id), /newer changes/);
    assert.equal(await fs.readFile(path.join(vault, "record.md"), "utf8"), "user edit after completion");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("compressed backup includes attachments and can restore configuration plus data", async () => {
  const root = await tempRoot();
  const vault = path.join(root, "vault");
  const backupDir = path.join(root, "backups");
  const restored = path.join(root, "restored");
  try {
    await initializeVault(vault, "disabled");
    await syncInstalledConfiguration(vault);
    const attachment = path.join(vault, "20-Workspace", "attachments", "large.bin");
    await fs.mkdir(path.dirname(attachment), { recursive: true });
    await fs.writeFile(attachment, Buffer.from([0, 1, 2, 3, 255]));
    const created = createVaultBackup(vault, backupDir) as { archive: string };
    assert.equal((verifyVaultBackup(created.archive) as { status: string }).status, "valid");
    restoreVaultBackup(created.archive, restored);
    assert.deepEqual(await fs.readFile(path.join(restored, "20-Workspace", "attachments", "large.bin")), Buffer.from([0, 1, 2, 3, 255]));
    assert.equal((await fs.stat(path.join(restored, "90-System", "Modules", "installed.json"))).isFile(), true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
