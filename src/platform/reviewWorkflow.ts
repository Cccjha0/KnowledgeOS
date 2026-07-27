import path from "node:path";
import type {
  ApplicationFact,
  ApplicationRecord,
  JsonObject,
  JsonValue,
  MarkdownDocument,
  Operation,
  OperationPlan,
  ReviewDecision,
  ReviewDecisionKind,
  ReviewItem,
  ReviewStatus,
  ReviewTargetObservation,
} from "../types.js";
import { parseMarkdown, validateSchema } from "../core/bridge.js";
import { rebuildTodayDashboard } from "./dashboard.js";
import { PkbError } from "../core/errors.js";
import {
  deepEqual,
  fromVaultPath,
  listFilesRecursive,
  toVaultPath,
  uniqueJsonValues,
  writeJsonAtomic,
} from "../core/files.js";
import { createGitSnapshot } from "../core/git.js";
import { allocateId } from "../core/ids.js";
import { writeRunLog } from "../core/logs.js";
import { executeOperationPlan } from "../core/operationExecutor.js";
import {
  locateReviewItem,
  persistReviewItem,
  requeueDueReviews,
  type LocatedReview,
} from "../core/reviews.js";

const SCHEMAS = {
  decision: "https://pkb.local/schemas/core/review-decision.schema.json",
  review: "https://pkb.local/schemas/core/review-item.schema.json",
  plan: "https://pkb.local/schemas/core/operation-plan.schema.json",
  record: "https://pkb.local/schemas/application-tracker/application-record.schema.json",
} as const;

export const REVIEW_STATE_MACHINE: Record<ReviewStatus, {
  entersFrom: Array<ReviewStatus | "initial">;
  decisionMutable: boolean;
  showInToday: boolean;
  operationPlan: "required" | "empty" | "none";
  closed: boolean;
}> = {
  pending: {
    entersFrom: ["initial", "deferred", "error"],
    decisionMutable: true,
    showInToday: true,
    operationPlan: "none",
    closed: false,
  },
  approved: {
    entersFrom: ["pending"],
    decisionMutable: false,
    showInToday: false,
    operationPlan: "required",
    closed: true,
  },
  "approved-with-modification": {
    entersFrom: ["pending"],
    decisionMutable: false,
    showInToday: false,
    operationPlan: "required",
    closed: true,
  },
  rejected: {
    entersFrom: ["pending"],
    decisionMutable: false,
    showInToday: false,
    operationPlan: "empty",
    closed: true,
  },
  deferred: {
    entersFrom: ["pending"],
    decisionMutable: false,
    showInToday: false,
    operationPlan: "none",
    closed: false,
  },
  "resolved-by-user-edit": {
    entersFrom: ["pending"],
    decisionMutable: false,
    showInToday: false,
    operationPlan: "none",
    closed: true,
  },
  error: {
    entersFrom: ["pending"],
    decisionMutable: false,
    showInToday: true,
    operationPlan: "none",
    closed: false,
  },
};

export interface DecideReviewOptions {
  vaultRoot: string;
  reviewId: string;
  decision: ReviewDecisionKind;
  userComment?: string;
  reviewAfter?: string | null;
  modifiedValue?: JsonValue;
  now?: string;
}

export interface ReviewActionResult {
  status: ReviewStatus;
  reviewId: string;
  runId: string | null;
  planPath: string | null;
  snapshot: string | null;
  reviewPath: string;
  todayPath: string;
}

export interface ReconcileResult {
  requeued: string[];
  resolved: string[];
  warnings: string[];
  unchanged: string[];
  todayPath: string;
}

function proposedObject(item: ReviewItem): JsonObject {
  if (!item.proposed_value || typeof item.proposed_value !== "object" || Array.isArray(item.proposed_value)) {
    throw new PkbError("INVALID_REVIEW", "审核项 proposed_value 必须是对象。", item.review_id);
  }
  return item.proposed_value as JsonObject;
}

function fieldFromReview(item: ReviewItem): string {
  const field = proposedObject(item).field;
  if (typeof field !== "string" || !field) {
    throw new PkbError("INVALID_REVIEW", "审核项缺少目标字段。", item.review_id);
  }
  return field;
}

function targetAbsolute(vaultRoot: string, item: ReviewItem): string {
  const absolute = fromVaultPath(vaultRoot, item.target);
  const relativePath = path.relative(vaultRoot, absolute);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new PkbError("PERMISSION_DENIED", "审核目标位于 Vault 之外。", item.target);
  }
  return absolute;
}

