export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type Risk = "green" | "yellow" | "red";
export type Priority = "low" | "medium" | "high" | "critical";
export type ReviewDecisionKind = "approve" | "approve-with-modification" | "reject" | "defer" | "discuss";
export type ReviewStatus = "pending" | "approved" | "approved-with-modification" | "rejected" | "deferred" | "resolved-by-user-edit" | "error";

export interface ReviewDecision extends JsonObject {
  review_id: string;
  decision: ReviewDecisionKind;
  user_comment: string;
  decided_at: string;
  review_after: string | null;
  modified_value: JsonValue;
}

export interface ReviewTargetObservation extends JsonObject {
  field: string;
  observed_value: JsonValue;
  checked_at: string;
  matches: "old" | "proposed" | "neither";
}

export interface DashboardItem extends JsonObject {
  item_id: string;
  source_module: string;
  instance_id: string | null;
  category: "action" | "review" | "research" | "summary" | "deadline" | "warning" | "status" | "system";
  priority: Priority;
  title: string;
  description: string;
  target: string | null;
  due_at: string | null;
  actions: string[];
  created_at: string | null;
  blocks_count: number;
  active_context: boolean;
}

export interface TodayInboxGroup extends JsonObject {
  group_id: string;
  scope: "global" | "module" | "instance";
  label: string;
  source_module: string | null;
  instance_id: string | null;
  count: number;
  oldest_created_at: string | null;
  unroutable_count: number;
  failed_count: number;
  items: DashboardItem[];
}

export interface RecentRunSummary extends JsonObject {
  run_id: string;
  source_module: string;
  instance_id: string | null;
  status: "completed" | "failed";
  completed_at: string;
  plan_id: string | null;
  review_id: string | null;
  target: string;
  can_rollback: boolean;
}

export interface TodaySnapshot extends JsonObject {
  schema_version: 1;
  generated_at: string;
  focus: DashboardItem[];
  reviews: DashboardItem[];
  inbox: TodayInboxGroup[];
  due: DashboardItem[];
  waiting_external: DashboardItem[];
  failures: DashboardItem[];
  recent_completed: RecentRunSummary[];
  module_summaries: DashboardItem[];
  counts: JsonObject;
}

export interface RunLog extends JsonObject {
  run_id: string;
  task_id: string | null;
  plan_id: string | null;
  source_module: string;
  instance_id: string | null;
  review_id: string | null;
  status: "completed" | "failed";
  git_snapshot: string | null;
  started_at: string;
  completed_at: string;
  schema_version: 1;
}

export interface MarkdownDocument {
  data: JsonObject;
  content: string;
}

export interface ReviewItem extends JsonObject {
  review_id: string;
  schema_version: number;
  source_module: string;
  instance_id: string | null;
  target: string;
  action: string;
  proposed_value: JsonValue;
  confidence: number;
  priority: Priority;
  status: ReviewStatus;
  reason: string;
  evidence: JsonValue[];
  created: string;
  review_after: string | null;
  decision: ReviewDecision | null;
  decision_history: ReviewDecision[];
  target_observation: ReviewTargetObservation | null;
  resolution: string | null;
}

export interface Operation extends JsonObject {
  operation_id: string;
  type: string;
  target: string | null;
  risk: Risk;
  confidence: number;
  idempotency_key: string;
  payload: JsonObject;
  requires_review_id: string | null;
}

export interface OperationPlan extends JsonObject {
  plan_id: string;
  task_id: string;
  source_module: string;
  instance_id: string | null;
  summary: string;
  operations: Operation[];
  review_items: ReviewItem[];
}
