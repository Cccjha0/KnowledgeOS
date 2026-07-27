import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_API_VERSION, type CommandApiMethod, type CommandApiResponse, type ResolveReviewParams, type UserFacingError } from "../api/types.js";
import { parseMarkdown } from "../core/bridge.js";
import { writeTodayMarkdown } from "../core/dashboard.js";
import { discoverInstances, discoverModules } from "../core/discovery.js";
import { PkbError } from "../core/errors.js";
import { exists, fromVaultPath, listFilesRecursive, readJson, toVaultPath } from "../core/files.js";
import { rollbackTransaction } from "../core/operationExecutor.js";
import type { JsonObject, JsonValue, ReviewItem, RunLog } from "../core/types.js";
import { decideReview } from "./reviewWorkflow.js";
import { getTodaySnapshot, rebuildTodayDashboard } from "./dashboard.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REVIEW_DIRECTORIES = ["Pending", "Deferred", "Closed", "Error"] as const;

interface CommandContext {
  vaultRoot: string;
  method: CommandApiMethod;
  params: JsonObject;
}

function stringParam(params: JsonObject, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) throw new PkbError("INVALID_REQUEST", `${key} is required.`);
  return value;
}

function capabilityNotReady(method: CommandApiMethod, milestone: string): never {
  throw new PkbError(
    "CAPABILITY_NOT_READY",
    `${method} is part of the frozen API but will be enabled in ${milestone}.`,
    { method, milestone },
  );
}

async function listReviews(vaultRoot: string, params: JsonObject): Promise<JsonValue> {
  const requested = Array.isArray(params.statuses) ? new Set(params.statuses.filter((value): value is string => typeof value === "string")) : null;
  const moduleId = typeof params.module_id === "string" ? params.module_id : null;
  const instanceId = typeof params.instance_id === "string" ? params.instance_id : null;
  const priority = typeof params.priority === "string" ? params.priority : null;
  const result: JsonValue[] = [];
  for (const directory of REVIEW_DIRECTORIES) {
    for (const file of await listFilesRecursive(path.join(vaultRoot, "90-System", "Review Queue", directory), ".md")) {
      const item = parseMarkdown(vaultRoot, file).data as unknown as ReviewItem;
      if (requested && !requested.has(item.status)) continue;
      if (moduleId && item.source_module !== moduleId) continue;
      if (instanceId && item.instance_id !== instanceId) continue;
      if (priority && item.priority !== priority) continue;
      result.push({ ...item, vault_path: toVaultPath(vaultRoot, file) });
    }
  }
  return result;
}

async function listRuns(vaultRoot: string, params: JsonObject): Promise<JsonValue> {
  const limit = typeof params.limit === "number" ? Math.max(1, Math.min(100, Math.floor(params.limit))) : 20;
  const requestedStatus = typeof params.status === "string" ? params.status : null;
  const runs: Array<RunLog & { vault_path: string; can_rollback: boolean }> = [];
  for (const file of await listFilesRecursive(path.join(vaultRoot, "90-System", "Logs"), ".md")) {
    const data = parseMarkdown(vaultRoot, file).data;
    if (typeof data.run_id !== "string") continue;
    const run = data as unknown as RunLog;
    if (requestedStatus && run.status !== requestedStatus) continue;
    runs.push({ ...run, vault_path: toVaultPath(vaultRoot, file), can_rollback: run.status === "completed" && run.plan_id !== null });
  }
  return runs.sort((a, b) => Date.parse(b.completed_at) - Date.parse(a.completed_at)).slice(0, limit);
}

async function findRun(vaultRoot: string, runId: string): Promise<{ log: RunLog; path: string; content: string }> {
  const file = path.join(vaultRoot, "90-System", "Logs", `${runId}.md`);
  if (!(await exists(file))) throw new PkbError("RUN_NOT_FOUND", `Run ${runId} was not found.`);
  const document = parseMarkdown(vaultRoot, file);
  return { log: document.data as unknown as RunLog, path: toVaultPath(vaultRoot, file), content: document.content };
}

