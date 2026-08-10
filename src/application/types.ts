import type { JsonObject, JsonValue, ReviewItem } from "../core/types.js";

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
  source_module: "application-tracker";
  instance_id: string;
  type: "application-record";
  institution: string;
  program_name: string;
  program_code: string | null;
  country: string;
  intake: string;
  application_status: "watching" | "not-open" | "open" | "preparing" | "submitted" | "awaiting-result" | "conditional-offer" | "unconditional-offer" | "accepted" | "coe-issued" | "visa-processing" | "completed" | "rejected" | "withdrawn" | "archived";
  monitoring: JsonObject & { active: boolean; check_interval_days: number; last_checked: string | null; next_check: string | null; stopped: JsonValue[] };
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
  request_id: string | null;
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

export interface FieldChange extends JsonObject {
  field: string;
  old_value: JsonValue;
  new_value: JsonValue;
  confidence: number;
  action: "no-change" | "auto-update" | "review" | "user-confirmation-required" | "ignore";
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

export interface ResearchRequest extends JsonObject {
  request_id: string;
  type: "research-request";
  instance_id: string;
  application_id: string;
  record_path: string;
  status: "pending" | "in-progress" | "needs-more-information" | "completed" | "cancelled";
  reason: string;
  requested_fields: string[];
  report_ids: string[];
  idempotency_key: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  next_action_at: string | null;
  schema_version: 1;
}

export interface ApplicationDocument extends JsonObject {
  document_id: string;
  type: "application-document";
  instance_id: string;
  application_id: string;
  document_type: string;
  status: "required" | "collecting" | "ready" | "submitted" | "not-applicable";
  path: string;
  requested_at: string | null;
  due_at: string | null;
  submitted_at: string | null;
  source_refs: string[];
  notes: string;
  created: string;
  updated: string;
  schema_version: 1;
}
