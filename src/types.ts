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

export interface MarkdownDocument {
  data: JsonObject;
  content: string;
}

export interface ApplicationFact extends JsonObject {
  value: JsonValue;
  status: "confirmed" | "pending" | "conflicting" | "unknown";
  confidence: number;
  checked_at: string | null;
  source_refs: JsonValue[];
  notes: string;
}

export interface ApplicationRecord extends JsonObject {
  id: string;
  module: "application-tracker";
  module_instance: string;
  type: "application-record";
  institution: string;
  program_name: string;
  program_code: string | null;
  country: string;
  intake: string;
  application_status: string;
  monitoring: JsonObject & {
    active: boolean;
    check_interval_days: number;
    last_checked: string | null;
    next_check: string | null;
  };
  facts: Record<string, ApplicationFact>;
  source_files: JsonValue[];
  created: string;
  updated: string;
  schema_version: number;
}

export interface ResearchFinding extends JsonObject {
  value: JsonValue;
  status: "confirmed" | "pending" | "conflicting" | "unknown";
  confidence: number;
  source_ids: JsonValue[];
  notes: string;
}

export interface ResearchReport extends JsonObject {
  report_id: string;
  research_type: "application-update";
  instance_id: string;
  institution: string;
  program_name: string;
  program_code: string | null;
  intake: string;
  checked_at: string;
  material_change: boolean;
  confidence: number;
  sources: JsonValue[];
  findings: Record<string, ResearchFinding>;
  unresolved: JsonValue[];
  summary: string;
}

export interface ReviewItem extends JsonObject {
  review_id: string;
  schema_version: number;
  source_module: string;
  module_instance: string | null;
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

export interface FieldChange extends JsonObject {
  field: string;
  old_value: JsonValue;
  new_value: JsonValue;
  confidence: number;
  action: "no-change" | "auto-update" | "review" | "ignore";
  reason: string;
  source_ids: JsonValue[];
}

export interface UpdateResult extends JsonObject {
  target_record: string;
  material_change: boolean;
  field_changes: FieldChange[];
  frontmatter_patch: JsonObject;
  sections_to_append: Array<JsonObject & { section: string; content: string }>;
  review_items: ReviewItem[];
  next_check: string;
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
  module: string;
  instance: string | null;
  summary: string;
  operations: Operation[];
  review_items: ReviewItem[];
}

export interface ProcessedReportState {
  hash: string;
  processed_at: string;
  run_id: string;
  destination: string;
}

export interface ProcessedReportsFile {
  reports: Record<string, ProcessedReportState>;
}
