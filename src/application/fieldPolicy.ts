export const AUTO_UPDATE_FIELDS = new Set([
  "last_checked",
  "next_check",
  "source_files",
  "source_refs",
  "verification_log",
]);

export const REVIEW_REQUIRED_FIELDS = new Set([
  "application_status",
  "application_open",
  "deadline",
  "tuition",
  "academic_requirement",
  "english_requirement",
  "credit_exemption",
]);

export const PRIOR_CONFIRMATION_FIELDS = new Set([
  "submitted_at",
  "offer_accepted",
  "deposit_paid",
  "coe_received",
  "visa_submitted",
]);

export type FieldRisk = "automatic" | "review-required" | "prior-confirmation" | "review-by-default";

export function fieldRisk(field: string): FieldRisk {
  if (AUTO_UPDATE_FIELDS.has(field)) return "automatic";
  if (REVIEW_REQUIRED_FIELDS.has(field)) return "review-required";
  if (PRIOR_CONFIRMATION_FIELDS.has(field)) return "prior-confirmation";
  return "review-by-default";
}
