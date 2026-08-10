#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseMarkdown, parseYaml } from "./core/bridge.js";
import { exists, toVaultPath, writeJsonAtomic } from "./core/files.js";
import { executeModuleWorkflowNow } from "./modules/directInvocation.js";
import { decideReview, reconcileReviews, retryReview } from "./platform/reviewWorkflow.js";
import { rebuildTodayDashboard } from "./platform/dashboard.js";
import { startResearchRequest, syncDueResearchRequests } from "./platform/researchRequestWorkflow.js";
import { syncInstalledConfiguration } from "./platform/configuration.js";
import { PkbError } from "./core/errors.js";
import { doctorVault, initializeVault, type GitMode } from "./core/vault.js";
import { applyMigration, planMigrations, rollbackMigration } from "./core/migrations.js";
import { recoverInterruptedTransactions, rollbackTransaction } from "./core/operationExecutor.js";
import { createVaultBackup, restoreVaultBackup, verifyVaultBackup } from "./core/backup.js";
import type { JsonValue, ReviewDecisionKind } from "./types.js";
import { invokeCommandApi } from "./platform/commandApi.js";
import type { CommandApiMethod } from "./api/types.js";
import { registerDeclaredJobs } from "./runtime/jobRegistry.js";
import { reconcileStartup } from "./runtime/reconciler.js";
import { evaluateScheduler } from "./runtime/scheduler.js";
import { dispatchOnce } from "./runtime/dispatcher.js";
import { probeRuntimeResources } from "./runtime/resourceMonitor.js";
import { materializeFieldDueJobs, materializeStartupJobs, replayRuntimeEvent } from "./runtime/triggers.js";
import { RuntimeRepository, restoreRuntimeDatabase } from "./runtime/repository.js";
import { createModuleScaffold } from "./modules/scaffold.js";
import { scaffoldModuleFromBlueprint, validateModuleBlueprint } from "./modules/blueprint.js";
import { installModulePackage, packModuleDirectory, rollbackModulePackage } from "./modules/packageManager.js";
import { validateModule } from "./modules/validator.js";
import { testModule } from "./modules/testRunner.js";
import { runModuleSandbox } from "./modules/sandbox.js";
import { getModuleReadiness, runModuleReadinessAction, type ModuleReadinessAction } from "./modules/readiness.js";
import type { ModuleTemplate } from "./modules/types.js";
import { LEGACY_APPLICATION_COMPATIBILITY_NOTICE } from "./compatibility/legacyApplication.js";

interface ParsedArgs {
  positional: string[];
  vault: string;
  dryRun: boolean;
  gitMode: GitMode;
  vaultExplicit: boolean;
  userComment: string;
  reviewAfter: string | null;
  modifiedValue: JsonValue | undefined;
  apiInput: Record<string, JsonValue>;
  requestId: string;
  confirm: boolean;
  developerUnsafe: boolean;
}

async function moduleSourceRoot(engineRoot: string, vaultRoot: string, vaultExplicit: boolean, moduleId: string): Promise<string> {
  const workspace = path.join(vaultRoot, "90-System", "Module Development", moduleId);
  return vaultExplicit && await exists(path.join(workspace, "module.yaml")) ? workspace : path.join(engineRoot, "modules", moduleId);
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
  let apiInput: Record<string, JsonValue> = {};
  let requestId = `REQ-${randomUUID()}`;
  let confirm = false;
  let developerUnsafe = false;
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
    } else if (value === "--confirm") {
      confirm = true;
    } else if (value === "--developer-unsafe") {
      developerUnsafe = true;
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
    } else if (value === "--input") {
      const next = argv[index + 1];
      if (next === undefined) throw new Error("--input requires a JSON object");
      const parsedInput = JSON.parse(next) as unknown;
      if (!parsedInput || typeof parsedInput !== "object" || Array.isArray(parsedInput)) {
        throw new Error("--input must be a JSON object");
      }
      apiInput = parsedInput as Record<string, JsonValue>;
      index += 1;
    } else if (value === "--request-id") {
      const next = argv[index + 1];
      if (!next) throw new Error("--request-id requires a value");
      requestId = next;
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
    apiInput,
    requestId,
    confirm,
    developerUnsafe,
  };
}

