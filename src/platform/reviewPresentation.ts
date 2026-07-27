import { createHash } from "node:crypto";
import { parseMarkdown } from "../core/bridge.js";
import { deepEqual, exists, fromVaultPath } from "../core/files.js";
import type { JsonObject, JsonValue, ReviewItem } from "../core/types.js";

export interface ReviewView extends JsonObject {
  review_id: string;
  status: ReviewItem["status"];
  priority: ReviewItem["priority"];
  source_module: string;
  instance_id: string | null;
  target: string;
  action: string;
  confidence: number;
  created_at: string;
  review_after: string | null;
  title: string;
  why_uncertain: string;
  field: string | null;
  current_value: JsonValue;
  old_value: JsonValue;
  suggested_value: JsonValue;
  evidence: JsonValue[];
  impact: JsonObject;
  target_state: "unchanged" | "matches-suggestion" | "changed" | "unavailable";
  target_error: string | null;
  available_actions: string[];
  decision_history: ReviewItem["decision_history"];
  resolution: string | null;
  vault_path: string;
}

export interface ReviewDiscussionContext extends JsonObject {
  protocol_version: 1;
  ui_state: "waiting-for-ai";
  review_id: string;
  context_token: string;
  prepared_at: string;
  target: string;
  target_excerpt: JsonObject;
  review: JsonObject;
  prior_decisions: ReviewItem["decision_history"];
  allowed_outcomes: string[];
  instructions: string[];
}

function proposedObject(item: ReviewItem): JsonObject | null {
  return item.proposed_value && typeof item.proposed_value === "object" && !Array.isArray(item.proposed_value)
    ? item.proposed_value as JsonObject
    : null;
}

function fieldValue(data: JsonObject, field: string | null): JsonValue {
  if (!field) return null;
  if (field in data) return data[field] ?? null;
  const facts = data.facts;
  if (facts && typeof facts === "object" && !Array.isArray(facts)) {
    const fact = (facts as JsonObject)[field];
    if (fact && typeof fact === "object" && !Array.isArray(fact)) return (fact as JsonObject).value ?? null;
  }
  return null;
}

export async function buildReviewView(
  vaultRoot: string,
  item: ReviewItem,
  vaultPath: string,
): Promise<ReviewView> {
  const proposed = proposedObject(item);
  const field = typeof proposed?.field === "string" ? proposed.field : null;
  const oldValue = proposed?.old_value ?? null;
  const suggestedValue = proposed && "new_value" in proposed ? proposed.new_value ?? null : item.proposed_value;
  let currentValue: JsonValue = null;
  let targetError: string | null = null;
  let targetState: ReviewView["target_state"] = "unavailable";
  try {
    const target = fromVaultPath(vaultRoot, item.target);
    if (!(await exists(target))) throw new Error("目标文件不存在");
    const document = parseMarkdown(vaultRoot, target);
    currentValue = fieldValue(document.data, field);
    targetState = deepEqual(currentValue, suggestedValue)
      ? "matches-suggestion"
      : deepEqual(currentValue, oldValue)
        ? "unchanged"
        : "changed";
  } catch (error) {
    targetError = error instanceof Error ? error.message : String(error);
  }

  const actions = item.status === "pending"
    ? ["approve", "approve-with-modification", "reject", "defer", "discuss", "reconcile", "mark-resolved-by-user-edit"]
    : item.status === "error" ? ["retry"] : [];
  return {
    review_id: item.review_id,
    status: item.status,
    priority: item.priority,
    source_module: item.source_module,
    instance_id: item.instance_id,
    target: item.target,
    action: item.action,
    confidence: item.confidence,
    created_at: item.created,
    review_after: item.review_after,
    title: item.reason,
    why_uncertain: item.reason,
    field,
    current_value: currentValue,
    old_value: oldValue,
    suggested_value: suggestedValue,
    evidence: item.evidence,
    impact: {
      files: [item.target],
      fields: field ? [field] : [],
      estimated_operations: field ? 2 : 1,
      summary: `仅处理审核 ${item.review_id} 授权的目标；拒绝、延后和讨论不会修改正式字段。`,
    },
    target_state: targetState,
    target_error: targetError,
    available_actions: actions,
    decision_history: item.decision_history,
    resolution: item.resolution,
    vault_path: vaultPath,
  };
}

function contextToken(value: JsonObject): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export async function buildDiscussionContext(
  vaultRoot: string,
  item: ReviewItem,
  vaultPath: string,
): Promise<ReviewDiscussionContext> {
  const view = await buildReviewView(vaultRoot, item, vaultPath);
  const targetExcerpt: JsonObject = {
    field: view.field,
    current_value: view.current_value,
    target_state: view.target_state,
  };
  const review: JsonObject = {
    source_module: view.source_module,
    instance_id: view.instance_id,
    action: view.action,
    current_value: view.current_value,
    suggested_value: view.suggested_value,
    reason: view.why_uncertain,
    evidence: view.evidence,
    confidence: view.confidence,
    impact: view.impact,
  };
  const tokenPayload: JsonObject = {
    review_id: view.review_id,
    status: view.status,
    target: view.target,
    target_excerpt: targetExcerpt,
    review,
    prior_decisions: view.decision_history,
  };
  return {
    protocol_version: 1,
    ui_state: "waiting-for-ai",
    review_id: view.review_id,
    context_token: contextToken(tokenPayload),
    prepared_at: new Date().toISOString(),
    target: view.target,
    target_excerpt: targetExcerpt,
    review,
    prior_decisions: view.decision_history,
    allowed_outcomes: ["approve", "approve-with-modification", "reject", "continue-waiting", "needs-more-information"],
    instructions: [
      "只讨论此上下文中的审核事项，不加载整个 Vault。",
      "不得直接修改文件、执行 Git 或生成 Operation Plan。",
      "结论必须选择 allowed_outcomes 之一，并给出 user_comment。",
      "修改后接受还必须给出 modified_value。",
    ],
  };
}

export function discussionContextIsCurrent(expected: string, current: ReviewDiscussionContext): boolean {
  return expected === current.context_token;
}
