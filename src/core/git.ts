import { spawnSync } from "node:child_process";
import path from "node:path";
import { exists, readJson } from "./files.js";
import { PkbError } from "./errors.js";

function git(vaultRoot: string, args: string[], allowFailure = false): string {
  const safeArgs = ["-c", `safe.directory=${vaultRoot}`, ...args];
  const result = spawnSync("git", safeArgs, {
    cwd: vaultRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw new PkbError("GIT_FAILED", result.error.message);
  }
  if (result.status !== 0 && !allowFailure) {
    throw new PkbError("GIT_FAILED", `git ${args.join(" ")} failed`, result.stderr.trim());
  }
  return result.stdout.trim();
}

export async function createGitSnapshot(vaultRoot: string, runId: string): Promise<string> {
  const configPath = path.join(vaultRoot, "90-System", "State", "vault-config.json");
  if (!(await exists(configPath))) {
    throw new PkbError("VAULT_NOT_INITIALIZED", "Vault 尚未初始化，请先运行 pkb vault init。", configPath);
  }
  const config = await readJson<{ git?: { mode?: string } }>(configPath, {});
  const mode = config.git?.mode;
  if (mode === "disabled") {
    return "disabled";
  }
  if (mode !== "initialize" && mode !== "existing") {
    throw new PkbError("INVALID_VAULT_CONFIG", "Vault Git 模式无效。", mode);
  }

  if (!(await exists(path.join(vaultRoot, ".git")))) {
    if (mode === "existing") {
      throw new PkbError("GIT_REPOSITORY_REQUIRED", "Vault 配置要求使用已有 Git 仓库，但未找到 .git。 ");
    }
    git(vaultRoot, ["init"]);
  }

  if (mode === "existing") {
    const head = git(vaultRoot, ["rev-parse", "HEAD"], true);
    if (!head) {
      throw new PkbError("GIT_HEAD_REQUIRED", "已有 Git 模式要求仓库至少存在一个提交。");
    }
    const dirty = git(vaultRoot, ["status", "--porcelain"]);
    if (dirty) {
      throw new PkbError(
        "GIT_WORKTREE_DIRTY",
        "已有 Git 模式不会自动提交用户文件；请先提交或储藏当前修改。",
        dirty.split(/\r?\n/),
      );
    }
    return head;
  }

  git(vaultRoot, ["add", "-A"]);
  const status = spawnSync(
    "git",
    ["-c", `safe.directory=${vaultRoot}`, "diff", "--cached", "--quiet"],
    { cwd: vaultRoot },
  );
  if (status.status === 1) {
    git(vaultRoot, [
      "-c", "user.name=PKB Local Agent",
      "-c", "user.email=pkb-local@example.invalid",
      "commit", "-m", `PKB snapshot before ${runId}`,
    ]);
  }

  const head = git(vaultRoot, ["rev-parse", "HEAD"], true);
  if (!head) {
    throw new PkbError("GIT_SNAPSHOT_FAILED", "Unable to create or resolve a Git snapshot");
  }
  return head;
}
