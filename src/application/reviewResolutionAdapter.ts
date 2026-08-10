import type { ApplicationFact, ApplicationRecord } from "./types.js";
import type { JsonObject, JsonValue, Operation, OperationPlan, ReviewDecision, ReviewItem, ReviewTargetObservation } from "../core/types.js";
import { PkbError } from "../core/errors.js";
import { uniqueJsonValues } from "../core/files.js";
import { APPLICATION_STATE_MACHINE, assertApplicationTransition, type ApplicationStatus } from "./stateMachine.js";

export interface ReviewResolutionAdapter {
  id: string;
  schemaId: string;
  buildPlan(input: { item: ReviewItem; decision: ReviewDecision; record: JsonObject; taskId: string; planId: string; runId: string; sourceEvidence: JsonValue[] }): OperationPlan;
  observe(item: ReviewItem, record: JsonObject, now: string): ReviewTargetObservation;
}

function proposedObject(item: ReviewItem): JsonObject {
  if (!item.proposed_value || typeof item.proposed_value !== "object" || Array.isArray(item.proposed_value)) throw new PkbError("INVALID_REVIEW", "Review proposed_value must be an object.", item.review_id);
  return item.proposed_value as JsonObject;
}
function fieldFromReview(item: ReviewItem): string {
  const field = proposedObject(item).field; if (typeof field !== "string" || !field) throw new PkbError("INVALID_REVIEW", "Review item is missing its target field.", item.review_id); return field;
}
function currentFieldValue(record: ApplicationRecord, field: string): JsonValue { return field === "application_status" ? record.application_status : record.facts[field]?.value ?? null; }
function expectedApplicationStatus(field: string, value: JsonValue, proposed: JsonObject): string | null {
  if (field === "application_status" && typeof value === "string") return value;
  if (field === "application_open") return value === true ? "open" : value === false ? "not-open" : null;
  return typeof proposed.application_status === "string" ? proposed.application_status : null;
}

function buildRecordPatch(record: ApplicationRecord, item: ReviewItem, decision: ReviewDecision, runId: string, sourceEvidence: JsonValue[]): { patch: JsonObject; effectiveValue: JsonValue; field: string } {
  const proposed = proposedObject(item); const field = fieldFromReview(item); const effectiveValue = decision.decision === "approve-with-modification" ? structuredClone(decision.modified_value ?? null) : structuredClone(proposed.new_value ?? null);
  const patch: JsonObject = { updated: decision.decided_at };
  const currentMeta = record._field_meta && typeof record._field_meta === "object" && !Array.isArray(record._field_meta) ? record._field_meta as JsonObject : {};
  const originGeneration = item.generation && typeof item.generation === "object" && !Array.isArray(item.generation) ? item.generation as JsonObject : null;
  const originModule = originGeneration?.module && typeof originGeneration.module === "object" && !Array.isArray(originGeneration.module) ? originGeneration.module as JsonObject : null;
  patch._field_meta = { ...currentMeta, [field]: { authorship: "external-research", evidence_refs: item.evidence, generation: { run_id: runId, module: { id: item.source_module, version: typeof originModule?.version === "string" ? originModule.version : "unknown" }, workflow: { id: "review-resolve", version: "1.0.0" }, prompt: originGeneration?.prompt ?? null, processor: { id: "review-executor", version: "1.0.0", source_generation: originGeneration }, adapter: typeof originGeneration?.adapter === "string" ? originGeneration.adapter : null, model: typeof originGeneration?.model === "string" ? originGeneration.model : null, generated_at: decision.decided_at }, review: { status: decision.decision === "approve" ? "approved" : "approved-with-modification", review_id: item.review_id, reviewed_by: "user", reviewed_at: decision.decided_at, decision: decision.decision }, verification: { last_verified: decision.decided_at, verification_interval_days: null, stale_after: null, stale: false, verification_status: "verified" } } };
  const status = expectedApplicationStatus(field, effectiveValue, proposed);
  if (status !== null && status !== record.application_status) { assertApplicationTransition(record.application_status as ApplicationStatus, status as ApplicationStatus); const rule = APPLICATION_STATE_MACHINE[status as ApplicationStatus]; patch.monitoring = { active: !rule.terminal, stopped: rule.stopMonitoring }; }
  if (field === "application_status") { if (typeof effectiveValue !== "string") throw new PkbError("INVALID_MODIFIED_VALUE", "application_status must be a string.", effectiveValue); patch.application_status = effectiveValue; }
  else {
    const current = record.facts[field]; const sourceRefs = uniqueJsonValues([...(current?.source_refs ?? []), ...sourceEvidence]).filter((value): value is string => typeof value === "string");
    const fact: ApplicationFact = { value: effectiveValue, status: "confirmed", confidence: item.confidence, checked_at: decision.decided_at, source_refs: sourceRefs, notes: decision.user_comment || `Approved by Review ${item.review_id}.` };
    patch.facts = { [field]: fact }; if (status !== null) patch.application_status = status;
  }
  return { patch, effectiveValue, field };
}

export const applicationFactReviewAdapter: ReviewResolutionAdapter = {
  id: "application-fact-review", schemaId: "https://pkb.local/schemas/application-tracker/application-record.schema.json",
  buildPlan({ item, decision, record, taskId, planId, runId, sourceEvidence }) {
    const operations: Operation[] = [];
    if (decision.decision === "approve" || decision.decision === "approve-with-modification") {
      const { patch, effectiveValue, field } = buildRecordPatch(record as ApplicationRecord, item, decision, runId, sourceEvidence);
      operations.push({ operation_id: "OP-001", type: "update-frontmatter", target: item.target, risk: "yellow", confidence: 1, idempotency_key: `${item.review_id}:${decision.decided_at}:frontmatter`, payload: { patch, schema_id: "https://pkb.local/schemas/application-tracker/application-record.schema.json" }, requires_review_id: item.review_id }, { operation_id: "OP-002", type: "append-section", target: item.target, risk: "green", confidence: 1, idempotency_key: `${item.review_id}:${decision.decided_at}:change-log`, payload: { section: "变更记录", marker: `<!-- pkb-review:${item.review_id} -->`, content: `- ${decision.decided_at.slice(0, 10)}：审核 ${item.review_id} 已批准，${field} 更新为 ${JSON.stringify(effectiveValue)}。` }, requires_review_id: item.review_id });
    }
    return { plan_id: planId, task_id: taskId, source_module: item.source_module, instance_id: item.instance_id, summary: `落实审核决定 ${item.review_id}: ${decision.decision}`, operations, review_items: [] };
  },
  observe(item, rawRecord, now) {
    const record = rawRecord as ApplicationRecord; const proposed = proposedObject(item); const field = fieldFromReview(item); const observed = currentFieldValue(record, field); const newValue = proposed.new_value ?? null; const oldValue = proposed.old_value ?? null;
    let matches: "old" | "proposed" | "neither" = JSON.stringify(observed) === JSON.stringify(newValue) ? "proposed" : JSON.stringify(observed) === JSON.stringify(oldValue) ? "old" : "neither";
    const expectedStatus = expectedApplicationStatus(field, newValue, proposed); if (matches === "proposed" && expectedStatus !== null && record.application_status !== expectedStatus) matches = "neither";
    return { field, observed_value: structuredClone(observed), checked_at: now, matches };
  },
};
