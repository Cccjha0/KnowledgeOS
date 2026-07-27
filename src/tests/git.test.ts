import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGitSnapshot } from "../core/git.js";
import { initializeVault } from "../core/vault.js";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("disabled Git mode does not create a repository", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-git-disabled-"));
  try {
    await initializeVault(vault, "disabled");
    assert.equal(await createGitSnapshot(vault, "RUN-TEST-000001"), "disabled");
    await assert.rejects(() => fs.stat(path.join(vault, ".git")));
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test("existing Git mode returns HEAD when clean and rejects user changes", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-git-existing-"));
  try {
    git(vault, ["init", "-b", "main"]);
    git(vault, ["config", "user.name", "KnowledgeOS Test"]);
    git(vault, ["config", "user.email", "test@example.invalid"]);
    await initializeVault(vault, "existing");
    git(vault, ["add", "-A"]);
    git(vault, ["commit", "-m", "Initial Vault"]);
    const head = git(vault, ["rev-parse", "HEAD"]);

    assert.equal(await createGitSnapshot(vault, "RUN-TEST-000002"), head);
    await fs.writeFile(path.join(vault, "personal-note.md"), "private change\n", "utf8");
    await assert.rejects(
      () => createGitSnapshot(vault, "RUN-TEST-000003"),
      /不会自动提交用户文件/,
    );
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});