function currentFieldValue(record: ApplicationRecord, field: string): JsonValue {
  if (field === "application_status") {
    return record.application_status;
  }
  return record.facts[field]?.value ?? null;
}

function expectedApplicationStatus(field: string, value: JsonValue, proposed: JsonObject): string | null {
  if (field === "application_status" && typeof value === "string") {
    return value;
  }
  if (field === "application_open") {
    if (value === true) {
      return "open";
    }
    if (value === false) {
      return "not-open";
    }
  }
  return typeof proposed.application_status === "string" ? proposed.application_status : null;
}

function buildRecordPatch(
  record: ApplicationRecord,
  item: ReviewItem,
  decision: ReviewDecision,
): { patch: JsonObject; effectiveValue: JsonValue; field: string } {
  const proposed = proposedObject(item);
  const field = fieldFromReview(item);
  const effectiveValue = decision.decision === "approve-with-modification"
    ? structuredClone(decision.modified_value ?? null)
    : structuredClone(proposed.new_value ?? null);
  const patch: JsonObject = { updated: decision.decided_at };
  const status = expectedApplicationStatus(field, effectiveValue, proposed);

  if (field === "application_status") {
    if (typeof effectiveValue !== "string") {
      throw new PkbError("INVALID_MODIFIED_VALUE", "application_status 必须是字符串。", effectiveValue);
    }
    patch.application_status = effectiveValue;
  } else {
    const current = record.facts[field];
    const sourceRefs = uniqueJsonValues([
      ...(current?.source_refs ?? []),
      ...item.evidence,
    ]).filter((value): value is string => typeof value === "string");
    const fact: ApplicationFact = {
      value: effectiveValue,
      status: "confirmed",
      confidence: item.confidence,
      checked_at: decision.decided_at,
      source_refs: sourceRefs,
      notes: decision.user_comment || `由审核 ${item.review_id} 批准。`,
    };
    patch.facts = { [field]: fact };
    if (status !== null) {
      patch.application_status = status;
    }
  }
  return { patch, effectiveValue, field };
}

function buildReviewPlan(
  item: ReviewItem,
  decision: ReviewDecision,
  record: ApplicationRecord,
  ids: { taskId: string; planId: string },
): OperationPlan {
  const operations: Operation[] = [];
  if (decision.decision === "approve" || decision.decision === "approve-with-modification") {
    const { patch, effectiveValue, field } = buildRecordPatch(record, item, decision);
    operations.push(
      {
        operation_id: "OP-001",
        type: "update-frontmatter",
        target: item.target,
        risk: "yellow",
        confidence: 1,
        idempotency_key: `${item.review_id}:${decision.decided_at}:frontmatter`,
        payload: {
          patch,
          schema_id: SCHEMAS.record,
        },
        requires_review_id: item.review_id,
      },
      {
        operation_id: "OP-002",
        type: "append-section",
        target: item.target,
        risk: "green",
        confidence: 1,
        idempotency_key: `${item.review_id}:${decision.decided_at}:change-log`,
        payload: {
          section: "变更记录",
          marker: `<!-- pkb-review:${item.review_id} -->`,
          content: `- ${decision.decided_at.slice(0, 10)}：审核 ${item.review_id} 已批准，${field} 更新为 ${JSON.stringify(effectiveValue)}。`,
        },
        requires_review_id: item.review_id,
      },
    );
  }
  return {
    plan_id: ids.planId,
    task_id: ids.taskId,
    source_module: item.source_module,
    instance_id: item.instance_id,
    summary: `落实审核决定 ${item.review_id}: ${decision.decision}`,
    operations,
    review_items: [],
  };
}

async function writeReviewRunLog(
  vaultRoot: string,
  runId: string,
  item: ReviewItem,
  decision: ReviewDecision,
  plan: OperationPlan,
  snapshot: string,
): Promise<string> {
  return writeRunLog(vaultRoot, {
    run_id: runId,
    task_id: plan.task_id,
    plan_id: plan.plan_id,
    source_module: item.source_module,
    instance_id: item.instance_id,
    review_id: item.review_id,
    status: "completed",
    git_snapshot: snapshot,
    started_at: decision.decided_at,
    completed_at: new Date().toISOString(),
    schema_version: 1,
  }, [
      `# ${runId}`,
      "",
      `- 审核：[[90-System/Review Queue/Closed/${item.review_id}]]`,
      `- 决定：${decision.decision}`,
      `- 备注：${decision.user_comment || "无"}`,
      `- 操作数：${plan.operations.length}`,
      "",
    ].join("\n"));
}

