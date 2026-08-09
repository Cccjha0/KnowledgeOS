import path from "node:path";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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
  ensureDir,
  exists,
  fromVaultPath,
  listFilesRecursive,
  readJson,
  toVaultPath,
  uniqueJsonValues,
  writeJsonAtomic,
} from "../core/files.js";
import { createGitSnapshot } from "../core/git.js";
import { allocateId } from "../core/ids.js";
import { writeRunLog } from "../core/logs.js";
import { executeOperationPlan } from "../core/operationExecutor.js";
import { discoverModulesForVault } from "../core/discovery.js";
import { APPLICATION_STATE_MACHINE, assertApplicationTransition, type ApplicationStatus } from "../application/stateMachine.js";
import {
  locateReviewItem,
  persistReviewItem,
  requeueDueReviews,
  type LocatedReview,
} from "../core/reviews.js";
import { QualityRepository } from "../quality/repository.js";
import { evidenceSnapshotHash, reviewFingerprint } from "../quality/fingerprint.js";
import { authorizedEvidenceSources, materializeFieldProvenance, parseEvidenceSelections } from "../quality/fieldProvenance.js";
import { RuntimeRepository } from "../runtime/repository.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODULE_UPDATE_PROTECTED_FIELDS = new Set([
  "id", "type", "schema_id", "schema_version", "module_version", "instance_id", "created", "updated",
]);

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
  runId: string,
  sourceEvidence: JsonValue[],
): { patch: JsonObject; effectiveValue: JsonValue; field: string } {
  const proposed = proposedObject(item);
  const field = fieldFromReview(item);
  const effectiveValue = decision.decision === "approve-with-modification"
    ? structuredClone(decision.modified_value ?? null)
    : structuredClone(proposed.new_value ?? null);
  const patch: JsonObject = { updated: decision.decided_at };
  const currentMeta = record._field_meta && typeof record._field_meta === "object" && !Array.isArray(record._field_meta) ? record._field_meta as JsonObject : {};
  const originGeneration = item.generation && typeof item.generation === "object" && !Array.isArray(item.generation) ? item.generation as JsonObject : null;
  const originModule = originGeneration?.module && typeof originGeneration.module === "object" && !Array.isArray(originGeneration.module) ? originGeneration.module as JsonObject : null;
  patch._field_meta = { ...currentMeta, [field]: {
    authorship: "external-research", evidence_refs: item.evidence,
    generation: { run_id: runId, module: { id: item.source_module, version: typeof originModule?.version === "string" ? originModule.version : "unknown" }, workflow: { id: "review-resolve", version: "1.0.0" }, prompt: originGeneration?.prompt ?? null, processor: { id: "review-executor", version: "1.0.0", source_generation: originGeneration }, adapter: typeof originGeneration?.adapter === "string" ? originGeneration.adapter : null, model: typeof originGeneration?.model === "string" ? originGeneration.model : null, generated_at: decision.decided_at },
    review: { status: decision.decision === "approve" ? "approved" : "approved-with-modification", review_id: item.review_id, reviewed_by: "user", reviewed_at: decision.decided_at, decision: decision.decision },
    verification: { last_verified: decision.decided_at, verification_interval_days: null, stale_after: null, stale: false, verification_status: "verified" },
  } };
  const status = expectedApplicationStatus(field, effectiveValue, proposed);
  if (status !== null && status !== record.application_status) {
    assertApplicationTransition(record.application_status as ApplicationStatus, status as ApplicationStatus);
    const rule = APPLICATION_STATE_MACHINE[status as ApplicationStatus];
    patch.monitoring = { active: !rule.terminal, stopped: rule.stopMonitoring };
  }

  if (field === "application_status") {
    if (typeof effectiveValue !== "string") {
      throw new PkbError("INVALID_MODIFIED_VALUE", "application_status 必须是字符串。", effectiveValue);
    }
    patch.application_status = effectiveValue;
  } else {
    const current = record.facts[field];
    const sourceRefs = uniqueJsonValues([
      ...(current?.source_refs ?? []),
      ...sourceEvidence,
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

async function materializeReviewEvidence(vaultRoot: string, item: ReviewItem, field: string, observedAt: string): Promise<string[]> {
  const repository = await QualityRepository.open(vaultRoot);
  try {
    const existing = repository.listEvidence(5000); const ids: string[] = [];
    for (const raw of item.evidence.filter((value): value is string => typeof value === "string")) {
      if (/^EVD-\d{4}-\d{6,}$/.test(raw)) { ids.push(raw); continue; }
      const match = existing.find((entry) => entry.source_ref === raw && entry.supports.some((support) => support.entity_ref === item.target && support.field === field));
      const record = match ?? repository.upsertEvidence({ source_type: "external-research", source_ref: raw, supports: [{ entity_ref: item.target, field }], locator: {}, observed_at: observedAt, captured_at: observedAt, collector: { type: "review-evidence", review_id: item.review_id }, quality: { authority: "unknown", freshness: "current", extraction_confidence: item.confidence }, status: "active" });
      ids.push(record.evidence_id);
    }
    return [...new Set(ids)];
  } finally { repository.close(); }
}

function buildReviewPlan(
  item: ReviewItem,
  decision: ReviewDecision,
  record: ApplicationRecord,
  ids: { taskId: string; planId: string; runId: string; sourceEvidence: JsonValue[] },
): OperationPlan {
  const operations: Operation[] = [];
  if (decision.decision === "approve" || decision.decision === "approve-with-modification") {
    const { patch, effectiveValue, field } = buildRecordPatch(record, item, decision, ids.runId, ids.sourceEvidence);
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

function moduleOperationPlanId(item: ReviewItem): string {
  const planId = proposedObject(item).operation_plan_id;
  if (typeof planId !== "string" || !/^PLAN-\d{4}-\d+$/.test(planId)) throw new PkbError("INVALID_REVIEW", "Module operation Review is missing its Operation Plan reference.", item.review_id);
  return planId;
}

function applyModuleReviewModification(plan: OperationPlan, modifiedValue: JsonValue): void {
  if (!modifiedValue || typeof modifiedValue !== "object" || Array.isArray(modifiedValue)) throw new PkbError("INVALID_MODIFIED_VALUE", "A module-operation Review modification must be a record object.");
  const replacement = structuredClone(modifiedValue) as JsonObject;
  // Evidence selection is a transient, Core-validated instruction from the
  // model. It is never part of a module entity schema and must not be able to
  // reach the Executor through a user-modified review payload.
  delete replacement._evidence_selection;
  delete replacement._field_meta;
  for (const operation of plan.operations) {
    if (operation.type === "create-file") {
      const document = operation.payload.document;
      if (!document || typeof document !== "object" || Array.isArray(document)) throw new PkbError("INVALID_REVIEW_PLAN", "Module create operation has no document payload.");
      (document as JsonObject).data = replacement;
    } else if (operation.type === "update-frontmatter") {
      operation.payload.patch = replacement;
      operation.payload.replace_top_level = Object.keys(replacement);
    }
  }
}

/** Apply Core-owned field provenance only after a module operation is approved. */
async function materializeApprovedModuleFieldProvenance(
  vaultRoot: string,
  plan: OperationPlan,
  item: ReviewItem,
  decision: ReviewDecision,
  runId: string,
): Promise<void> {
  const module = (await discoverModulesForVault(ENGINE_ROOT, vaultRoot)).find((entry) => String(entry.data.id) === item.source_module);
  if (!module) return;
  const moduleRoot = path.dirname(module.path);
  const authorizedSourceRefs = item.evidence.filter((entry): entry is string => typeof entry === "string" && !/^EVD-\d{4}-\d{6,}$/.test(entry));
  const authorizedSources = authorizedEvidenceSources(authorizedSourceRefs);
  const proposed = item.proposed_value && typeof item.proposed_value === "object" && !Array.isArray(item.proposed_value) ? item.proposed_value as JsonObject : {};
  // New Module Workflow reviews persist a Core-validated selection. Legacy
  // single-field Reviews already treat `item.evidence` as the field's actual
  // evidence, so preserve that narrower historical contract during migration.
  const evidenceSelections = proposed.evidence_selection === undefined
    ? item.action === "module-operation" ? {} : { [fieldFromReview(item)]: authorizedSources.map((source) => ({ source_id: source.source_id, locator_id: "LOC-DOCUMENT", locator: {} })) }
    : parseEvidenceSelections(proposed.evidence_selection, authorizedSources, { allowLegacyLocator: true });
  const sourceGeneration = item.generation && typeof item.generation === "object" && !Array.isArray(item.generation) ? item.generation as JsonObject : null;
  const generation: JsonObject = { ...(sourceGeneration ?? {}), review_resolution: { run_id: runId, review_id: item.review_id, decided_at: decision.decided_at } };
  const review: JsonObject = { status: decision.decision === "approve" ? "approved" : "approved-with-modification", review_id: item.review_id, reviewed_by: "user", reviewed_at: decision.decided_at, decision: decision.decision };
  for (const operation of plan.operations) {
    if (!operation.target || !["create-file", "update-frontmatter"].includes(operation.type)) continue;
    const data = operation.type === "create-file"
      ? operation.payload.document && typeof operation.payload.document === "object" && !Array.isArray(operation.payload.document)
        ? (operation.payload.document as JsonObject).data : null
      : operation.payload.patch;
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const record = data as JsonObject;
    // A review modification may come from any client; it cannot carry model-made provenance.
    delete record._field_meta;
    record.source_refs = [...new Set(authorizedSourceRefs)];
    if (operation.type === "update-frontmatter") {
      for (const field of MODULE_UPDATE_PROTECTED_FIELDS) delete record[field];
      record.updated = decision.decided_at;
      record.generation = sourceGeneration;
    }
    const entityId = typeof record.schema_id === "string" ? record.schema_id : typeof operation.payload.schema_id === "string" ? operation.payload.schema_id : null;
    if (!entityId) continue;
    const fieldMeta = await materializeFieldProvenance({
      vaultRoot, moduleRoot, manifest: module.data, entityId, target: operation.target, output: record,
      authorizedSources, evidenceSelections, runId, generation, review, now: decision.decided_at,
    });
    if (Object.keys(fieldMeta).length) record._field_meta = fieldMeta;
  }
}

async function finishOriginTask(vaultRoot: string, item: ReviewItem, completionReason: string): Promise<void> {
  if (!item.origin_task_id) return;
  const repository = await RuntimeRepository.open(vaultRoot);
  try {
    if (repository.getTask(item.origin_task_id)?.status === "waiting-for-user") {
      repository.transitionTask(item.origin_task_id, "completed", { completionReason });
    }
  } finally { repository.close(); }
}

async function decideModuleOperationReview(
  vaultRoot: string,
  located: LocatedReview,
  decision: ReviewDecision,
): Promise<ReviewActionResult> {
  const planId = moduleOperationPlanId(located.item);
  const planPath = path.join(vaultRoot, "90-System", "State", "Plans", `${planId}.json`);
  const plan = await readJson<OperationPlan | null>(planPath, null);
  if (!plan || plan.source_module !== located.item.source_module || plan.task_id !== located.item.origin_task_id) {
    throw new PkbError("INVALID_REVIEW_PLAN", "Module operation Review does not reference its originating Operation Plan.", located.item.review_id);
  }
  if (decision.decision === "reject") {
    const item = withDecision(located.item, decision, "rejected", "User rejected the module Operation Plan; no file was changed.");
    const reviewPath = await persistReviewItem(vaultRoot, located, item);
    await recordReviewOutcome(vaultRoot, item, decision, null);
    await finishOriginTask(vaultRoot, item, "workflow-review-rejected");
    const todayPath = await rebuildTodayDashboard(vaultRoot);
    return { status: item.status, reviewId: item.review_id, runId: null, planPath: toVaultPath(vaultRoot, planPath), snapshot: null, reviewPath: toVaultPath(vaultRoot, reviewPath), todayPath: toVaultPath(vaultRoot, todayPath) };
  }
  if (decision.decision === "approve-with-modification") applyModuleReviewModification(plan, decision.modified_value);
  const runId = await allocateId(vaultRoot, "RUN");
  await materializeApprovedModuleFieldProvenance(vaultRoot, plan, located.item, decision, runId);
  const snapshot = await createGitSnapshot(vaultRoot, runId);
  await writeJsonAtomic(planPath, plan);
  try {
    await executeOperationPlan(vaultRoot, plan, {
      allowedTypes: [...new Set(plan.operations.map((operation) => operation.type))],
      allowedTargets: plan.operations.map((operation) => operation.target).filter((target): target is string => Boolean(target)),
      requiredReviewId: located.item.review_id, gitSnapshot: snapshot,
    });
    const status: ReviewStatus = decision.decision === "approve" ? "approved" : "approved-with-modification";
    const item = withDecision(located.item, decision, status, `Reviewed module Operation Plan ${planId} executed.`);
    const reviewPath = await persistReviewItem(vaultRoot, located, item);
    await writeReviewRunLog(vaultRoot, runId, item, decision, plan, snapshot);
    await recordReviewOutcome(vaultRoot, item, decision, runId);
    await finishOriginTask(vaultRoot, item, "workflow-review-approved");
    const todayPath = await rebuildTodayDashboard(vaultRoot);
    return { status, reviewId: item.review_id, runId, planPath: toVaultPath(vaultRoot, planPath), snapshot, reviewPath: toVaultPath(vaultRoot, reviewPath), todayPath: toVaultPath(vaultRoot, todayPath) };
  } catch (error) {
    const item = withDecision(located.item, decision, "error", `Module Operation Plan failed: ${error instanceof Error ? error.message : String(error)}`);
    await persistReviewItem(vaultRoot, located, item);
    await rebuildTodayDashboard(vaultRoot);
    throw error;
  }
}

async function recordReviewOutcome(vaultRoot: string, item: ReviewItem, decision: ReviewDecision, runId: string | null): Promise<void> {
  const repository = await QualityRepository.open(vaultRoot);
  try {
    const fingerprint = item.review_fingerprint ?? reviewFingerprint({ module: item.source_module, instanceId: item.instance_id, target: item.target, action: item.action, proposedValue: item.proposed_value, evidence: item.evidence });
    const evidenceHash = evidenceSnapshotHash(item.evidence);
    const generation = item.generation && typeof item.generation === "object" && !Array.isArray(item.generation) ? item.generation as JsonObject : null;
    const workflow = generation?.workflow && typeof generation.workflow === "object" && !Array.isArray(generation.workflow) ? generation.workflow as JsonObject : null;
    const prompt = generation?.prompt && typeof generation.prompt === "object" && !Array.isArray(generation.prompt) ? generation.prompt as JsonObject : null;
    repository.recordMetric({ idempotency_key: `review:${item.review_id}:${decision.decided_at}`, event_type: `review.${decision.decision}`, module: item.source_module, instance_id: item.instance_id, workflow_id: typeof workflow?.id === "string" ? workflow.id : "review-resolve", workflow_version: typeof workflow?.version === "string" ? workflow.version : "1.0.0", prompt_id: typeof prompt?.id === "string" ? prompt.id : null, prompt_version: typeof prompt?.version === "string" ? prompt.version : null, run_id: runId, occurred_at: decision.decided_at, dimensions: { priority: item.priority, action: item.action }, values: {} });
    if (decision.decision === "reject") repository.rememberRejection({ fingerprint, rejected_value_hash: fingerprint, evidence_hash: evidenceHash, reason: decision.user_comment, rejected_at: decision.decided_at, suppressed_until: null });
    if (["approve", "approve-with-modification"].includes(decision.decision)) {
      const proposed = proposedObject(item); const field = fieldFromReview(item);
      repository.recordChange({ entity_ref: item.target, field, old_value: structuredClone(proposed.old_value ?? null), new_value: decision.decision === "approve-with-modification" ? structuredClone(decision.modified_value) : structuredClone(proposed.new_value ?? null), reason: item.reason, evidence_refs: item.evidence.filter((value): value is string => typeof value === "string"), generation: { run_id: runId, module: { id: item.source_module, version: "unknown" }, workflow: { id: "review-resolve", version: "1.0.0" }, prompt: generation?.prompt ?? null, source_generation: generation }, review: { status: decision.decision, review_id: item.review_id, reviewed_by: "user", reviewed_at: decision.decided_at }, changed_at: decision.decided_at });
    }
  } finally { repository.close(); }
}

async function decideReviewUnlocked(options: DecideReviewOptions): Promise<ReviewActionResult> {
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
    await recordReviewOutcome(vaultRoot, item, decision, null);
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
    await recordReviewOutcome(vaultRoot, item, decision, null);
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

  if (located.item.action === "module-operation") {
    return decideModuleOperationReview(vaultRoot, located, decision);
  }

  const targetPath = targetAbsolute(vaultRoot, located.item);
  const recordDocument = parseMarkdown(vaultRoot, targetPath);
  validateSchema(vaultRoot, SCHEMAS.record, recordDocument.data);
  const record = recordDocument.data as unknown as ApplicationRecord;
  const taskId = await allocateId(vaultRoot, "TASK");
  const planId = await allocateId(vaultRoot, "PLAN");
  const runId = await allocateId(vaultRoot, "RUN");
  const tracedItem: ReviewItem = { ...located.item, evidence: await materializeReviewEvidence(vaultRoot, located.item, fieldFromReview(located.item), decidedAt) };
  const plan = buildReviewPlan(tracedItem, decision, record, { taskId, planId, runId, sourceEvidence: located.item.evidence });
  const planAbsolute = path.join(vaultRoot, "90-System", "State", "Plans", `${planId}.json`);
  await writeJsonAtomic(planAbsolute, plan);
  const snapshot = await createGitSnapshot(vaultRoot, runId);

  try {
    await executeOperationPlan(vaultRoot, plan, {
      allowedTypes: ["update-frontmatter", "append-section"],
      allowedTargets: [located.item.target],
      requiredReviewId: located.item.review_id,
      gitSnapshot: snapshot,
    });
    const status: ReviewStatus = decision.decision === "approve"
      ? "approved"
      : decision.decision === "approve-with-modification"
        ? "approved-with-modification"
        : "rejected";
    const resolution = decision.decision === "reject"
      ? `用户拒绝建议；正式字段保持不变。${decision.user_comment ? ` 原因：${decision.user_comment}` : ""}`
      : `最终 Operation Plan ${planId} 已执行。`;
    const item = withDecision(tracedItem, decision, status, resolution);
    const reviewPath = await persistReviewItem(vaultRoot, located, item);
    await writeReviewRunLog(vaultRoot, runId, item, decision, plan, snapshot);
    await recordReviewOutcome(vaultRoot, item, decision, runId);
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

function reviewLockPath(vaultRoot: string, reviewId: string): string {
  return path.join(vaultRoot, "90-System", "State", "Locks", `review-${reviewId}.lock.json`);
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function acquireReviewLock(vaultRoot: string, reviewId: string): Promise<FileHandle> {
  const lockPath = reviewLockPath(vaultRoot, reviewId);
  await ensureDir(path.dirname(lockPath));
  if (await exists(lockPath)) {
    const lock = await readJson<{ pid?: number }>(lockPath, {});
    if (typeof lock.pid === "number" && processAlive(lock.pid)) {
      throw new PkbError("REVIEW_IN_PROGRESS", `审核 ${reviewId} 正在由另一个请求处理。`);
    }
    await fs.unlink(lockPath).catch(() => undefined);
  }
  const handle = await fs.open(lockPath, "wx");
  await handle.writeFile(`${JSON.stringify({ pid: process.pid, review_id: reviewId, acquired_at: new Date().toISOString() })}\n`, "utf8");
  return handle;
}

export async function decideReview(options: DecideReviewOptions): Promise<ReviewActionResult> {
  const vaultRoot = path.resolve(options.vaultRoot);
  const lock = await acquireReviewLock(vaultRoot, options.reviewId);
  try {
    return await decideReviewUnlocked({ ...options, vaultRoot });
  } finally {
    await lock.close().catch(() => undefined);
    await fs.unlink(reviewLockPath(vaultRoot, options.reviewId)).catch(() => undefined);
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

export async function resolveReviewByUserEdit(
  vaultPath: string,
  reviewId: string,
  userComment = "",
): Promise<ReviewActionResult> {
  const vaultRoot = path.resolve(vaultPath);
  const located = await locateReviewItem(vaultRoot, reviewId);
  if (located.item.status !== "pending") {
    throw new PkbError("REVIEW_ALREADY_PROCESSED", `审核项状态为 ${located.item.status}，不能标记为用户编辑解决。`);
  }
  const item: ReviewItem = {
    ...located.item,
    status: "resolved-by-user-edit",
    decision: null,
    review_after: null,
    resolution: `用户确认目标文件中的直接编辑已解决此审核。${userComment ? ` 备注：${userComment}` : ""}`,
  };
  const reviewPath = await persistReviewItem(vaultRoot, located, item);
  const todayPath = await rebuildTodayDashboard(vaultRoot);
  return {
    status: item.status,
    reviewId,
    runId: null,
    planPath: null,
    snapshot: null,
    reviewPath: toVaultPath(vaultRoot, reviewPath),
    todayPath: toVaultPath(vaultRoot, todayPath),
  };
}
