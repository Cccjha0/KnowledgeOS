import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_API_VERSION, type CommandApiMethod, type CommandApiResponse, type CreateCaptureParams, type ResolveReviewParams, type UserFacingError } from "../api/types.js";
import { parseMarkdown } from "../core/bridge.js";
import { writeTodayMarkdown } from "../core/dashboard.js";
import { discoverInstances, discoverModules } from "../core/discovery.js";
import { PkbError } from "../core/errors.js";
import { exists, fromVaultPath, listFilesRecursive, readJson, toVaultPath, writeJsonAtomic } from "../core/files.js";
import { rollbackTransaction } from "../core/operationExecutor.js";
import type { JsonObject, JsonValue, ReviewItem, RunLog } from "../core/types.js";
import { decideReview, reconcileReviews, resolveReviewByUserEdit, retryReview } from "./reviewWorkflow.js";
import { getTodaySnapshot, rebuildTodayDashboard } from "./dashboard.js";
import { createCapture } from "./captureWorkflow.js";
import { buildDiscussionContext, buildReviewView, discussionContextIsCurrent } from "./reviewPresentation.js";
import { locateReviewItem, requeueDueReviews } from "../core/reviews.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REVIEW_DIRECTORIES = ["Pending", "Deferred", "Closed", "Error"] as const;

interface CommandContext {
  vaultRoot: string;
  requestId: string;
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
  await requeueDueReviews(vaultRoot);
  const requested = Array.isArray(params.statuses)
    ? new Set(params.statuses.filter((value): value is string => typeof value === "string"))
    : new Set(["pending", "error"]);
  const moduleId = typeof params.module_id === "string" ? params.module_id : null;
  const instanceId = typeof params.instance_id === "string" ? params.instance_id : null;
  const priority = typeof params.priority === "string" ? params.priority : null;
  const action = typeof params.action === "string" ? params.action : null;
  const createdFrom = typeof params.created_from === "string" ? Date.parse(params.created_from) : null;
  const createdTo = typeof params.created_to === "string" ? Date.parse(params.created_to) : null;
  const reviewAfterFrom = typeof params.review_after_from === "string" ? Date.parse(params.review_after_from) : null;
  const reviewAfterTo = typeof params.review_after_to === "string" ? Date.parse(params.review_after_to) : null;
  const result: Array<Awaited<ReturnType<typeof buildReviewView>>> = [];
  for (const directory of REVIEW_DIRECTORIES) {
    for (const file of await listFilesRecursive(path.join(vaultRoot, "90-System", "Review Queue", directory), ".md")) {
      const item = parseMarkdown(vaultRoot, file).data as unknown as ReviewItem;
      if (!requested.has(item.status)) continue;
      if (moduleId && item.source_module !== moduleId) continue;
      if (instanceId && item.instance_id !== instanceId) continue;
      if (priority && item.priority !== priority) continue;
      if (action && item.action !== action) continue;
      const created = Date.parse(item.created);
      if (createdFrom !== null && created < createdFrom) continue;
      if (createdTo !== null && created > createdTo) continue;
      const reviewAfter = item.review_after ? Date.parse(item.review_after) : null;
      if (reviewAfterFrom !== null && (reviewAfter === null || reviewAfter < reviewAfterFrom)) continue;
      if (reviewAfterTo !== null && (reviewAfter === null || reviewAfter > reviewAfterTo)) continue;
      result.push(await buildReviewView(vaultRoot, item, toVaultPath(vaultRoot, file)));
    }
  }
  const priorityWeight: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return result.sort((a, b) =>
    (priorityWeight[a.priority] ?? 9) - (priorityWeight[b.priority] ?? 9) ||
    Date.parse(a.created_at) - Date.parse(b.created_at),
  );
}

