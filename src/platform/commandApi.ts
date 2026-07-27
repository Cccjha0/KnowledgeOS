import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_API_VERSION, type CommandApiMethod, type CommandApiResponse, type CreateCaptureParams, type CreateInstanceParams, type ManageInstanceParams, type ManageModuleParams, type ProcessInboxBatchParams, type ProcessInboxItemParams, type ResolveReviewParams, type UserFacingError } from "../api/types.js";
import { parseMarkdown } from "../core/bridge.js";
import { writeTodayMarkdown } from "../core/dashboard.js";
import { discoverInstances, discoverModulesForVault } from "../core/discovery.js";
import { PkbError } from "../core/errors.js";
import { fromVaultPath, listFilesRecursive, toVaultPath, writeJsonAtomic } from "../core/files.js";
import { rollbackTransaction } from "../core/operationExecutor.js";
import type { JsonObject, JsonValue, ReviewItem, RunLog } from "../core/types.js";
import { allocateId } from "../core/ids.js";
import { writeRunLog } from "../core/logs.js";
import { decideReview, reconcileReviews, resolveReviewByUserEdit, retryReview } from "./reviewWorkflow.js";
import { getTodaySnapshot, rebuildTodayDashboard } from "./dashboard.js";
import { createCapture } from "./captureWorkflow.js";
import { buildDiscussionContext, buildReviewView, discussionContextIsCurrent } from "./reviewPresentation.js";
import { locateReviewItem, requeueDueReviews } from "../core/reviews.js";
import { listInbox } from "./inboxDiscovery.js";
import { processInboxBatch, processInboxItem } from "./inboxWorkflow.js";
import { assessRunRollback, findRun, getRunView, listRunViews } from "./systemPresentation.js";
import { createInstance, manageInstance, manageModule } from "./lifecycleWorkflow.js";
import { dispatchOnce } from "../runtime/dispatcher.js";
import type { TaskStatus } from "../runtime/domain.js";
import { reconcileStartup } from "../runtime/reconciler.js";
import { RuntimeRepository } from "../runtime/repository.js";
import { evaluateScheduler } from "../runtime/scheduler.js";
import { registerDeclaredJobs } from "../runtime/jobRegistry.js";
import { platformRuntimeHandlers } from "./runtimeHandlers.js";

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