function printHelp(): void {
  console.log(`PKB CLI\n\nCommands:\n  pkb api METHOD [--input JSON] [--request-id ID] [--vault PATH]\n  pkb vault init [PATH|--vault PATH] [--git-mode initialize|existing|disabled]\n  pkb vault doctor [PATH|--vault PATH]\n  pkb config sync [--vault PATH]\n  pkb module blueprint validate BLUEPRINT\n  pkb module create --from BLUEPRINT\n  pkb module scaffold --from BLUEPRINT\n  pkb module create ID minimal-config|workflow|integration [DISPLAY_NAME]\n  pkb module validate|test|sandbox ID\n  pkb module readiness-run ID implement-with-ai|validate-manual|test|sandbox|pack|install [--vault PATH]\n  pkb module pack ID [OUTPUT]\n  pkb module install|upgrade PACKAGE [--vault PATH]\n  pkb module rollback ID [--vault PATH]\n  pkb migration plan|apply [--vault PATH]\n  pkb transaction recover|rollback [--vault PATH]\n  pkb backup create|verify|restore\n  pkb validate [--vault PATH]\n  pkb application process-report|research-sync|research-start [deprecated compatibility aliases; --vault PATH]\n  pkb review decide|reconcile|retry [--vault PATH]\n  pkb dashboard build [--vault PATH]\n  pkb runtime startup|run-once|watch [--vault PATH]\n  pkb runtime event-replay EVENT_ID [SUBSCRIPTION_KEY...] [--vault PATH]\n  pkb runtime backup DESTINATION|restore BACKUP [--vault PATH]\n`);
}

