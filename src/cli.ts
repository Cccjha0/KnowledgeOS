#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { processApplicationReport } from "./application/processReport.js";
import { buildTodayDashboard } from "./core/dashboard.js";
import { PkbError } from "./core/errors.js";
import { doctorVault, initializeVault, type GitMode } from "./core/vault.js";

interface ParsedArgs {
  positional: string[];
  vault: string;
  dryRun: boolean;
  gitMode: GitMode;
  vaultExplicit: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let vault = ".";
  let dryRun = false;
  let gitMode: GitMode = "initialize";
  let vaultExplicit = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--vault") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("--vault 需要路径参数");
      }
      vault = next;
      vaultExplicit = true;
      index += 1;
    } else if (value === "--dry-run") {
      dryRun = true;
    } else if (value === "--git-mode") {
      const next = argv[index + 1];
      if (next !== "initialize" && next !== "existing" && next !== "disabled") {
        throw new Error("--git-mode 必须是 initialize、existing 或 disabled");
      }
      gitMode = next;
      index += 1;
    } else {
      positional.push(value);
    }
  }
  return { positional, vault: path.resolve(vault), dryRun, gitMode, vaultExplicit };
}

function printHelp(): void {
  console.log(`PKB CLI\n\nCommands:\n  pkb vault init [PATH|--vault PATH] [--git-mode initialize|existing|disabled]\n  pkb vault doctor [PATH|--vault PATH]\n  pkb validate [--vault PATH]\n  pkb application process-report REPORT [--vault PATH] [--dry-run]\n  pkb dashboard build [--vault PATH]\n`);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const [command, subcommand, value] = parsed.positional;

  if (!command || command === "help" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "vault" && subcommand === "init") {
    if (!value && !parsed.vaultExplicit) {
      throw new Error("vault init 需要明确指定 Vault 路径");
    }
    const result = await initializeVault(value ? path.resolve(value) : parsed.vault, parsed.gitMode);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "vault" && subcommand === "doctor") {
    if (!value && !parsed.vaultExplicit) {
      throw new Error("vault doctor 需要明确指定 Vault 路径");
    }
    const result = await doctorVault(value ? path.resolve(value) : parsed.vault);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === "ok" ? 0 : 1;
    return;
  }

  if (command === "validate") {
    const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const result = spawnSync("python", [path.join(engineRoot, "tools", "validate.py"), "--vault", parsed.vault], {
      cwd: engineRoot,
      encoding: "utf8",
    });
    if (result.error) {
      throw new PkbError("VALIDATION_PROCESS_FAILED", result.error.message);
    }
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exitCode = result.status ?? 1;
    return;
  }

  if (command === "application" && subcommand === "process-report") {
    if (!value) {
      throw new Error("缺少研究报告路径");
    }
    const result = await processApplicationReport({
      vaultRoot: parsed.vault,
      reportPath: value,
      dryRun: parsed.dryRun,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "dashboard" && subcommand === "build") {
    const today = await buildTodayDashboard(parsed.vault);
    console.log(JSON.stringify({ status: "built", today }, null, 2));
    return;
  }

  printHelp();
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  if (error instanceof PkbError) {
    console.error(JSON.stringify({
      error_code: error.code,
      message: error.message,
      details: error.details ?? null,
    }, null, 2));
  } else if (error instanceof Error) {
    console.error(JSON.stringify({
      error_code: "UNEXPECTED_ERROR",
      message: error.message,
    }, null, 2));
  } else {
    console.error(JSON.stringify({
      error_code: "UNEXPECTED_ERROR",
      message: String(error),
    }, null, 2));
  }
  process.exitCode = 1;
});
