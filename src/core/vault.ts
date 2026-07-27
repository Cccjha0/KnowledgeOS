import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PkbError } from "./errors.js";
import { exists, listFilesRecursive, readJson, writeJsonAtomic } from "./files.js";

export type GitMode = "initialize" | "existing" | "disabled";

interface VaultConfig {
  schema_version: 1;
  initialized_at: string;
  git: {
    mode: GitMode;
  };
  paths: {
    workspace_root: "20-Workspace";
    system_root: "90-System";
  };
}

export interface VaultInitResult {
  status: "initialized" | "already-initialized";
  vault: string;
  gitMode: GitMode;
  gitInitialized: boolean;
  createdDirectories: string[];
  createdFiles: string[];
}

export interface VaultDoctorResult {
  status: "ok" | "issues-found";
  vault: string;
  gitMode: GitMode | null;
  checks: Array<{ name: string; ok: boolean; message: string }>;
}

const REQUIRED_DIRECTORIES = [
  "00-Inbox",
  "20-Workspace",
  "30-Knowledge",
  "90-System/Core",
  "90-System/Modules",
  "90-System/Components",
  "90-System/Instances",
  "90-System/Logs",
  "90-System/Cache",
  "90-System/Review Queue/Pending",
  "90-System/Review Queue/Deferred",
  "90-System/Review Queue/Closed",
  "90-System/Review Queue/Error",
  "90-System/State/Plans",
  "90-System/State/Inbox",
  "90-System/State/Transactions",
  "90-System/State/Migrations",
  "90-System/State/Locks",
] as const;

const GITIGNORE_ENTRIES = [
  "90-System/Cache/",
  "90-System/State/Locks/",
  "90-System/State/runtime.db",
  "90-System/State/runtime.db-wal",
  "90-System/State/runtime.db-shm",
  "*.tmp-*",
  ".DS_Store",
  ".obsidian/workspace*.json",
] as const;

function relative(vaultRoot: string, target: string): string {
  return path.relative(vaultRoot, target).split(path.sep).join("/");
}

async function ensureDirectory(vaultRoot: string, relativePath: string, created: string[]): Promise<void> {
  const absolute = path.join(vaultRoot, ...relativePath.split("/"));
  if (await exists(absolute)) {
    const stat = await fs.stat(absolute);
    if (!stat.isDirectory()) {
      throw new PkbError("VAULT_PATH_CONFLICT", `初始化目录被同名文件占用：${absolute}`);
    }
    return;
  }
  await fs.mkdir(absolute, { recursive: true });
  created.push(relativePath);
}

async function writeIfMissing(
  vaultRoot: string,
  relativePath: string,
  content: string,
  created: string[],
): Promise<void> {
  const absolute = path.join(vaultRoot, ...relativePath.split("/"));
  if (await exists(absolute)) {
    return;
  }
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, "utf8");
  created.push(relativePath);
}