async function resolveReviewCommand(vaultRoot: string, params: JsonObject): Promise<JsonValue> {
  const input = params as unknown as ResolveReviewParams;
  const reviewId = stringParam(params, "review_id");
  const mode = input.mode ?? "decide";
  if (mode === "prepare-discussion") {
    const located = await locateReviewItem(vaultRoot, reviewId);
    if (located.item.status !== "pending") throw new PkbError("REVIEW_ALREADY_PROCESSED", "Only pending reviews can enter discussion.");
    return buildDiscussionContext(vaultRoot, located.item, toVaultPath(vaultRoot, located.filePath));
  }
  if (mode === "reconcile") return reconcileReviews(vaultRoot, reviewId) as unknown as JsonValue;
  if (mode === "retry") return retryReview(vaultRoot, reviewId) as unknown as JsonValue;
  if (mode === "mark-resolved-by-user-edit") {
    return resolveReviewByUserEdit(vaultRoot, reviewId, input.user_comment) as unknown as JsonValue;
  }
  if (mode === "apply-discussion-result") {
    if (!input.context_token || !input.discussion_result) {
      throw new PkbError("INVALID_REQUEST", "context_token and discussion_result are required.");
    }
    const located = await locateReviewItem(vaultRoot, reviewId);
    const current = await buildDiscussionContext(vaultRoot, located.item, toVaultPath(vaultRoot, located.filePath));
    if (!discussionContextIsCurrent(input.context_token, current)) {
      throw new PkbError("DISCUSSION_CONTEXT_STALE", "The Review or target field changed during discussion.");
    }
    const discussion = input.discussion_result;
    const allowed = new Set(["approve", "approve-with-modification", "reject", "continue-waiting", "needs-more-information"]);
    if (!allowed.has(discussion.outcome) || !discussion.user_comment?.trim()) {
      throw new PkbError("INVALID_DISCUSSION_RESULT", "Discussion outcome and user_comment are required.");
    }
    if (discussion.outcome === "approve-with-modification" && discussion.modified_value === undefined) {
      throw new PkbError("MODIFIED_VALUE_REQUIRED", "The discussion result requires modified_value.");
    }
    const receivedAt = new Date().toISOString();
    const recordPath = path.join(
      vaultRoot, "90-System", "State", "Review Discussions", reviewId,
      `${receivedAt.replace(/[:.]/g, "-")}.json`,
    );
    const mappedDecision = discussion.outcome === "continue-waiting" || discussion.outcome === "needs-more-information"
      ? "discuss"
      : discussion.outcome;
    const record: JsonObject = {
      protocol_version: 1,
      review_id: reviewId,
      context_token: input.context_token,
      outcome: discussion.outcome,
      user_comment: discussion.user_comment,
      modified_value: discussion.modified_value ?? null,
      received_at: receivedAt,
      execution_result: null,
    };
    await writeJsonAtomic(recordPath, record);
    const result = await decideReview({
      vaultRoot,
      reviewId,
      decision: mappedDecision,
      userComment: `${discussion.outcome}: ${discussion.user_comment}`,
      modifiedValue: discussion.modified_value,
    });
    record.execution_result = result as unknown as JsonValue;
    await writeJsonAtomic(recordPath, record);
    return { ...result, discussion_record: toVaultPath(vaultRoot, recordPath) } as unknown as JsonValue;
  }
  if (!["approve", "approve-with-modification", "reject", "defer", "discuss"].includes(input.decision ?? "")) {
    throw new PkbError("INVALID_REQUEST", "decision is invalid.");
  }
  return decideReview({
    vaultRoot,
    reviewId,
    decision: input.decision!,
    userComment: input.user_comment,
    reviewAfter: input.review_after,
    modifiedValue: input.modified_value,
  }) as unknown as JsonValue;
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
  const { vaultRoot, requestId, method, params } = context;
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
  if (method === "resolveReview") return resolveReviewCommand(vaultRoot, params);
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
  if (method === "createCapture") {
    return createCapture({
      vaultRoot,
      requestId,
      params: params as unknown as CreateCaptureParams,
    });
  }
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
    CAPTURE_CONTENT_REQUIRED: { impact: "没有创建 Capture 文件。", actions: ["输入内容后重新保存"], retryable: true },
    CAPTURE_IN_PROGRESS: { impact: "系统没有创建重复文件。", actions: ["稍后刷新 Today", "若未出现则重试"], retryable: true },
    IDEMPOTENCY_CONFLICT: { impact: "系统拒绝覆盖先前的 Capture 请求。", actions: ["保留输入并重新打开 Capture"], retryable: false },
    ATTACHMENT_NOT_FOUND: { impact: "Capture 和附件均未修改。", actions: ["移除无效附件", "确认附件路径后重试"], retryable: true },
    GIT_WORKTREE_DIRTY: { impact: "Capture 尚未写入，输入仍保留在表单中。", actions: ["提交或暂存现有 Vault 修改", "然后重试保存"], retryable: true },
    DISCUSSION_CONTEXT_STALE: { impact: "没有执行讨论结论，也没有修改目标文件。", actions: ["重新加载审核详情", "重新生成讨论上下文"], retryable: true },
    REVIEW_ALREADY_PROCESSED: { impact: "没有重复执行审核决定。", actions: ["刷新审核列表", "查看审核历史"], retryable: false },
    REVIEW_IN_PROGRESS: { impact: "系统拒绝了重复执行，现有请求仍在继续。", actions: ["等待当前处理完成", "刷新审核列表"], retryable: true },
    MODIFIED_VALUE_REQUIRED: { impact: "审核决定尚未执行。", actions: ["填写修改后的值", "重新提交决定"], retryable: true },
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
    const data = await execute({ vaultRoot: options.vaultRoot, requestId: options.requestId, method: options.method, params: options.params ?? {} });
    const state = data && typeof data === "object" && !Array.isArray(data) && data.ui_state === "waiting-for-ai"
      ? "waiting-for-ai"
      : "completed";
    return {
      api_version: COMMAND_API_VERSION,
      request_id: options.requestId,
      method: options.method,
      state,
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
