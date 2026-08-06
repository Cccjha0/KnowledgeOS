import { PkbError } from "./errors.js";
import type { JsonObject } from "./types.js";

/** A document's privacy sensitivity. Higher values require stronger module permission. */
export type SensitivityClass = 0 | 1 | 2 | 3;
/** Attachments remain unreadable until their privacy classification is known. */
export type AttachmentSensitivityClass = SensitivityClass | "unknown";
export type ClassificationState = "unclassified" | "classified" | "inherited";

/** The representation a Workflow may receive after sensitivity authorization succeeds. */
export type RepresentationLevel = "metadata" | "summary" | "full" | "sensitive-original";

/**
 * Retained only for parsing old Vault data and API calls. It must not be used
 * as an authorization contract for newly created files, Workflows, or modules.
 */
export type LegacyReadLevel = 0 | 1 | 2 | 3;

export interface DocumentAccessPolicy {
  sensitivity_class: AttachmentSensitivityClass;
  max_representation: RepresentationLevel;
  classification_state: ClassificationState;
  policy_source: "explicit" | "legacy" | "default" | "inherited";
  legacy_read_level?: LegacyReadLevel;
}

const REPRESENTATION_RANK: Record<RepresentationLevel, number> = {
  metadata: 0,
  summary: 1,
  full: 2,
  "sensitive-original": 3,
};

export function assertSensitivityClass(value: number, label = "sensitivity_class"): SensitivityClass {
  if (!Number.isInteger(value) || value < 0 || value > 3) throw new PkbError("SENSITIVITY_CLASS_INVALID", `${label} must be an integer from 0 to 3.`);
  return value as SensitivityClass;
}

export function assertRepresentationLevel(value: unknown, label = "representation"): RepresentationLevel {
  if (value !== "metadata" && value !== "summary" && value !== "full" && value !== "sensitive-original") {
    throw new PkbError("REPRESENTATION_LEVEL_INVALID", `${label} must be metadata, summary, full, or sensitive-original.`);
  }
  return value;
}

export function representationPermits(maximum: RepresentationLevel, requested: RepresentationLevel): boolean {
  return REPRESENTATION_RANK[requested] <= REPRESENTATION_RANK[maximum];
}

export function defaultMaxRepresentation(sensitivityClass: SensitivityClass): RepresentationLevel {
  // New documents default conservatively as their sensitivity rises. Existing
  // `read_level` documents use the legacy branch below to avoid a surprise
  // behavior change before the user explicitly migrates them.
  return sensitivityClass === 3 ? "metadata" : sensitivityClass === 2 ? "summary" : "full";
}

export function unclassifiedDocumentAccessPolicy(): DocumentAccessPolicy {
  return { sensitivity_class: "unknown", max_representation: "metadata", classification_state: "unclassified", policy_source: "default" };
}

/** Resolves explicit policy first, then legacy data, then a safe default. */
export function resolveDocumentAccessPolicy(data: JsonObject, fallbackSensitivityClass: SensitivityClass = 0): DocumentAccessPolicy {
  if (data.classification_state === "unclassified" || data.sensitivity_class === "unknown") return unclassifiedDocumentAccessPolicy();
  if (typeof data.sensitivity_class === "number") {
    const sensitivityClass = assertSensitivityClass(data.sensitivity_class);
    const rawPolicy = data.access_policy;
    const policy = rawPolicy && typeof rawPolicy === "object" && !Array.isArray(rawPolicy) ? rawPolicy as JsonObject : {};
    return {
      sensitivity_class: sensitivityClass,
      max_representation: policy.max_representation === undefined
        ? defaultMaxRepresentation(sensitivityClass)
        : assertRepresentationLevel(policy.max_representation, "access_policy.max_representation"),
      classification_state: data.classification_state === "inherited" ? "inherited" : "classified",
      policy_source: data.policy_source === "inherited" ? "inherited" : "explicit",
    };
  }
  if (typeof data.read_level === "number") {
    const legacy = assertSensitivityClass(data.read_level, "legacy read_level");
    // The old field was implemented as a sensitivity gate in practice. Keep
    // its existing readable behavior until the document receives an explicit
    // policy, while preserving the legacy origin in every audit record.
    return { sensitivity_class: legacy, max_representation: "sensitive-original", classification_state: "inherited", policy_source: "legacy", legacy_read_level: legacy };
  }
  return { sensitivity_class: fallbackSensitivityClass, max_representation: defaultMaxRepresentation(fallbackSensitivityClass), classification_state: "inherited", policy_source: "default" };
}

export function representationFromLegacyReadLevel(value: number, label = "legacy read_level"): RepresentationLevel {
  const legacy = assertSensitivityClass(value, label);
  return legacy === 0 ? "metadata" : legacy === 1 ? "summary" : legacy === 2 ? "full" : "sensitive-original";
}

/**
 * Level-1 content is intentionally opt-in. Generic fields such as `summary`,
 * `abstract`, or the first body paragraph may contain exactly the private text
 * a user chose not to disclose. Only a deliberately authored `safe_summary`
 * is eligible for a summary representation.
 */
export function requireSafeSummary(data: JsonObject, sourcePath: string): string {
  if (typeof data.safe_summary === "string" && data.safe_summary.trim()) return data.safe_summary.trim();
  throw new PkbError("SAFE_SUMMARY_REQUIRED", `Workflow requested a summary of ${sourcePath}, but the document has no explicit safe_summary.`, {
    source_path: sourcePath,
    required_field: "safe_summary",
    requested_representation: "summary",
  });
}

/** @deprecated Use SensitivityClass and RepresentationLevel separately. */
export const assertReadLevel = assertSensitivityClass;
/** @deprecated Use SensitivityClass and RepresentationLevel separately. */
export type ReadLevel = LegacyReadLevel;
