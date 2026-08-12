import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseMarkdown } from "../core/bridge.js";
import { listFilesRecursive } from "../core/files.js";
import { RuntimeRepository } from "../runtime/repository.js";

async function generate(target: string, replace = false): Promise<Record<string, unknown>> {
  const args = ["tools/generate-synthetic-vault.mjs", "--scale", "small", "--output", target, ...(replace ? ["--replace"] : [])];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: path.resolve("."), windowsHide: true });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(JSON.parse(stdout) as Record<string, unknown>) : reject(new Error(stderr || stdout)));
  });
}

test("synthetic Vault generator creates exact deterministic small-scale counts and only replaces marked targets", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-synthetic-test-"));
  const vault = path.join(parent, "vault");
  const unsafe = path.join(parent, "unsafe");
  try {
    const result = await generate(vault);
    assert.equal(result.scale, "small");
    assert.equal((result.counts as Record<string, number>).records, 50);
    assert.equal((await listFilesRecursive(path.join(vault, "20-Workspace", "Synthetic"), ".md")).length, 50);
    assert.equal((await listFilesRecursive(path.join(vault, "00-Inbox"), ".md")).length, 10);
    assert.equal((await listFilesRecursive(path.join(vault, "90-System", "Review Queue", "Pending"), ".md")).length, 10);
    assert.equal((await listFilesRecursive(path.join(vault, "90-System", "Logs"), ".md")).length, 100);
    assert.equal((await listFilesRecursive(path.join(vault, "90-System", "Instances"), "instance.yaml")).length, 3);
    const first = parseMarkdown(vault, path.join(vault, "20-Workspace", "Synthetic", "synthetic-001", "Records", "record-000001.md"));
    assert.equal(first.data.institution, "Synthetic Institution 1");
    const runtime = await RuntimeRepository.open(vault);
    try {
      assert.equal(runtime.listTasks().length, 100);
      assert.equal(runtime.listQualityIssues({ limit: 100 }).length, 20);
    } finally { runtime.close(); }

    await generate(vault, true);
    assert.equal((await listFilesRecursive(path.join(vault, "90-System", "Logs"), ".md")).length, 100);
    await fs.mkdir(unsafe); await fs.writeFile(path.join(unsafe, "user-note.md"), "must remain", "utf8");
    await assert.rejects(() => generate(unsafe, true), /Refusing to replace/);
    assert.equal(await fs.readFile(path.join(unsafe, "user-note.md"), "utf8"), "must remain");
  } finally { await fs.rm(parent, { recursive: true, force: true }); }
});

test("UX benchmark scenarios exercise bounded first-page APIs", async () => {
  const source = await fs.readFile(path.resolve("tools/benchmark-ux-performance.mjs"), "utf8");
  assert.match(source, /getInboxCenterSnapshot"[^\n]*page_size: 50/);
  assert.match(source, /listReviewItems"[^\n]*page_size: 50/);
  assert.match(source, /section: "tasks", page_size: 50/);
  assert.match(source, /section: "history", page_size: 20/);
  assert.match(source, /getRecentRuns"[^\n]*page_size: 20/);
  assert.doesNotMatch(source, /getInboxCenterSnapshot"[^\n]*limit:/);
});
