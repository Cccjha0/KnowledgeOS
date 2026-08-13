import { spawnSync } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { exists, readJson } from "../core/files.js";
import type { JsonObject, JsonValue } from "../core/types.js";
import { doctorVault } from "../core/vault.js";

type SetupStatus = "ready" | "needs-action" | "failed";

interface SetupCheck extends JsonObject {
  id: string;
  label: string;
  status: SetupStatus;
  message: string;
  impact: string;
  recovery_actions: string[];
  will_modify_vault: boolean;
  details: JsonValue;
}

function check(
  id: string,
  label: string,
  status: SetupStatus,
  message: string,
  impact: string,
  recoveryActions: string[] = [],
  willModifyVault = false,
  details: JsonValue = null,
): SetupCheck {
  return { id, label, status, message, impact, recovery_actions: recoveryActions, will_modify_vault: willModifyVault, details };
}

function pythonProbe(args: string[]): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const result = spawnSync("python", ["-X", "utf8", ...args], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    ...(result.error ? { error: result.error } : {}),
  };
}

async function runtimeDatabaseCheck(vaultRoot: string): Promise<SetupCheck> {
  const database = path.join(vaultRoot, "90-System", "State", "runtime.db");
  if (!(await exists(database))) {
    return check("runtime-db", "Runtime DB", "needs-action", "Runtime DB 尚未创建。", "后台任务在首次运行前不可用。", ["打开 System Center 或运行一次 runtime startup"], true);
  }
  const script = [
    "import json, sqlite3, sys",
    "uri = 'file:' + sys.argv[1].replace('\\\\', '/') + '?mode=ro'",
    "db = sqlite3.connect(uri, uri=True)",
    "integrity = db.execute('PRAGMA integrity_check').fetchone()[0]",
    "schema = db.execute(\"SELECT value FROM runtime_metadata WHERE key='schema_version'\").fetchone()[0]",
    "print(json.dumps({'integrity': integrity, 'schema_version': int(schema)}))",
  ].join("; ");
  const probe = pythonProbe(["-c", script, database]);
  if (probe.error || probe.status !== 0) {
    return check("runtime-db", "Runtime DB", "failed", "Runtime DB 无法只读检查。", "后台任务状态可能不可读取。", ["保留 runtime.db 并查看错误详情", "从 System Center 运行 Runtime 恢复流程"], false, probe.error?.message ?? probe.stderr.trim());
  }
  const details = JSON.parse(probe.stdout.trim()) as JsonObject;
  const healthy = details.integrity === "ok";
  return check("runtime-db", "Runtime DB", healthy ? "ready" : "failed", healthy ? "Runtime DB 完整且可读取。" : "Runtime DB 完整性检查失败。", healthy ? "后台任务状态可用。" : "后台任务状态可能不完整。", healthy ? [] : ["停止后台任务并从备份恢复 Runtime DB"], false, details);
}

