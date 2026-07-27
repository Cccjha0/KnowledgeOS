#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { APPLICATION_VAULT_DIRECTORIES } from "./application/setup.js";
import { processApplicationReport } from "./platform/applicationWorkflow.js";
import { decideReview, reconcileReviews, retryReview } from "./platform/reviewWorkflow.js";
import { rebuildTodayDashboard } from "./platform/dashboard.js";
import { startResearchRequest, syncDueResearchRequests } from "./platform/researchRequestWorkflow.js";
import { syncInstalledConfiguration } from "./platform/configuration.js";
import { PkbError } from "./core/errors.js";
import { doctorVault, initializeVault, type GitMode } from "./core/vault.js";
import { applyMigration, planMigrations } from "./core/migrations.js";
import { recoverInterruptedTransactions, rollbackTransaction } from "./core/operationExecutor.js";
import { createVaultBackup, restoreVaultBackup, verifyVaultBackup } from "./core/backup.js";
import type { JsonValue, ReviewDecisionKind } from "./types.js";

interface ParsedArgs {
  positional: string[];
  vault: string;
  dryRun: boolean;
  gitMode: GitMode;
  vaultExplicit: boolean;
  userComment: string;
  reviewAfter: string | null;
  modifiedValue: JsonValue | undefined;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let vault = ".";
  let dryRun = false;
  let gitMode: GitMode = "initialize";
  let vaultExplicit = false;
  let userComment = "";
  let reviewAfter: string | null = null;
  let modifiedValue: JsonValue | undefined;
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
    } else if (value === "--comment") {
      const next = argv[index + 1];
      if (next === undefined) {
        throw new Error("--comment 需要文本参数");
      }
      userComment = next;
      index += 1;
    } else if (value === "--review-after") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("--review-after 需要 ISO 时间参数");
      }
      reviewAfter = next;
      index += 1;
    } else if (value === "--value") {
      const next = argv[index + 1];
      if (next === undefined) {
        throw new Error("--value 需要 JSON 参数");
      }
      modifiedValue = JSON.parse(next) as JsonValue;
      index += 1;
    } else {
      positional.push(value);
    }
  }
  return {
    positional,
    vault: path.resolve(vault),
    dryRun,
    gitMode,
    vaultExplicit,
    userComment,
    reviewAfter,
    modifiedValue,
  };
}

function printHelp(): void {
  console.log(`PKB CLI\n\nCommands:\n  pkb vault init [PATH|--vault PATH] [--git-mode initialize|existing|disabled]\n  pkb vault doctor [PATH|--vault PATH]\n  pkb config sync [--vault PATH]\n  pkb migration plan [--vault PATH]\n  pkb migration apply MIGRATION_RUN_ID [--vault PATH]\n  pkb transaction recover [--vault PATH]\n  pkb transaction rollback PLAN_ID [--vault PATH]\n  pkb backup create DESTINATION [--vault PATH]\n  pkb backup verify ARCHIVE\n  pkb backup restore ARCHIVE TARGET\n  pkb validate [--vault PATH]\n  pkb application process-report REPORT [--vault PATH] [--dry-run]\n  pkb application research-sync [--vault PATH]\n  pkb application research-start REQUEST_ID [--vault PATH]\n  pkb review decide REVIEW_ID DECISION [--comment TEXT] [--value JSON] [--review-after ISO] [--vault PATH]\n  pkb review reconcile [REVIEW_ID] [--vault PATH]\n  pkb review retry REVIEW_ID [--vault PATH]\n  pkb dashboard build [--vault PATH]\n`);
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
    const result = await initializeVault(
      value ? path.resolve(value) : parsed.vault,
      parsed.gitMode,
      APPLICATION_VAULT_DIRECTORIES,
    );
    await syncInstalledConfiguration(result.vault);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "config" && subcommand === "sync") {
    console.log(JSON.stringify(await syncInstalledConfiguration(parsed.vault), null, 2));
    return;
  }

  if (command === "migration" && subcommand === "plan") {
    const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    console.log(JSON.stringify(await planMigrations(parsed.vault, engineRoot), null, 2));
    return;
  }

  if (command === "migration" && subcommand === "apply") {
    if (!value) throw new Error("migration apply requires MIGRATION_RUN_ID");
    console.log(JSON.stringify(await applyMigration(parsed.vault, value), null, 2));
    return;
  }

  if (command === "transaction" && subcommand === "recover") {
    console.log(JSON.stringify({ recovered: await recoverInterruptedTransactions(parsed.vault) }, null, 2));
    return;
  }

  if (command === "transaction" && subcommand === "rollback") {
    if (!value) throw new Error("transaction rollback requires PLAN_ID");
    console.log(JSON.stringify({ plan_id: value, status: await rollbackTransaction(parsed.vault, value) }, null, 2));
    return;
  }

  if (command === "backup" && subcommand === "create") {
    if (!value) throw new Error("backup create requires DESTINATION");
    console.log(JSON.stringify(createVaultBackup(parsed.vault, value), null, 2));
    return;
  }

  if (command === "backup" && subcommand === "verify") {
    if (!value) throw new Error("backup verify requires ARCHIVE");
    console.log(JSON.stringify(verifyVaultBackup(value), null, 2));
    return;
  }

  if (command === "backup" && subcommand === "restore") {
    const target = parsed.positional[3];
    if (!value || !target) throw new Error("backup restore requires ARCHIVE and TARGET");
    console.log(JSON.stringify(restoreVaultBackup(value, target), null, 2));
    return;
  }

  if (command === "vault" && subcommand === "doctor") {
    if (!value && !parsed.vaultExplicit) {
      throw new Error("vault doctor 需要明确指定 Vault 路径");
    }
    const result = await doctorVault(
      value ? path.resolve(value) : parsed.vault,
      APPLICATION_VAULT_DIRECTORIES,
    );
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === "ok" ? 0 : 1;
    return;
  }

  if (command === "validate") {
    const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const result = spawnSync("python", ["-X", "utf8", path.join(engineRoot, "tools", "validate.py"), "--vault", parsed.vault], {
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

  if (command === "review" && subcommand === "decide") {
    const reviewId = value;
    const decision = parsed.positional[3] as ReviewDecisionKind | undefined;
    const allowed = new Set<ReviewDecisionKind>([
      "approve",
      "approve-with-modification",
      "reject",
      "defer",
      "discuss",
    ]);
    if (!reviewId || !decision || !allowed.has(decision)) {
      throw new Error("review decide 需要 REVIEW_ID 和有效的 DECISION");
    }
    const result = await decideReview({
      vaultRoot: parsed.vault,
      reviewId,
      decision,
      userComment: parsed.userComment,
      reviewAfter: parsed.reviewAfter,
      modifiedValue: parsed.modifiedValue,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "review" && subcommand === "reconcile") {
    const result = await reconcileReviews(parsed.vault, value);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "review" && subcommand === "retry") {
    if (!value) {
      throw new Error("review retry 需要 REVIEW_ID");
    }
    const result = await retryReview(parsed.vault, value);
    console.log(JSON.stringify(result, null, 2));
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

  if (command === "application" && subcommand === "research-sync") {
    const result = await syncDueResearchRequests(parsed.vault);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "application" && subcommand === "research-start") {
    if (!value) throw new Error("application research-start requires REQUEST_ID");
    console.log(JSON.stringify(await startResearchRequest(parsed.vault, value), null, 2));
    return;
  }

  if (command === "dashboard" && subcommand === "build") {
    const today = await rebuildTodayDashboard(parsed.vault);
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
