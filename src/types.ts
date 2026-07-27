import type { JsonObject, JsonValue, ReviewItem } from "./core/types.js";
export * from "./core/types.js";

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

export interface ProcessedReportState {
  hash: string;
  processed_at: string;
  run_id: string;
  destination: string;
}

export interface ProcessedReportsFile {
  reports: Record<string, ProcessedReportState>;
}