export async function getSetupDoctor(vaultRoot: string, engineRoot: string): Promise<JsonObject> {
  const checks: SetupCheck[] = [];
  try {
    await fs.access(vaultRoot, fsConstants.R_OK | fsConstants.W_OK);
    checks.push(check("vault", "当前 Obsidian Vault", "ready", "Vault 路径存在且 Core 可读写。", "KnowledgeOS 可以读取并保存受管数据。", [], false, vaultRoot));
  } catch (error) {
    checks.push(check("vault", "当前 Obsidian Vault", "failed", "Vault 路径不存在或不可读写。", "KnowledgeOS 无法可靠运行。", ["在设置中选择当前 Obsidian Vault 的绝对路径", "检查目录权限"], false, String(error)));
  }

  const major = Number(process.versions.node.split(".")[0]);
  checks.push(check("node", "Node.js", major >= 20 ? "ready" : "failed", `Node.js ${process.version}。`, major >= 20 ? "Core 运行时满足最低版本要求。" : "Core 运行时版本低于 Node.js 20。", major >= 20 ? [] : ["安装 Node.js 20 或更高版本", "更新设置中的 Node.js 可执行文件"], false, process.execPath));

  const cliPath = path.join(engineRoot, "dist", "cli.js");
  const cliReady = await exists(cliPath);
  checks.push(check("core-cli", "Core CLI / dist/cli.js", cliReady ? "ready" : "needs-action", cliReady ? "已找到编译后的 Core CLI。" : "缺少编译后的 dist/cli.js。", cliReady ? "插件可以启动 Command API。" : "插件无法启动 Core。", cliReady ? [] : ["在 knowledgeos-engine 目录运行 npm ci", "运行 npm run build", "重新测试连接"], false, cliPath));

  const python = pythonProbe(["--version"]);
  const pythonReady = !python.error && python.status === 0;
  checks.push(check("python", "Python", pythonReady ? "ready" : "failed", pythonReady ? (python.stdout || python.stderr).trim() : "无法启动 Python。", pythonReady ? "Markdown、Schema 与 SQLite bridge 可以运行。" : "Core 无法解析受管文档或读取运行时投影。", pythonReady ? [] : ["安装 Python 3", "将 python 加入 PATH"], false, python.error?.message ?? null));

  const dependencies = pythonReady ? pythonProbe(["-c", "import jsonschema, yaml, pypdf; print('jsonschema, PyYAML, pypdf')"]) : null;
  const dependenciesReady = dependencies !== null && !dependencies.error && dependencies.status === 0;
  checks.push(check("python-dependencies", "Python dependencies", dependenciesReady ? "ready" : "needs-action", dependenciesReady ? "所需 Python dependencies 已安装。" : "缺少一个或多个 Python dependencies。", dependenciesReady ? "Schema、YAML 与 PDF 处理可用。" : "部分解析和校验操作不可用。", dependenciesReady ? [] : ["在 knowledgeos-engine 目录运行 python -m pip install -r requirements.txt"], false, dependencies?.stderr.trim() || null));

  checks.push(check("command-api", "Command API", "ready", "本次 Setup Doctor 已通过 Command API 返回。", "插件与 Core 的请求通道可用。"));

  const vaultReport = await doctorVault(vaultRoot);
  const failedVaultChecks = vaultReport.checks.filter((item) => !item.ok);
  checks.push(check("vault-doctor", "Vault doctor", failedVaultChecks.length ? "needs-action" : "ready", failedVaultChecks.length ? `${failedVaultChecks.length} 项 Vault 检查需要处理。` : "Vault 结构、事务与 Git 检查通过。", failedVaultChecks.length ? "部分 KnowledgeOS 功能可能不可用或需要恢复。" : "Vault 基础结构可用。", failedVaultChecks.length ? ["运行 pkb vault doctor 查看详情", "仅在备份后执行明确的修复操作"] : [], false, failedVaultChecks));

  const packageData = JSON.parse(await fs.readFile(path.join(engineRoot, "package.json"), "utf8")) as { version?: string };
  const engineData = await readJson<JsonObject | null>(path.join(vaultRoot, "90-System", "Core", "engine.json"), null);
  const configReady = engineData?.version === packageData.version && typeof engineData?.synced_at === "string";
  checks.push(check("config-sync", "Config sync", configReady ? "ready" : "needs-action", configReady ? `Vault 配置已同步到 Engine ${packageData.version}。` : "Vault 配置尚未与当前 Engine 同步。", configReady ? "官方模块与组件配置和当前 Engine 一致。" : "模块清单或组件可能落后于当前 Engine。", configReady ? [] : ["确认 Vault 已备份", "运行 pkb config sync --vault <Vault 路径>"], true, { engine_version: packageData.version ?? null, vault_engine_version: engineData?.version ?? null, synced_at: engineData?.synced_at ?? null }));

  checks.push(await runtimeDatabaseCheck(vaultRoot));

  const installed = await readJson<{ modules?: Array<{ id?: string; status?: string; installed_path?: string }> }>(path.join(vaultRoot, "90-System", "Modules", "installed.json"), { modules: [] });
  const enabled = (installed.modules ?? []).filter((module) => module.status !== "disabled");
  const missing: string[] = [];
  for (const module of enabled) {
    if (!module.installed_path || !(await exists(path.join(vaultRoot, ...module.installed_path.split("/"))))) missing.push(module.id ?? "unknown");
  }
  const modulesStatus: SetupStatus = missing.length ? "failed" : enabled.length ? "ready" : "needs-action";
  checks.push(check("enabled-modules", "Enabled Modules", modulesStatus, missing.length ? `${missing.length} 个已启用模块缺少安装目录。` : enabled.length ? `${enabled.length} 个模块已启用。` : "当前没有已启用模块。", missing.length ? "对应模块无法正常发现或运行。" : enabled.length ? "模块功能可供 Core 发现。" : "Today 仍可打开，但不会显示模块工作。", missing.length ? ["运行 config sync", "检查缺失模块目录"] : enabled.length ? [] : ["运行 config sync 安装官方模块"], true, { enabled: enabled.map((module) => module.id ?? "unknown"), missing }));

  const summary = {
    ready: checks.filter((item) => item.status === "ready").length,
    needs_action: checks.filter((item) => item.status === "needs-action").length,
    failed: checks.filter((item) => item.status === "failed").length,
  };
  return { status: summary.failed ? "failed" : summary.needs_action ? "needs-action" : "ready", checked_at: new Date().toISOString(), summary, checks, next_steps: summary.failed || summary.needs_action ? [] : ["打开 Today", "使用 Quick Capture", "查看 Inbox"] };
}
