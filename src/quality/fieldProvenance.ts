import path from "node:path";
import { parseYaml } from "../core/bridge.js";
import type { JsonObject, JsonValue } from "../core/types.js";
import { evaluateFreshness } from "./freshness.js";
import { QualityRepository } from "./repository.js";

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()))] : [];
}

export interface FieldQualityContract {
  provenanceRequired: boolean;
  verificationIntervalDays: number | null;
}

/**
 * Loads the module-owned Quality Contract. The workflow never asks Codex to
 * interpret this file: it is a deterministic Core policy applied at write time.
 */
export function fieldQualityContracts(moduleRoot: string, manifest: JsonObject, entityId: string): Map<string, FieldQualityContract> {
  const relative = typeof object(manifest.quality)?.policy === "string" ? String(object(manifest.quality)!.policy) : null;
  if (!relative) return new Map();
  const policy = parseYaml(moduleRoot, path.join(moduleRoot, ...relative.split("/")));
  const declared = object(policy.field_policies) ?? {};
  const result = new Map<string, FieldQualityContract>();
  for (const [qualifiedField, raw] of Object.entries(declared)) {
    const [declaredEntity, field] = qualifiedField.split(".", 2);
    if (declaredEntity !== entityId || !field) continue;
    const config = object(raw) ?? {};
    const verificationIntervalDays = typeof config.verification_interval_days === "number" && config.verification_interval_days > 0
      ? config.verification_interval_days : null;
    const provenanceRequired = config.provenance === "required";
    if (provenanceRequired || verificationIntervalDays !== null) result.set(field, { provenanceRequired, verificationIntervalDays });
  }
  return result;
}

export interface MaterializeFieldProvenanceOptions {
  vaultRoot: string;
  moduleRoot: string;
  manifest: JsonObject;
  entityId: string;
  target: string;
  output: JsonObject;
  /** Only documents which Core actually authorized and read for this run. */
  authorizedSourceRefs: string[];
  runId: string;
  generation: JsonObject | null;
  review: JsonObject | null;
  now?: string;
}

/**
 * Materialize field provenance from Core-controlled inputs. Model output is
 * deliberately not consulted for evidence, verification time, or review state.
 */
export async function materializeFieldProvenance(options: MaterializeFieldProvenanceOptions): Promise<JsonObject> {
  const contracts = fieldQualityContracts(options.moduleRoot, options.manifest, options.entityId);
  if (!contracts.size) return {};
  const sourceRefs = strings(options.authorizedSourceRefs);
  const now = options.now ?? new Date().toISOString();
  const repository = await QualityRepository.open(options.vaultRoot);
  try {
    const existing = repository.listEvidence(5_000);
    const fieldMeta: JsonObject = {};
    for (const [field, contract] of contracts) {
      const value: JsonValue | undefined = options.output[field];
      if (value === undefined || value === null) continue;
      const evidenceRefs: string[] = [];
      if (contract.provenanceRequired) {
        for (const sourceRef of sourceRefs) {
          const match = existing.find((entry) => entry.source_ref === sourceRef
            && entry.supports.some((support) => support.entity_ref === options.target && support.field === field));
          const evidence = match ?? repository.upsertEvidence({
            source_type: "user",
            source_ref: sourceRef,
            supports: [{ entity_ref: options.target, field }],
            locator: {},
            observed_at: now,
            captured_at: now,
            collector: { type: "workflow-authorized-input", run_id: options.runId },
            quality: { authority: "unknown", freshness: "current", extraction_confidence: 1 },
            status: "active",
          });
          evidenceRefs.push(evidence.evidence_id);
        }
      }
      const verification = evaluateFreshness({ lastVerified: sourceRefs.length ? now : null, intervalDays: contract.verificationIntervalDays, now: new Date(now) });
      fieldMeta[field] = {
        authorship: options.generation ? "ai" : "system",
        evidence_refs: evidenceRefs,
        generation: options.generation,
        review: options.review,
        verification,
      };
    }
    return fieldMeta;
  } finally {
    repository.close();
  }
}