async function mergeGitignore(vaultRoot: string, createdFiles: string[]): Promise<void> {
  const filePath = path.join(vaultRoot, ".gitignore");
  const existed = await exists(filePath);
  const current = existed ? await fs.readFile(filePath, "utf8") : "";
  const lines = new Set(current.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const missing = GITIGNORE_ENTRIES.filter((entry) => !lines.has(entry));
  if (missing.length === 0) {
    return;
  }
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await fs.writeFile(filePath, `${current}${prefix}${missing.join("\n")}\n`, "utf8");
  if (!existed) {
    createdFiles.push(".gitignore");
  }
}

function initializeGit(vaultRoot: string): void {
  const result = spawnSync("git", ["init", "-b", "main"], {
    cwd: vaultRoot,
    encoding: "utf8",
  });
  if (result.error) {
    throw new PkbError("GIT_INIT_FAILED", result.error.message);
  }
  if (result.status !== 0) {
    throw new PkbError("GIT_INIT_FAILED", "无法初始化 Vault Git 仓库。", result.stderr.trim());
  }
}

export async function initializeVault(
  vaultPath: string,
  requestedGitMode: GitMode,
  additionalDirectories: readonly string[] = [],
): Promise<VaultInitResult> {
  const vaultRoot = path.resolve(vaultPath);
  if (await exists(vaultRoot)) {
    const stat = await fs.stat(vaultRoot);
    if (!stat.isDirectory()) {
      throw new PkbError("INVALID_VAULT_PATH", `Vault 路径不是目录：${vaultRoot}`);
    }
  } else {
    await fs.mkdir(vaultRoot, { recursive: true });
  }

  const configPath = path.join(vaultRoot, "90-System", "State", "vault-config.json");
  const alreadyInitialized = await exists(configPath);
  let gitMode = requestedGitMode;
  if (alreadyInitialized) {
    const existingConfig = await readJson<VaultConfig | null>(configPath, null);
    if (!existingConfig || !existingConfig.git || !existingConfig.git.mode) {
      throw new PkbError("INVALID_VAULT_CONFIG", `Vault 配置无效：${configPath}`);
    }
    gitMode = existingConfig.git.mode;
  }

  const gitDirectory = path.join(vaultRoot, ".git");
  if (gitMode === "existing" && !(await exists(gitDirectory))) {
    throw new PkbError("GIT_REPOSITORY_REQUIRED", "git-mode=existing，但所选 Vault 不是 Git 仓库。");
  }

  const createdDirectories: string[] = [];
  const createdFiles: string[] = [];
  const requiredDirectories = [...REQUIRED_DIRECTORIES, ...additionalDirectories];
  for (const directory of requiredDirectories) {
    await ensureDirectory(vaultRoot, directory, createdDirectories);
  }

  await mergeGitignore(vaultRoot, createdFiles);
  await writeIfMissing(vaultRoot, "90-System/State/id-counters.json", "{\n  \"counters\": {}\n}\n", createdFiles);
  await writeIfMissing(vaultRoot, "90-System/State/processed-reports.json", "{\n  \"reports\": {}\n}\n", createdFiles);
  await writeIfMissing(vaultRoot, "90-System/State/idempotency.json", "{\n  \"completed\": {}\n}\n", createdFiles);
  await writeIfMissing(
    vaultRoot,
    "90-System/Core/backup-policy.json",
    "{\n  \"schema_version\": 1,\n  \"local_compressed_backup\": \"weekly\",\n  \"offsite_backup\": \"required\",\n  \"include_attachments\": true,\n  \"exclude\": [\".git\", \"90-System/Cache\"]\n}\n",
    createdFiles,
  );
  await writeIfMissing(vaultRoot, "90-System/Core/engine.json", "{\n  \"schema_version\": 1,\n  \"engine\": \"knowledgeos-engine\",\n  \"version\": null,\n  \"repository\": null,\n  \"synced_at\": null\n}\n", createdFiles);
  await writeIfMissing(vaultRoot, "90-System/Modules/installed.json", "{\n  \"schema_version\": 1,\n  \"modules\": []\n}\n", createdFiles);
  await writeIfMissing(vaultRoot, "90-System/Components/installed.json", "{\n  \"schema_version\": 1,\n  \"components\": []\n}\n", createdFiles);
  await writeIfMissing(
    vaultRoot,
    "Today.md",
    "# Today\n\nKnowledgeOS 尚未生成今日仪表盘。\n",
    createdFiles,
  );
  for (const directory of requiredDirectories) {
    await writeIfMissing(vaultRoot, `${directory}/.gitkeep`, "", createdFiles);
  }

  let gitInitialized = false;
  if (gitMode === "initialize" && !(await exists(gitDirectory))) {
    initializeGit(vaultRoot);
    gitInitialized = true;
  }

  if (!alreadyInitialized) {
    const config: VaultConfig = {
      schema_version: 1,
      initialized_at: new Date().toISOString(),
      git: { mode: gitMode },
      paths: {
        workspace_root: "20-Workspace",
        system_root: "90-System",
      },
    };
    await writeJsonAtomic(configPath, config);
    createdFiles.push(relative(vaultRoot, configPath));
  }

  return {
    status: alreadyInitialized ? "already-initialized" : "initialized",
    vault: vaultRoot,
    gitMode,
    gitInitialized,
    createdDirectories,
    createdFiles,
  };
}

export async function doctorVault(
  vaultPath: string,
  additionalDirectories: readonly string[] = [],
): Promise<VaultDoctorResult> {
  const vaultRoot = path.resolve(vaultPath);
  const checks: VaultDoctorResult["checks"] = [];
  if (!(await exists(vaultRoot))) {
    return {
      status: "issues-found",
      vault: vaultRoot,
      gitMode: null,
      checks: [{ name: "vault-root", ok: false, message: "Vault 目录不存在。" }],
    };
  }

  checks.push({ name: "vault-root", ok: true, message: "Vault 目录存在。" });
  const configPath = path.join(vaultRoot, "90-System", "State", "vault-config.json");
  let gitMode: GitMode | null = null;
  if (await exists(configPath)) {
    try {
      const config = await readJson<VaultConfig | null>(configPath, null);
      gitMode = config?.git?.mode ?? null;
      checks.push({ name: "vault-config", ok: gitMode !== null, message: gitMode ? "Vault 配置有效。" : "Vault 配置缺少 Git 模式。" });
    } catch (error) {
      checks.push({ name: "vault-config", ok: false, message: `Vault 配置无法解析：${String(error)}` });
    }
  } else {
    checks.push({ name: "vault-config", ok: false, message: "缺少 vault-config.json，请先运行 vault init。" });
  }

  for (const directory of [...REQUIRED_DIRECTORIES, ...additionalDirectories]) {
    const present = await exists(path.join(vaultRoot, ...directory.split("/")));
    checks.push({ name: `directory:${directory}`, ok: present, message: present ? "目录存在。" : "目录缺失。" });
  }

  for (const configFile of [
    "90-System/Core/engine.json",
    "90-System/Core/backup-policy.json",
    "90-System/Modules/installed.json",
    "90-System/Components/installed.json",
  ]) {
    const present = await exists(path.join(vaultRoot, ...configFile.split("/")));
    checks.push({ name: `configuration:${configFile}`, ok: present, message: present ? "Configuration is present." : "Configuration is missing." });
  }

  const transactionFiles = await listFilesRecursive(path.join(vaultRoot, "90-System", "State", "Transactions"), "transaction.json");
  const unhealthy: string[] = [];
  for (const transactionFile of transactionFiles) {
    const transaction = await readJson<{ plan_id?: string; status?: string }>(transactionFile, {});
    if (["not-started", "in-progress", "partially-failed", "manual-action-required"].includes(transaction.status ?? "")) {
      unhealthy.push(`${transaction.plan_id ?? path.basename(path.dirname(transactionFile))}:${transaction.status}`);
    }
  }
  checks.push({
    name: "transactions",
    ok: unhealthy.length === 0,
    message: unhealthy.length === 0 ? "No unfinished transactions." : `Transactions require recovery: ${unhealthy.join(", ")}`,
  });

  const hasGit = await exists(path.join(vaultRoot, ".git"));
  const gitOk = gitMode === "disabled" || hasGit;
  checks.push({
    name: "git",
    ok: gitOk,
    message: gitMode === "disabled" ? "Git 已禁用。" : hasGit ? "Git 仓库存在。" : "配置需要 Git，但仓库不存在。",
  });

  if (gitMode === "existing" && hasGit) {
    const head = spawnSync("git", ["-c", `safe.directory=${vaultRoot}`, "rev-parse", "--verify", "HEAD"], {
      cwd: vaultRoot,
      encoding: "utf8",
    });
    const hasHead = !head.error && head.status === 0;
    checks.push({
      name: "git-head",
      ok: hasHead,
      message: hasHead ? "Git 仓库已有基线提交。" : "已有 Git 模式要求至少一个提交。",
    });
    const status = spawnSync("git", ["-c", `safe.directory=${vaultRoot}`, "status", "--porcelain"], {
      cwd: vaultRoot,
      encoding: "utf8",
    });
    const clean = !status.error && status.status === 0 && (status.stdout ?? "").trim() === "";
    checks.push({
      name: "git-clean",
      ok: clean,
      message: clean ? "Git 工作区干净。" : "已有 Git 模式要求先提交或储藏 Vault 的现有修改。",
    });
  }

  return {
    status: checks.every((check) => check.ok) ? "ok" : "issues-found",
    vault: vaultRoot,
    gitMode,
    checks,
  };
}