async function execute(context: CommandContext): Promise<JsonValue> {
  const { vaultRoot, requestId, method, params } = context;
  if (method === "getTodayItems") {
    const snapshot = await getTodaySnapshot(vaultRoot);
    if (params.refresh_markdown !== false) await writeTodayMarkdown(vaultRoot, snapshot);
    return snapshot;
  }
  if (method === "listInboxItems") {
    return listInbox(vaultRoot, params);
  }
  if (method === "listReviewItems") return listReviews(vaultRoot, params);
  if (method === "resolveReview") return resolveReviewCommand(vaultRoot, params);
  if (["listTasks", "getTaskDetails", "manageTask", "getTaskRuntimeStatus"].includes(method)) {
    const repository = await RuntimeRepository.open(vaultRoot);
    try {
      if (method === "listTasks") {
        const statuses = Array.isArray(params.statuses) ? params.statuses.filter((item): item is TaskStatus => typeof item === "string") : undefined;
        return repository.listTasks(statuses).slice(0, typeof params.limit === "number" ? params.limit : 200);
      }
      if (method === "getTaskDetails") {
        const task = repository.getTask(stringParam(params, "task_id"));
        if (!task) throw new PkbError("TASK_NOT_FOUND", `Task ${String(params.task_id)} was not found.`);
        return { task, runs: repository.getRuns(task.task_id) };
      }
      if (method === "getTaskRuntimeStatus") {
        const tasks = repository.listTasks();
        const counts: Record<string, number> = {};
        for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
        return { integrity: repository.integrityCheck(), counts, resources: repository.getResourceStatuses(), jobs: repository.listJobs(), checkpoints: repository.getCheckpoints() };
      }
      const taskId = stringParam(params, "task_id");
      const action = stringParam(params, "action");
      if (action === "retry" || action === "run-now") return repository.retryTask(taskId);
      if (action === "cancel") return repository.cancelTask(taskId);
      if (action === "defer") {
        const until = stringParam(params, "defer_until");
        if (!Number.isFinite(Date.parse(until)) || Date.parse(until) <= Date.now()) throw new PkbError("INVALID_REQUEST", "defer_until must be a future date-time.");
        let task = repository.getTask(taskId);
        if (!task) throw new PkbError("TASK_NOT_FOUND", `Task ${taskId} was not found.`);
        if (task.status !== "queued") task = repository.retryTask(taskId);
        return repository.transitionTask(task.task_id, "deferred", { deferUntil: until });
      }
      throw new PkbError("INVALID_REQUEST", `Unknown task action: ${action}`);
    } finally { repository.close(); }
  }
  if (method === "runTaskCycle") {
    const jobs = await registerDeclaredJobs(vaultRoot);
    const startup = params.startup === true ? await reconcileStartup(vaultRoot) : { scheduler: await evaluateScheduler(vaultRoot) };
    const dispatch = await dispatchOnce({ vaultRoot, limit: typeof params.limit === "number" ? params.limit : 2, handlers: platformRuntimeHandlers });
    return { jobs_registered: jobs.length, startup, dispatch } as unknown as JsonValue;
  }
  if (method === "getModules") {
    const instances = await discoverInstances(vaultRoot);
    const modules = await discoverModulesForVault(ENGINE_ROOT, vaultRoot);
    return modules.map((module) => ({
      id: module.data.id,
      name: module.data.name,
      version: module.data.version,
      status: module.data.status,
      description: module.data.description,
      active_instance_count: instances.filter((instance) => instance.data.module_id === module.data.id && instance.data.status === "active").length,
      instance_form: module.data.instance_form ?? null,
      available_actions: module.data.status === "enabled" ? ["disable", "validate", "create-instance"] : ["enable", "validate"],
    })) as JsonValue;
  }
  if (method === "getInstances") {
    const moduleId = typeof params.module_id === "string" ? params.module_id : null;
    const instances = await discoverInstances(vaultRoot);
    return instances.filter((instance) => !moduleId || instance.data.module_id === moduleId).map((instance) => ({
      ...instance.data,
      available_actions: instance.data.status === "active" ? ["pause", "complete", "archive"]
        : instance.data.status === "paused" ? ["resume", "complete", "archive"]
          : instance.data.status === "planned" ? ["activate", "archive"]
            : instance.data.status === "completed" || instance.data.status === "error" ? ["archive"] : [],
    })) as JsonValue;
  }
  if (method === "getRecentRuns") return listRunViews(vaultRoot, params);
  if (method === "getRunDetails") {
    const runId = stringParam(params, "run_id");
    const view = await getRunView(vaultRoot, runId, params.developer_mode === true);
    if (!view) throw new PkbError("RUN_NOT_FOUND", `Run ${runId} was not found.`);
    return view;
  }
  if (method === "rollbackRun") {
    const runId = stringParam(params, "run_id");
    const found = await findRun(vaultRoot, runId);
    if (!found) throw new PkbError("RUN_NOT_FOUND", `Run ${runId} was not found.`);
    const assessment = await assessRunRollback(vaultRoot, found.log);
    if (!assessment.can_rollback) throw new PkbError("RUN_NOT_ROLLBACKABLE", assessment.reasons.join(" "), assessment);
    if (assessment.requires_confirmation && params.confirm !== true) {
      throw new PkbError("ROLLBACK_CONFIRMATION_REQUIRED", "This rollback may affect later dependent runs and requires explicit confirmation.", assessment);
    }
    if (!found.log.plan_id) throw new PkbError("RUN_NOT_ROLLBACKABLE", "This run has no Operation Plan snapshot.");
    const status = await rollbackTransaction(vaultRoot, found.log.plan_id);
    let rollbackRunId: string | null = null;
    const warnings: string[] = [];
    try {
      rollbackRunId = await allocateId(vaultRoot, "RUN");
      const now = new Date().toISOString();
      const rollbackLog: RunLog = {
        run_id: rollbackRunId, task_id: null, plan_id: null, source_module: "core", instance_id: found.log.instance_id,
        review_id: null, status: "completed", git_snapshot: found.log.git_snapshot,
        started_at: now, completed_at: new Date().toISOString(), schema_version: 1,
      };
      await writeRunLog(vaultRoot, rollbackLog, `# ${rollbackRunId}\n\nRolled back ${found.log.run_id}.\n\n- Plan: ${found.log.plan_id}\n- Status: ${status}\n`);
    } catch (error) {
      warnings.push(`Rollback completed, but the audit Run could not be written: ${error instanceof Error ? error.message : String(error)}`);
    }
    try { await rebuildTodayDashboard(vaultRoot); }
    catch (error) { warnings.push(`Rollback completed, but Today could not be refreshed: ${error instanceof Error ? error.message : String(error)}`); }
    return { run_id: found.log.run_id, rollback_run_id: rollbackRunId, plan_id: found.log.plan_id, status, assessment, warnings };
  }
  if (method === "createCapture") {
    return createCapture({
      vaultRoot,
      requestId,
      params: params as unknown as CreateCaptureParams,
    });
  }
  if (method === "processInboxItem") return processInboxItem(vaultRoot, params as unknown as ProcessInboxItemParams);
  if (method === "processInboxBatch") return processInboxBatch(vaultRoot, params as unknown as ProcessInboxBatchParams);
  if (method === "manageModule") return manageModule(vaultRoot, params as unknown as ManageModuleParams);
  if (method === "createInstance") return createInstance(vaultRoot, params as unknown as CreateInstanceParams);
  if (method === "manageInstance") return manageInstance(vaultRoot, params as unknown as ManageInstanceParams);
  throw new PkbError("METHOD_NOT_FOUND", `Unknown Core Command API method: ${method}`);
}