function withDecision(item: ReviewItem, decision: ReviewDecision, status: ReviewStatus, resolution: string): ReviewItem {
  return {
    ...item,
    status,
    decision,
    decision_history: [...item.decision_history, decision],
    review_after: decision.review_after,
    target_observation: null,
    resolution,
  };
}

export async function decideReview(options: DecideReviewOptions): Promise<ReviewActionResult> {
  const vaultRoot = path.resolve(options.vaultRoot);
  const decidedAt = options.now ?? new Date().toISOString();
  await requeueDueReviews(vaultRoot, new Date(decidedAt));
  const located = await locateReviewItem(vaultRoot, options.reviewId);
  if (located.item.status !== "pending") {
    throw new PkbError("REVIEW_ALREADY_PROCESSED", `审核项状态为 ${located.item.status}，不允许重复处理。`);
  }
  if (options.decision === "approve-with-modification" && options.modifiedValue === undefined) {
    throw new PkbError("MODIFIED_VALUE_REQUIRED", "修改后批准必须提供 modified_value。");
  }
  const decision: ReviewDecision = {
    review_id: options.reviewId,
    decision: options.decision,
    user_comment: options.userComment ?? "",
    decided_at: decidedAt,
    review_after: options.decision === "defer" ? options.reviewAfter ?? null : null,
    modified_value: options.decision === "approve-with-modification"
      ? structuredClone(options.modifiedValue!)
      : null,
  };
  validateSchema(vaultRoot, SCHEMAS.decision, decision);

  if (decision.decision === "defer") {
    if (!decision.review_after || Date.parse(decision.review_after) <= Date.parse(decidedAt)) {
      throw new PkbError("INVALID_REVIEW_AFTER", "延后时间必须晚于决定时间。");
    }
    const item = withDecision(located.item, decision, "deferred", `延后至 ${decision.review_after}。`);
    const reviewPath = await persistReviewItem(vaultRoot, located, item);
    const todayPath = await rebuildTodayDashboard(vaultRoot);
    return {
      status: item.status,
      reviewId: item.review_id,
      runId: null,
      planPath: null,
      snapshot: null,
      reviewPath: toVaultPath(vaultRoot, reviewPath),
      todayPath: toVaultPath(vaultRoot, todayPath),
    };
  }

  if (decision.decision === "discuss") {
    const item = withDecision(located.item, decision, "pending", "等待进一步讨论，尚未执行任何修改。");
    const reviewPath = await persistReviewItem(vaultRoot, located, item);
    const todayPath = await rebuildTodayDashboard(vaultRoot);
    return {
      status: item.status,
      reviewId: item.review_id,
      runId: null,
      planPath: null,
      snapshot: null,
      reviewPath: toVaultPath(vaultRoot, reviewPath),
      todayPath: toVaultPath(vaultRoot, todayPath),
    };
  }

  const targetPath = targetAbsolute(vaultRoot, located.item);
  const recordDocument = parseMarkdown(vaultRoot, targetPath);
  validateSchema(vaultRoot, SCHEMAS.record, recordDocument.data);
  const record = recordDocument.data as unknown as ApplicationRecord;
  const taskId = await allocateId(vaultRoot, "TASK");
  const planId = await allocateId(vaultRoot, "PLAN");
  const runId = await allocateId(vaultRoot, "RUN");
  const plan = buildReviewPlan(located.item, decision, record, { taskId, planId });
  validateSchema(vaultRoot, SCHEMAS.plan, plan);
  const planAbsolute = path.join(vaultRoot, "90-System", "State", "Plans", `${planId}.json`);
  await writeJsonAtomic(planAbsolute, plan);
  const snapshot = await createGitSnapshot(vaultRoot, runId);

  try {
    await executeOperationPlan(vaultRoot, plan, {
      allowedTypes: ["update-frontmatter", "append-section"],
      allowedTargets: [located.item.target],
      requiredReviewId: located.item.review_id,
    });
    const status: ReviewStatus = decision.decision === "approve"
      ? "approved"
      : decision.decision === "approve-with-modification"
        ? "approved-with-modification"
        : "rejected";
    const resolution = decision.decision === "reject"
      ? `用户拒绝建议；正式字段保持不变。${decision.user_comment ? ` 原因：${decision.user_comment}` : ""}`
      : `最终 Operation Plan ${planId} 已执行。`;
    const item = withDecision(located.item, decision, status, resolution);
    const reviewPath = await persistReviewItem(vaultRoot, located, item);
    await writeReviewRunLog(vaultRoot, runId, item, decision, plan, snapshot);
    const todayPath = await rebuildTodayDashboard(vaultRoot);
    return {
      status,
      reviewId: item.review_id,
      runId,
      planPath: toVaultPath(vaultRoot, planAbsolute),
      snapshot,
      reviewPath: toVaultPath(vaultRoot, reviewPath),
      todayPath: toVaultPath(vaultRoot, todayPath),
    };
  } catch (error) {
    const failed = withDecision(
      located.item,
      decision,
      "error",
      `执行失败：${error instanceof Error ? error.message : String(error)}`,
    );
    await persistReviewItem(vaultRoot, located, failed);
    await rebuildTodayDashboard(vaultRoot);
    throw error;
  }
}

