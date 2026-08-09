import type { JsonObject, JsonValue } from "../core/types.js";

function object(value: JsonValue | undefined): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function strings(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()))]
    : [];
}

function referencedField(reference: string, entityId: string): string | null {
  const [entity, field] = reference.split(".", 2);
  if (field) return entity === entityId ? field : null;
  return reference.includes(".") ? null : reference;
}

/** The single Core-facing quality contract for an Entity field. */
export interface FieldQualityPolicy {
  critical: boolean;
  provenanceRequired: boolean;
  verificationIntervalDays: number | null;
  staleAction: JsonObject | null;
}

function policyFromConfig(config: JsonObject): FieldQualityPolicy {
  return {
    critical: config.critical === true,
    provenanceRequired: config.provenance === "required",
    verificationIntervalDays: typeof config.verification_interval_days === "number" && config.verification_interval_days > 0
      ? config.verification_interval_days : null,
    staleAction: object(config.stale_action),
  };
}

/**
 * Resolves field policy from the canonical `field_policies` map. Legacy
 * arrays/maps remain readable only when a policy has not yet migrated.
 * Once `field_policies` exists, it is the sole runtime authority.
 */
export function resolveFieldQualityPolicies(policy: JsonObject, entityId: string): Map<string, FieldQualityPolicy> {
  const canonical = object(policy.field_policies);
  if (canonical) {
    const resolved = new Map<string, FieldQualityPolicy>();
    for (const [reference, raw] of Object.entries(canonical)) {
      const field = referencedField(reference, entityId); const config = object(raw);
      if (!field || !config) continue;
      resolved.set(field, policyFromConfig(config));
    }
    return resolved;
  }

  // Compatibility for pre-v1.1 policies. New Beta/Stable modules are
  // rejected by validation unless they declare field_policies.
  const critical = new Set(strings(policy.critical_fields).flatMap((reference) => {
    const field = referencedField(reference, entityId); return field ? [field] : [];
  }));
  const provenance = new Set(strings(policy.provenance_required).flatMap((reference) => {
    const field = referencedField(reference, entityId); return field ? [field] : [];
  }));
  const freshness = object(policy.freshness) ?? {};
  const fields = new Set([...critical, ...provenance]);
  for (const reference of Object.keys(freshness)) {
    const field = referencedField(reference, entityId); if (field) fields.add(field);
  }
  const resolved = new Map<string, FieldQualityPolicy>();
  for (const field of fields) {
    const raw = object(freshness[`${entityId}.${field}`]) ?? object(freshness[field]) ?? {};
    resolved.set(field, {
      critical: critical.has(field),
      provenanceRequired: provenance.has(field),
      verificationIntervalDays: typeof raw.interval_days === "number" && raw.interval_days > 0 ? raw.interval_days : null,
      staleAction: object(raw.stale_action),
    });
  }
  return resolved;
}

export function resolveFieldQualityPolicy(policy: JsonObject, entityId: string, field: string): FieldQualityPolicy | null {
  return resolveFieldQualityPolicies(policy, entityId).get(field) ?? null;
}