function userFacingError(error: unknown): UserFacingError {
  const code = error instanceof PkbError ? error.code : "UNEXPECTED_ERROR";
  const technical = error instanceof PkbError ? error.details : error instanceof Error ? error.stack ?? error.message : String(error);
  const messages: Record<string, { impact: string; actions: string[]; retryable: boolean }> = {
    INVALID_REQUEST: { impact: "请求未执行。", actions: ["检查输入后重试"], retryable: true },
    INBOX_ITEM_NOT_FOUND: { impact: "没有处理任何文件。", actions: ["刷新 Inbox Center", "确认条目仍位于受管 Inbox"], retryable: true },
    INBOX_ITEM_IN_PROGRESS: { impact: "系统拒绝重复执行当前条目。", actions: ["等待当前处理完成", "刷新 Inbox Center"], retryable: true },
    INBOX_ROUTE_INVALID: { impact: "条目仍保留在原路径。", actions: ["重新选择已启用模块或活跃实例", "再次预览后处理"], retryable: true },
    INBOX_RETRY_REQUIRED: { impact: "失败条目没有被静默重复执行。", actions: ["查看失败原因", "点击重试"], retryable: true },
    DESTINATION_EXISTS: { impact: "系统没有覆盖同名文件。", actions: ["打开目标 Inbox 处理同名冲突", "刷新后重试"], retryable: true },
    RUN_NOT_FOUND: { impact: "没有执行撤销或读取操作。", actions: ["刷新运行历史", "确认 Run ID"], retryable: true },
    RUN_NOT_ROLLBACKABLE: { impact: "现有文件保持不变。", actions: ["查看 Run 详情", "使用 Git 历史人工恢复"], retryable: false },
    ROLLBACK_CONFIRMATION_REQUIRED: { impact: "尚未执行撤销。", actions: ["查看后续依赖 Run", "确认影响后再次撤销"], retryable: true },
    ROLLBACK_CONFLICT: { impact: "系统拒绝覆盖 Run 之后的用户修改。", actions: ["打开冲突文件", "使用 Git 历史人工比较"], retryable: false },
    MODULE_CONFIRMATION_REQUIRED: { impact: "模块状态尚未改变。", actions: ["查看停用影响", "确认后再次提交"], retryable: true },
    MODULE_DISABLED: { impact: "没有创建或处理实例数据。", actions: ["先启用模块", "刷新 System Center"], retryable: true },
    INSTANCE_CONFIRMATION_REQUIRED: { impact: "实例尚未归档。", actions: ["检查未处理 Inbox 和审核", "确认保留这些事项后归档"], retryable: true },
    INSTANCE_TRANSITION_INVALID: { impact: "实例状态保持不变。", actions: ["刷新实例状态", "选择当前状态允许的操作"], retryable: true },
    INSTANCE_EXISTS: { impact: "没有覆盖现有实例。", actions: ["使用新的实例 ID", "打开已有实例"], retryable: true },
    INSTANCE_FIELD_REQUIRED: { impact: "实例尚未创建。", actions: ["补充必填字段", "重新预览"], retryable: true },
    INVALID_INSTANCE_ID: { impact: "实例尚未创建。", actions: ["使用 3–128 位字母、数字、点、下划线或连字符", "重新预览"], retryable: true },
    INSTANCE_FIELD_UNKNOWN: { impact: "实例尚未创建。", actions: ["刷新模块表单", "移除模块未声明的字段"], retryable: true },
    INVALID_INSTANCE_PATH: { impact: "没有创建目录或实例配置。", actions: ["确保 Inbox 位于实例内容目录内", "重新预览"], retryable: true },
    MODULE_NOT_FOUND: { impact: "没有修改模块或实例。", actions: ["刷新 System Center", "同步或安装模块配置"], retryable: true },
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
    const requestedState = data && typeof data === "object" && !Array.isArray(data) ? data.ui_state : null;
    const state = requestedState === "waiting-for-ai" || requestedState === "waiting-for-user" ? requestedState : "completed";
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
