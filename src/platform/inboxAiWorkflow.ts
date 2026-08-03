import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMarkdown, validateSchema } from "../core/bridge.js";
import { PkbError } from "../core/errors.js";
import { fromVaultPath, readJson, writeJsonAtomic } from "../core/files.js";
import { createGitSnapshot } from "../core/git.js";
import { allocateId } from "../core/ids.js";
import { executeOperationPlan } from "../core/operationExecutor.js";
import type { JsonObject, JsonValue, OperationPlan } from "../core/types.js";
import type { RuntimeHandler } from "../runtime/worker.js";
import { executeCodexJson, resolveCodexModel, resolveCodexReasoningEffort } from "../runtime/codexCli.js";
import { runManagedCodexStep } from "../runtime/codexAdapter.js";
import { processApplicationReport } from "./applicationWorkflow.js";
import { discoverInboxItems, type InboxStateRecord, writeInboxState } from "./inboxDiscovery.js";
import { rebuildTodayDashboard } from "./dashboard.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPORT_SCHEMA = "https://pkb.local/schemas/application-tracker/research-report.schema.json";
const PROMPT_ID = "normalize-application-report";
const PROMPT_VERSION = "1.0.0";

type CodexJsonExecutor = typeof executeCodexJson;

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PkbError("CODEX_OUTPUT_INVALID", "Codex did not return a JSON object.");
  return value as JsonObject;
}

function reportId(taskId: string): string {
  const match = /^TASK-(\d{4})-(\d{6,})$/.exec(taskId);
  if (!match) throw new PkbError("INVALID_TASK_ID", `Cannot derive a Research Report ID from ${taskId}.`);
  return `RPT-${match[1]}-${match[2]}`;
}

async function promptFor(sourceFile: string, instanceId: string, fixedReportId: string, repairFormat: boolean): Promise<string> {
  const template = await fs.readFile(path.join(ENGINE_ROOT, "modules", "application-tracker", "prompts", "normalize-report", "v1.0.0.md"), "utf8");
  return [
    template,
    "",
    "# 本次输入",
    "",
    `- Vault 相对路径：${sourceFile}`,
    `- instance_id：${instanceId}`,
    `- report_id：${fixedReportId}`,
    "- 读取该文件的 frontmatter 和正文；不要读取其他私人文件。",
    repairFormat ? "- 上一次输出未通过 Schema；只修复结构和格式，不添加新事实。" : "",
  ].filter(Boolean).join("\n");
}

function normalizedReport(raw: JsonObject, taskId: string, runId: string, instanceId: string, model: string, reasoningEffort: string): JsonObject {
  const fixedReportId = reportId(taskId);
  const requestId = typeof raw.request_id === "string" && /^REQ-\d{4}-\d{6,}$/.test(raw.request_id) ? raw.request_id : null;
  return {
    ...raw,
    source_module: "application-tracker",
    type: "research-report",
    schema_version: 1,
    report_id: fixedReportId,
    research_type: "application-update",
    request_id: requestId,
    instance_id: instanceId,
    generation: {
      run_id: runId,
      module: { id: "application-tracker", version: "0.2.0" },
      workflow: { id: "process-research-report", version: "1.0.0" },
      prompt: { id: PROMPT_ID, version: PROMPT_VERSION },
      adapter: "codex-cli",
       model,
       reasoning_effort: reasoningEffort,
      generated_at: new Date().toISOString(),
    },
  };
}

async function writeState(vaultRoot: string, item: Awaited<ReturnType<typeof discoverInboxItems>>[number], state: InboxStateRecord["state"], taskId: string, runId: string, overrides: Partial<InboxStateRecord> = {}): Promise<void> {
  await writeInboxState(vaultRoot, {
    schema_version: 1, item_id: item.item_id, path: item.path, state,
    attempts: Number(overrides.attempts ?? 1), review_after: overrides.review_after ?? null,
    error: overrides.error ?? null, run_id: overrides.run_id ?? runId, plan_id: overrides.plan_id ?? null,
    task_id: taskId, result: overrides.result ?? null, updated_at: new Date().toISOString(),
  });
}