function observationFor(item: ReviewItem, record: ApplicationRecord, now: string): ReviewTargetObservation {
  const proposed = proposedObject(item);
  const field = fieldFromReview(item);
  const observed = currentFieldValue(record, field);
  const newValue = proposed.new_value ?? null;
  const oldValue = proposed.old_value ?? null;
  let matches: "old" | "proposed" | "neither" = deepEqual(observed, newValue)
    ? "proposed"
    : deepEqual(observed, oldValue)
      ? "old"
      : "neither";
  const expectedStatus = expectedApplicationStatus(field, newValue, proposed);
  if (matches === "proposed" && expectedStatus !== null && record.application_status !== expectedStatus) {
    matches = "neither";
  }
  return { field, observed_value: structuredClone(observed), checked_at: now, matches };
}

export async function reconcileReviews(vaultPath: string, reviewId?: string, now = new Date().toISOString()): Promise<ReconcileResult> {
  const vaultRoot = path.resolve(vaultPath);
  const requeued = await requeueDueReviews(vaultRoot, new Date(now));
  const pendingRoot = path.join(vaultRoot, "90-System", "Review Queue", "Pending");
  const ids = reviewId
    ? [reviewId]
    : (await listFilesRecursive(pendingRoot, ".md")).map((file) => path.basename(file, ".md"));
  const resolved: string[] = [];
  const warnings: string[] = [];
  const unchanged: string[] = [];

  for (const id of ids) {
    const located = await locateReviewItem(vaultRoot, id);
    if (located.item.status !== "pending") {
      unchanged.push(id);
      continue;
    }
    const target = targetAbsolute(vaultRoot, located.item);
    const recordDocument = parseMarkdown(vaultRoot, target);
    validateSchema(vaultRoot, SCHEMAS.record, recordDocument.data);
    const observation = observationFor(located.item, recordDocument.data as unknown as ApplicationRecord, now);
    if (observation.matches === "proposed") {
      const item: ReviewItem = {
        ...located.item,
        status: "resolved-by-user-edit",
        target_observation: observation,
        resolution: "目标 YAML 字段已由用户修改为审核建议值，审核自动关闭。",
      };
      await persistReviewItem(vaultRoot, located, item);
      resolved.push(id);
    } else if (observation.matches === "neither") {
      const item: ReviewItem = {
        ...located.item,
        target_observation: observation,
        resolution: "目标文件已被修改，但关联审核项仍未关闭。",
      };
      await persistReviewItem(vaultRoot, located, item);
      warnings.push(id);
    } else {
      const item: ReviewItem = { ...located.item, target_observation: observation };
      await persistReviewItem(vaultRoot, located, item);
      unchanged.push(id);
    }
  }
  const todayPath = await rebuildTodayDashboard(vaultRoot);
  return { requeued, resolved, warnings, unchanged, todayPath: toVaultPath(vaultRoot, todayPath) };
}

export async function retryReview(vaultPath: string, reviewId: string): Promise<ReviewActionResult> {
  const vaultRoot = path.resolve(vaultPath);
  const located = await locateReviewItem(vaultRoot, reviewId);
  if (located.item.status !== "error") {
    throw new PkbError("REVIEW_NOT_RETRYABLE", `只有 error 状态可以重试，当前状态为 ${located.item.status}。`);
  }
  const item: ReviewItem = {
    ...located.item,
    status: "pending",
    decision: null,
    review_after: null,
    resolution: "错误已确认，审核项重新进入 pending；原决定保留在 decision_history。",
  };
  const reviewPath = await persistReviewItem(vaultRoot, located, item);
  const todayPath = await rebuildTodayDashboard(vaultRoot);
  return {
    status: "pending",
    reviewId,
    runId: null,
    planPath: null,
    snapshot: null,
    reviewPath: toVaultPath(vaultRoot, reviewPath),
    todayPath: toVaultPath(vaultRoot, todayPath),
  };
}
