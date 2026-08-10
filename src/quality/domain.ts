import type { JsonObject, JsonValue } from "../core/types.js";

export type Authorship = "user" | "ai" | "system" | "official-source" | "external-research";
/** Evidence origin is intentionally separate from document authorship. */
export type EvidenceSourceType = Authorship | "user-confirmation";
export type SourceAuthority = "primary-official" | "secondary-official" | "authoritative-third-party" | "user-observation" | "external-research" | "unverified-third-party" | "unknown";
export type EvidenceStatus = "active" | "superseded" | "conflicting" | "unavailable" | "withdrawn";
export type VerificationStatus = "verified" | "due-soon" | "stale" | "unverifiable" | "historical" | "unknown";
export type Ownership = "user-owned" | "ai-managed" | "system-managed" | "source-immutable" | "mixed";
export type QualityDimension = "provenance" | "freshness" | "validity" | "consistency" | "completeness" | "connectivity" | "reviewability";
export type QualitySeverity = "critical" | "high" | "medium" | "low" | "info";
export type QualityIssueStatus = "open" | "acknowledged" | "scheduled" | "resolved" | "ignored" | "suppressed";

export interface VerificationRecord extends JsonObject {
  last_verified: string | null;
  verification_interval_days: number | null;
  stale_after: string | null;
  stale: boolean;
  verification_status: VerificationStatus;
}

export interface ProvenanceRecord extends JsonObject {
  authorship: Authorship;
  evidence_refs: string[];
  generation: JsonObject | null;
  review: JsonObject | null;
  verification: VerificationRecord;
}

export interface EvidenceRecord extends JsonObject {
  evidence_id: string;
  source_type: EvidenceSourceType;
  source_ref: string;
  supports: JsonObject[];
  locator: JsonObject;
  observed_at: string;
  captured_at: string;
  collector: JsonObject;
  quality: JsonObject;
  status: EvidenceStatus;
}

export interface QualityIssue extends JsonObject {
  issue_id: string;
  fingerprint: string;
  issue_type: string;
  dimension: QualityDimension;
  severity: QualitySeverity;
  module: string;
  instance_id: string | null;
  target: JsonObject;
  detected_at: string;
  detector: JsonObject;
  evidence: JsonObject;
  status: QualityIssueStatus;
  recommended_action: JsonObject;
  first_seen: string;
  last_seen: string;
  occurrence_count: number;
  last_notified: string | null;
  suppressed_until: string | null;
  resolution: JsonObject | null;
}

export interface MetricEvent extends JsonObject {
  metric_id: string;
  idempotency_key: string;
  event_type: string;
  module: string;
  instance_id: string | null;
  workflow_id: string | null;
  workflow_version: string | null;
  prompt_id: string | null;
  prompt_version: string | null;
  run_id: string | null;
  occurred_at: string;
  dimensions: JsonObject;
  values: JsonObject;
}

export interface ChangeRecord extends JsonObject {
  change_id: string;
  entity_ref: string;
  field: string;
  old_value: JsonValue;
  new_value: JsonValue;
  reason: string;
  evidence_refs: string[];
  generation: JsonObject | null;
  review: JsonObject | null;
  changed_at: string;
}

export interface QualityPolicy extends JsonObject {
  /** Legacy v1 fields. Runtime reads them only when field_policies is absent. */
  critical_fields: string[] | null;
  provenance_required: string[] | null;
  freshness: JsonObject | null;
  /** Entity-qualified rules emitted by Blueprint v1.1, e.g. assignment.deadline. */
  field_policies: JsonObject | null;
  ownership: JsonObject;
  audits: string[];
  orphan_exempt_entity_types: string[];
}