export function createProcessApplicationInboxAi(executeJson: CodexJsonExecutor = executeCodexJson): RuntimeHandler {
  return async ({ vaultRoot, task, runId, checkpoint }) => {
  const itemId = String(task.payload.item_id ?? "");
  const sourceFile = String(task.payload.source_file ?? "");
  const instanceId = task.instance_id ?? String(task.payload.instance_id ?? "");
  if (!itemId || !sourceFile || !instanceId) throw new PkbError("INVALID_REQUEST", "Inbox AI Task is missing item, source, or instance context.");
  const item = (await discoverInboxItems(vaultRoot)).find((candidate) => candidate.item_id === itemId);
  if (!item) {
    const statePath = path.join(vaultRoot, "90-System", "State", "Inbox", `${itemId}.json`);
    const previous = await readJson<InboxStateRecord | null>(statePath, null);
    if (previous?.state === "processed") {
      const previousResult = previous.result && typeof previous.result === "object" && !Array.isArray(previous.result) ? previous.result as JsonObject : {};
      await writeInboxState(vaultRoot, {
        ...previous,
        task_id: task.task_id,
        result: { ...previousResult, task_id: task.task_id, runtime_run_id: runId, reconciled: true },
        updated_at: new Date().toISOString(),
      });
      return { completion_reason: "inbox-item-already-processed", output_files: [String(previousResult.destination ?? "")].filter(Boolean), metrics: { skipped: 1, reconciled: 1 } as JsonObject };
    }
    return { completion_reason: "inbox-item-no-longer-pending", input_files: [sourceFile], metrics: { skipped: 1 } as JsonObject };
  }
  await writeState(vaultRoot, item, "processing", task.task_id, runId, { attempts: task.attempt_count + 1 });
  try {
    checkpoint();
    let normalizationPlanId: string | null = null;
    if (item.processor !== "application-research-report") {
      const fixedReportId = reportId(task.task_id);
      const model = resolveCodexModel(typeof task.payload.codex_model === "string" ? task.payload.codex_model : undefined);
      const reasoningEffort = resolveCodexReasoningEffort(typeof task.payload.codex_reasoning_effort === "string" ? task.payload.codex_reasoning_effort : undefined);
      const managed = await runManagedCodexStep(vaultRoot, {
        task_id: task.task_id, run_id: runId, prompt_id: PROMPT_ID, prompt_version: PROMPT_VERSION,
        adapter: "codex-cli", model, reasoning_effort: reasoningEffort, output_schema: REPORT_SCHEMA, max_format_attempts: 3,
        module: "application-tracker", instance_id: instanceId, workflow_id: "process-research-report", workflow_version: "1.0.0",
      }, async ({ repair_format }) => {
        const result = await executeJson({ vaultRoot, model, reasoningEffort, prompt: await promptFor(sourceFile, instanceId, fixedReportId, repair_format) });
        return { output: normalizedReport(object(result.output), task.task_id, runId, instanceId, model, reasoningEffort) as JsonValue };
      }, (output) => {
        try { validateSchema(vaultRoot, REPORT_SCHEMA, output); return true; } catch { return false; }
      });
      const report = object(managed.output);
      const document = parseMarkdown(vaultRoot, fromVaultPath(vaultRoot, sourceFile));
      const removeTopLevel = Object.keys(document.data).filter((key) => !(key in report));
      normalizationPlanId = await allocateId(vaultRoot, "PLAN");
      const plan: OperationPlan = {
        plan_id: normalizationPlanId, task_id: task.task_id, source_module: "application-tracker", instance_id: instanceId,
        summary: "Normalize an application Inbox document into a validated Research Report",
        operations: [{
          operation_id: "OP-001", type: "update-frontmatter", target: sourceFile, risk: "green", confidence: Number(report.confidence ?? 0),
          idempotency_key: `inbox-normalize:${task.idempotency_key}`, requires_review_id: null,
          payload: { patch: report, replace_top_level: Object.keys(report), remove_top_level: removeTopLevel, schema_id: REPORT_SCHEMA, actor: "ai" },
        }], review_items: [],
      };
      await writeJsonAtomic(path.join(vaultRoot, "90-System", "State", "Plans", `${normalizationPlanId}.json`), plan);
      const snapshot = await createGitSnapshot(vaultRoot, runId);
      await executeOperationPlan(vaultRoot, plan, { allowedTypes: ["update-frontmatter"], allowedTargets: [sourceFile], requiredReviewId: null, gitSnapshot: snapshot });
      checkpoint();
    }
    const processed = await processApplicationReport({ vaultRoot, reportPath: sourceFile });
    await writeState(vaultRoot, item, "processed", task.task_id, runId, {
      attempts: task.attempt_count + 1, run_id: processed.runId, plan_id: processed.planPath ? path.basename(processed.planPath, ".json") : normalizationPlanId,
      result: { status: processed.status, task_id: task.task_id, runtime_run_id: runId, destination: processed.destination, review_count: processed.reviewCount },
    });
    return {
      completion_reason: processed.status === "already-processed" ? "application-report-already-processed" : "application-report-processed",
      operation_plan_id: processed.planPath ? path.basename(processed.planPath, ".json") : normalizationPlanId,
      git_snapshot_id: processed.snapshot, input_files: [sourceFile], output_files: processed.destination ? [processed.destination] : [],
      metrics: { files_read: 1, files_written: processed.destination ? 1 : 0, reviews_created: processed.reviewCount, codex_calls: item.processor === "application-research-report" ? 0 : 1 } as JsonObject,
    };
  } catch (error) {
    await writeState(vaultRoot, item, "failed", task.task_id, runId, { attempts: task.attempt_count + 1, error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
    await rebuildTodayDashboard(vaultRoot).catch(() => undefined);
    throw error;
  }
  };
}

export const processApplicationInboxAi = createProcessApplicationInboxAi();