function warnLegacyApplicationAlias(): void {
  process.stderr.write(`DEPRECATED: ${LEGACY_APPLICATION_COMPATIBILITY_NOTICE}\n`);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const [command, subcommand, value] = parsed.positional;

  if (!command || command === "help" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "api") {
    if (!subcommand) throw new Error("api requires METHOD");
    const response = await invokeCommandApi({
      vaultRoot: parsed.vault,
      requestId: parsed.requestId,
      method: subcommand as CommandApiMethod,
      params: parsed.apiInput,
    });
    console.log(JSON.stringify(response, null, 2));
    process.exitCode = response.ok ? 0 : 1;
    return;
  }

  if (command === "api-server") {
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const request = JSON.parse(line) as { request_id?: string; method?: string; params?: Record<string, JsonValue> };
        if (!request.request_id || !request.method) throw new Error("request_id and method are required");
        const response = await invokeCommandApi({
          vaultRoot: parsed.vault,
          requestId: request.request_id,
          method: request.method as CommandApiMethod,
          params: request.params ?? {},
        });
        process.stdout.write(`${JSON.stringify(response)}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify({
          api_version: "1",
          request_id: null,
          method: "unknown",
          state: "failed",
          ok: false,
          data: null,
          error: { message: error instanceof Error ? error.message : String(error) },
        })}\n`);
      }
    }
    return;
  }

  if (command === "vault" && subcommand === "init") {
    if (!value && !parsed.vaultExplicit) {
      throw new Error("vault init 需要明确指定 Vault 路径");
    }
    const result = await initializeVault(value ? path.resolve(value) : parsed.vault, parsed.gitMode);
    await syncInstalledConfiguration(result.vault);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "config" && subcommand === "sync") {
    console.log(JSON.stringify(await syncInstalledConfiguration(parsed.vault), null, 2));
    return;
  }

  if (command === "module" && subcommand === "blueprint" && value === "validate") {
    const blueprintPath = parsed.positional[3];
    if (!blueprintPath) throw new Error("module blueprint validate requires BLUEPRINT");
    const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const { report } = await validateModuleBlueprint(engineRoot, path.resolve(blueprintPath));
    console.log(JSON.stringify(report, null, 2)); process.exitCode = report.overall === "FAIL" ? 1 : 0; return;
  }
  if (command === "module" && (subcommand === "create" || subcommand === "scaffold") && value === "--from") {
    const blueprintPath = parsed.positional[3];
    if (!blueprintPath) throw new Error(`module ${subcommand} --from requires BLUEPRINT`);
    const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    console.log(JSON.stringify(await scaffoldModuleFromBlueprint(engineRoot, path.resolve(blueprintPath), parsed.vaultExplicit ? { modulesRoot: path.join(parsed.vault, "90-System", "Module Development") } : {}), null, 2)); return;
  }
  if (command === "module" && subcommand === "create") {
    if (!value) throw new Error("module create requires MODULE_ID");
    const template = parsed.positional[3] as ModuleTemplate | undefined;
    if (!template) throw new Error("module create requires a template");
    const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    console.log(JSON.stringify(await createModuleScaffold(engineRoot, value, template, parsed.positional[4] ?? value, parsed.vaultExplicit ? { modulesRoot: path.join(parsed.vault, "90-System", "Module Development") } : {}), null, 2)); return;
  }
  if (command === "module" && subcommand === "validate") {
    if (!value) throw new Error(`module ${subcommand} requires MODULE_ID`);
    const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const report = await validateModule(engineRoot, await moduleSourceRoot(engineRoot, parsed.vault, parsed.vaultExplicit, value), { writeReport: true });
    console.log(JSON.stringify(report, null, 2)); process.exitCode = report.overall === "FAIL" ? 1 : 0; return;
  }
  if (command === "module" && subcommand === "test") {
    if (!value) throw new Error("module test requires MODULE_ID");
    const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const report = await testModule(engineRoot, value, { writeReport: true, moduleRoot: await moduleSourceRoot(engineRoot, parsed.vault, parsed.vaultExplicit, value) });
    console.log(JSON.stringify(report, null, 2)); process.exitCode = report.overall === "FAIL" ? 1 : 0; return;
  }
  if (command === "module" && subcommand === "sandbox") {
    if (!value) throw new Error("module sandbox requires MODULE_ID");
    const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const source = await moduleSourceRoot(engineRoot, parsed.vault, parsed.vaultExplicit, value);
    const report = await runModuleSandbox(engineRoot, value, { moduleRoot: source });
    await writeJsonAtomic(path.join(source, "sandbox-report.json"), report);
    console.log(JSON.stringify(report, null, 2)); process.exitCode = report.overall === "FAIL" ? 1 : 0; return;
  }
  if (command === "module" && subcommand === "readiness") {
    if (!value) throw new Error("module readiness requires MODULE_ID");
    const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    console.log(JSON.stringify(await getModuleReadiness(engineRoot, parsed.vault, value), null, 2)); return;
  }
  if (command === "module" && subcommand === "readiness-run") {
    if (!value) throw new Error("module readiness-run requires MODULE_ID");
    const action = parsed.positional[3] as ModuleReadinessAction | undefined;
    if (!action || !["implement-with-ai", "validate-manual", "test", "sandbox", "pack", "install", "implement", "validate"].includes(action)) throw new Error("module readiness-run requires implement-with-ai, validate-manual, test, sandbox, pack, or install.");
    const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    console.log(JSON.stringify(await runModuleReadinessAction(engineRoot, parsed.vault, value, action, { confirmBreaking: parsed.confirm }), null, 2)); return;
  }
  if (command === "module" && subcommand === "pack") {
    if (!value) throw new Error("module pack requires MODULE_ID");
    const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const source = await moduleSourceRoot(engineRoot, parsed.vault, parsed.vaultExplicit, value);
    const manifest = parseYaml(source, path.join(source, "module.yaml"));
    const output = parsed.positional[3] ? path.resolve(parsed.positional[3]!) : parsed.vaultExplicit ? path.join(parsed.vault, "90-System", "Modules", "Packages", value, `${String(manifest.version)}.pkb-module`) : undefined;
    console.log(JSON.stringify(await packModuleDirectory(engineRoot, source, output, { developerUnsafe: parsed.developerUnsafe }), null, 2)); return;
  }
  if (command === "module" && ["install", "upgrade"].includes(subcommand ?? "")) {
    if (!value) throw new Error(`module ${subcommand} requires PACKAGE`);
    const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    console.log(JSON.stringify(await installModulePackage(engineRoot, parsed.vault, path.resolve(value), { enable: true, upgrade: subcommand === "upgrade", confirmBreaking: parsed.confirm, developerUnsafe: parsed.developerUnsafe }), null, 2)); return;
  }
  if (command === "module" && subcommand === "rollback") {
    if (!value) throw new Error("module rollback requires MODULE_ID");
    const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    console.log(JSON.stringify(await rollbackModulePackage(engineRoot, parsed.vault, value), null, 2)); return;
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

  if (command === "migration" && subcommand === "rollback") {
    if (!value) throw new Error("migration rollback requires MIGRATION_RUN_ID");
    console.log(JSON.stringify(await rollbackMigration(parsed.vault, value), null, 2)); return;
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
    const result = await doctorVault(value ? path.resolve(value) : parsed.vault);
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
    warnLegacyApplicationAlias();
    if (!value) {
      throw new Error("缺少研究报告路径");
    }
    if (parsed.dryRun) throw new PkbError("DIRECT_WORKFLOW_DRY_RUN_UNSUPPORTED", "Use Inbox preview for a non-mutating application workflow preview.");
    const reportPath = path.resolve(parsed.vault, value);
    const document = parseMarkdown(parsed.vault, reportPath);
    if (typeof document.data.instance_id !== "string") throw new PkbError("MODULE_WORKFLOW_INSTANCE_REQUIRED", "A direct report invocation needs instance_id in frontmatter.");
    const result = await executeModuleWorkflowNow({ vaultRoot: parsed.vault, moduleId: "application-tracker", instanceId: document.data.instance_id, entrypoint: "capture", sourceFile: toVaultPath(parsed.vault, reportPath) });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "application" && subcommand === "research-sync") {
    warnLegacyApplicationAlias();
    const result = await syncDueResearchRequests(parsed.vault, "application-tracker");
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "application" && subcommand === "research-start") {
    warnLegacyApplicationAlias();
    if (!value) throw new Error("application research-start requires REQUEST_ID");
    console.log(JSON.stringify(await startResearchRequest(parsed.vault, "application-tracker", value), null, 2));
    return;
  }

  if (command === "dashboard" && subcommand === "build") {
    const today = await rebuildTodayDashboard(parsed.vault);
    console.log(JSON.stringify({ status: "built", today }, null, 2));
    return;
  }

  if (command === "runtime" && subcommand === "backup") {
    if (!value) throw new Error("runtime backup requires DESTINATION");
    const repository = await RuntimeRepository.open(parsed.vault);
    try { await repository.backup(path.resolve(value)); } finally { repository.close(); }
    console.log(JSON.stringify({ backup: path.resolve(value) }, null, 2)); return;
  }

  if (command === "runtime" && subcommand === "restore") {
    if (!value) throw new Error("runtime restore requires BACKUP");
    await restoreRuntimeDatabase(parsed.vault, path.resolve(value));
    const repository = await RuntimeRepository.open(parsed.vault);
    try { console.log(JSON.stringify({ restored: path.resolve(value), integrity: repository.integrityCheck(), schema_version: repository.schemaVersion() }, null, 2)); }
    finally { repository.close(); }
    return;
  }

  if (command === "runtime" && subcommand === "event-replay") {
    if (!value) throw new Error("runtime event-replay requires EVENT_ID");
    const subscriptionKeys = parsed.positional.slice(3);
    console.log(JSON.stringify(await replayRuntimeEvent(parsed.vault, value, subscriptionKeys.length ? subscriptionKeys : undefined), null, 2));
    return;
  }

  if (command === "runtime" && ["startup", "run-once", "watch"].includes(subcommand ?? "")) {
    const cycle = async (startup: boolean) => {
      const jobs = await registerDeclaredJobs(parsed.vault);
      const resources = await probeRuntimeResources(parsed.vault, {
        networkProbeUrl: process.env.KNOWLEDGEOS_NETWORK_PROBE_URL,
        codexExecutable: process.env.KNOWLEDGEOS_CODEX_EXECUTABLE,
      });
      const startupTask = startup ? await materializeStartupJobs(parsed.vault) : null;
      const fieldDue = await materializeFieldDueJobs(parsed.vault);
      const preparation = startup ? await reconcileStartup(parsed.vault) : { scheduler: await evaluateScheduler(parsed.vault) };
      const dispatch = await dispatchOnce({ vaultRoot: parsed.vault, limit: 2 });
      return { jobs_registered: jobs.length, resources, startup_task: startupTask, field_due: fieldDue, preparation, dispatch };
    };
    if (subcommand === "startup") { console.log(JSON.stringify(await cycle(true), null, 2)); return; }
    if (subcommand === "run-once") { console.log(JSON.stringify(await cycle(false), null, 2)); return; }
    console.log(JSON.stringify(await cycle(true), null, 2));
    const timer = setInterval(async () => console.log(JSON.stringify(await cycle(false))), 60_000);
    process.once("SIGINT", () => { clearInterval(timer); process.exitCode = 0; });
    process.once("SIGTERM", () => { clearInterval(timer); process.exitCode = 0; });
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