async function execute(context: CommandContext): Promise<JsonValue> {
  const { vaultRoot, method, params } = context;
  if (method === "getTodayItems") {
    const snapshot = await getTodaySnapshot(vaultRoot);
    if (params.refresh_markdown !== false) await writeTodayMarkdown(vaultRoot, snapshot);
    return snapshot;
  }
  if (method === "listInboxItems") {
    const snapshot = await getTodaySnapshot(vaultRoot);
    const moduleId = typeof params.module_id === "string" ? params.module_id : null;
    const instanceId = typeof params.instance_id === "string" ? params.instance_id : null;
    return snapshot.inbox.filter((group) =>
      (!moduleId || group.source_module === moduleId) && (!instanceId || group.instance_id === instanceId),
    );
  }
  if (method === "listReviewItems") return listReviews(vaultRoot, params);
  if (method === "resolveReview") {
    const input = params as unknown as ResolveReviewParams;
    if (!["approve", "approve-with-modification", "reject", "defer", "discuss"].includes(input.decision)) {
      throw new PkbError("INVALID_REQUEST", "decision is invalid.");
    }
    return decideReview({
      vaultRoot,
      reviewId: stringParam(params, "review_id"),
      decision: input.decision,
      userComment: input.user_comment,
      reviewAfter: input.review_after,
      modifiedValue: input.modified_value,
    }) as unknown as JsonValue;
  }
  if (method === "getModules") {
    const instances = await discoverInstances(vaultRoot);
    const modules = await discoverModules(ENGINE_ROOT);
    return modules.map((module) => ({
      id: module.data.id,
      name: module.data.name,
      version: module.data.version,
      status: module.data.status,
      description: module.data.description,
      active_instance_count: instances.filter((instance) => instance.data.module_id === module.data.id && instance.data.status === "active").length,
    })) as JsonValue;
  }
  if (method === "getInstances") {
    const moduleId = typeof params.module_id === "string" ? params.module_id : null;
    const instances = await discoverInstances(vaultRoot);
    return instances.filter((instance) => !moduleId || instance.data.module_id === moduleId).map((instance) => instance.data) as JsonValue;
  }
  if (method === "getRecentRuns") return listRuns(vaultRoot, params);
  if (method === "getRunDetails") {
    const found = await findRun(vaultRoot, stringParam(params, "run_id"));
    const transaction = found.log.plan_id
      ? await readJson<JsonObject | null>(path.join(vaultRoot, "90-System", "Logs", "Transactions", `${found.log.plan_id}.json`), null)
      : null;
    return { ...found, transaction } as unknown as JsonValue;
  }
  if (method === "rollbackRun") {
    const found = await findRun(vaultRoot, stringParam(params, "run_id"));
    if (!found.log.plan_id) throw new PkbError("RUN_NOT_ROLLBACKABLE", "This run has no Operation Plan snapshot.");
    const status = await rollbackTransaction(vaultRoot, found.log.plan_id);
    await rebuildTodayDashboard(vaultRoot);
    return { run_id: found.log.run_id, plan_id: found.log.plan_id, status };
  }
  if (method === "createCapture") return capabilityNotReady(method, "F03");
  if (method === "processInboxItem" || method === "processInboxBatch") return capabilityNotReady(method, "F04");
  throw new PkbError("METHOD_NOT_FOUND", `Unknown Core Command API method: ${method}`);
}

function userFacingError(error: unknown): UserFacingError {
  const code = error instanceof PkbError ? error.code : "UNEXPECTED_ERROR";
  const technical = error instanceof PkbError ? error.details : error instanceof Error ? error.stack ?? error.message : String(error);
  const messages: Record<string, { impact: string; actions: string[]; retryable: boolean }> = {
    CAPABILITY_NOT_READY: { impact: "未修改任何 Vault 文件。", actions: ["升级到对应里程碑后重试"], retryable: false },
    INVALID_REQUEST: { impact: "请求未执行。", actions: ["检查输入后重试"], retryable: true },
    RUN_NOT_FOUND: { impact: "没有执行撤销或读取操作。", actions: ["刷新运行历史", "确认 Run ID"], retryable: true },
    RUN_NOT_ROLLBACKABLE: { impact: "现有文件保持不变。", actions: ["查看 Run 详情", "使用 Git 历史人工恢复"], retryable: false },
  };
  const guidance = messages[code] ?? { impact: "操作未能完整完成，请查看详情确认文件状态。", actions: ["刷新页面", "查看运行日志", "修复问题后重试"], retryable: true };
  const message = error instanceof Error ? error.message : String(error);
  return {
    code,
    message,
    what_happened: message,
    impact: guidance.impact,
    recovery_actions: guidance.actions,
    retryable: guidance.retryable,
    technical_details: technical === undefined ? null : technical as JsonValue,
  };
}

export async function invokeCommandApi(options: {
  vaultRoot: string;
  requestId: string;
  method: CommandApiMethod;
  params?: JsonObject;
}): Promise<CommandApiResponse> {
  try {
    const data = await execute({ vaultRoot: options.vaultRoot, method: options.method, params: options.params ?? {} });
    return {
      api_version: COMMAND_API_VERSION,
      request_id: options.requestId,
      method: options.method,
      state: "completed",
      ok: true,
      data,
      error: null,
    };
  } catch (error) {
    return {
      api_version: COMMAND_API_VERSION,
      request_id: options.requestId,
      method: options.method,
      state: "failed",
      ok: false,
      data: null,
      error: userFacingError(error),
    };
  }
}
