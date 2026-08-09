import { createHash } from "node:crypto";
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
  critical: boolean;
  provenanceRequired: boolean;
  verificationIntervalDays: number | null;
}

/** An immutable handle for one source Core admitted to this Workflow. The
 * model may select this ID, but never invent an arbitrary Vault path. */
export interface AuthorizedEvidenceSource {
  source_id: string;
  source_ref: string;
  /** Locators are issued by Core from the exact material admitted to Context. */
  locators: EvidenceLocator[];
}

export interface EvidenceLocator extends JsonObject {
  locator_id: string;
  locator: JsonObject;
}

export interface EvidenceSelection extends JsonObject {
  source_id: string;
  locator_id: string;
  locator: JsonObject;
}

export type FieldEvidenceSelections = Record<string, EvidenceSelection[]>;

export interface EvidenceSourceInput {
  source_ref: string;
  locators?: EvidenceLocator[];
}

export function evidenceSourceId(sourceRef: string): string {
  return `SRC-${createHash("sha256").update(sourceRef, "utf8").digest("hex").slice(0, 12).toUpperCase()}`;
}

function normalizedLocators(locators: EvidenceLocator[] | undefined): EvidenceLocator[] {
  const source = Array.isArray(locators) && locators.length ? locators : [{ locator_id: "LOC-DOCUMENT", locator: {} }];
  const seen = new Set<string>();
  return source.map((entry) => {
    const locatorId = typeof entry?.locator_id === "string" ? entry.locator_id.trim() : "";
    const locator = object(entry?.locator);
    if (!locatorId || !locator) throw new Error("Core-issued evidence locators require locator_id and locator.");
    if (seen.has(locatorId)) throw new Error(`Duplicate Core-issued evidence locator ${locatorId}.`);
    seen.add(locatorId);
    return { locator_id: locatorId, locator: structuredClone(locator) };
  });
}

/** Builds the immutable source/locator catalog that a model may choose from. */
export function authorizedEvidenceSources(inputs: Array<string | EvidenceSourceInput>): AuthorizedEvidenceSource[] {
  const bySource = new Map<string, EvidenceLocator[]>();
  for (const input of inputs) {
    const sourceRef = typeof input === "string" ? input.trim() : typeof input?.source_ref === "string" ? input.source_ref.trim() : "";
    if (!sourceRef || bySource.has(sourceRef)) continue;
    bySource.set(sourceRef, normalizedLocators(typeof input === "string" ? undefined : input.locators));
  }
  return [...bySource.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([sourceRef, locators]) => ({ source_id: evidenceSourceId(sourceRef), source_ref: sourceRef, locators }));
}

/** Parses the model's evidence proposal. It deliberately accepts source IDs
 * plus Core-issued locator IDs; Core resolves both against the audited Context. */
export function parseEvidenceSelections(value: unknown, sources: AuthorizedEvidenceSource[], options: { allowLegacyLocator?: boolean } = {}): FieldEvidenceSelections {
  if (value === undefined) return {};
  const raw = object(value);
  if (!raw) throw new Error("_evidence_selection must be an object keyed by output field.");
  const allowed = new Map(sources.map((source) => [source.source_id, source]));
  const result: FieldEvidenceSelections = {};
  for (const [field, rawSelections] of Object.entries(raw)) {
    if (!field.trim() || !Array.isArray(rawSelections)) throw new Error(`_evidence_selection.${field} must be an array.`);
    const selections: EvidenceSelection[] = [];
    for (const rawSelection of rawSelections) {
      const selection = object(rawSelection);
      const sourceId = typeof selection?.source_id === "string" ? selection.source_id.trim() : "";
      const source = allowed.get(sourceId);
      if (!sourceId || !source) throw new Error(`_evidence_selection.${field} references an input that Core did not authorize.`);
      const locatorId = typeof selection?.locator_id === "string" ? selection.locator_id.trim() : "";
      const issued = locatorId ? source.locators.find((locator) => locator.locator_id === locatorId) : undefined;
      if (issued) {
        selections.push({ source_id: sourceId, locator_id: issued.locator_id, locator: structuredClone(issued.locator) });
      } else if (options.allowLegacyLocator) {
        const locator = selection?.locator === undefined ? {} : object(selection.locator);
        if (!locator) throw new Error(`_evidence_selection.${field} has an invalid legacy locator.`);
        // A Review can predate Locator Contract v1. Its selection was already
        // Core-validated before being persisted, so retain it only on the
        // approval migration path; normal Codex output is always strict.
        selections.push({ source_id: sourceId, locator_id: locatorId || "LOC-LEGACY", locator: structuredClone(locator) });
      } else {
        throw new Error(`_evidence_selection.${field} must select a Core-issued locator_id for its authorized source.`);
      }
    }
    result[field] = selections;
  }
  return result;
}

function selectionsForField(field: string, selections: FieldEvidenceSelections, sources: AuthorizedEvidenceSource[]): Array<EvidenceSelection & { source_ref: string }> {
  const sourcesById = new Map(sources.map((source) => [source.source_id, source.source_ref]));
  const seen = new Set<string>();
  return (selections[field] ?? []).flatMap((selection) => {
    const sourceRef = sourcesById.get(selection.source_id);
    const fingerprint = `${selection.source_id}:${selection.locator_id}`;
    if (!sourceRef || seen.has(fingerprint)) return [];
    seen.add(fingerprint);
    return [{ ...selection, source_ref: sourceRef }];
  });
}

export function selectedEvidenceRefs(selections: FieldEvidenceSelections, sources: AuthorizedEvidenceSource[]): string[] {
  return [...new Set(Object.keys(selections).flatMap((field) => selectionsForField(field, selections, sources).map((selection) => selection.source_ref)))];
}

/** A field that declares provenance as required must name an actual supporting
 * input. Criticality controls the risk of changing a value; it does not make a
 * source mandatory by itself. */
export function fieldsMissingRequiredEvidence(moduleRoot: string, manifest: JsonObject, entityId: string, output: JsonObject, selections: FieldEvidenceSelections, sources: AuthorizedEvidenceSource[]): string[] {
  return [...fieldQualityContracts(moduleRoot, manifest, entityId)]
    .filter(([field, contract]) => contract.provenanceRequired && output[field] !== undefined && output[field] !== null && selectionsForField(field, selections, sources).length === 0)
    .map(([field]) => field);
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
  const declaredCritical = new Set(strings(policy.critical_fields).flatMap((entry) => {
    const [declaredEntity, field] = entry.split(".", 2);
    return declaredEntity === entityId && field ? [field] : !entry.includes(".") ? [entry] : [];
  }));
  const result = new Map<string, FieldQualityContract>();
  for (const [qualifiedField, raw] of Object.entries(declared)) {
    const [declaredEntity, field] = qualifiedField.split(".", 2);
    if (declaredEntity !== entityId || !field) continue;
    const config = object(raw) ?? {};
    const verificationIntervalDays = typeof config.verification_interval_days === "number" && config.verification_interval_days > 0
      ? config.verification_interval_days : null;
    const provenanceRequired = config.provenance === "required";
    const critical = config.critical === true || declaredCritical.has(field);
    if (critical || provenanceRequired || verificationIntervalDays !== null) result.set(field, { critical, provenanceRequired, verificationIntervalDays });
  }
  for (const field of declaredCritical) if (!result.has(field)) result.set(field, { critical: true, provenanceRequired: false, verificationIntervalDays: null });
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
  authorizedSources: AuthorizedEvidenceSource[];
  /** Model-selected supporting sources, validated against authorizedSources. */
  evidenceSelections: FieldEvidenceSelections;
  runId: string;
  generation: JsonObject | null;
  review: JsonObject | null;
  now?: string;
}

/**
 * Materialize field provenance from Core-controlled selections. Model output
 * may choose source IDs and locators, but cannot introduce a path or evidence
 * outside the context Core authorized for this run.
 */
export async function materializeFieldProvenance(options: MaterializeFieldProvenanceOptions): Promise<JsonObject> {
  const contracts = fieldQualityContracts(options.moduleRoot, options.manifest, options.entityId);
  if (!contracts.size) return {};
  const sources = options.authorizedSources.filter((source) => typeof source.source_id === "string" && typeof source.source_ref === "string");
  const now = options.now ?? new Date().toISOString();
  const repository = await QualityRepository.open(options.vaultRoot);
  try {
    const existing = repository.listEvidence(5_000);
    const fieldMeta: JsonObject = {};
    for (const [field, contract] of contracts) {
      const value: JsonValue | undefined = options.output[field];
      if (value === undefined || value === null || (!contract.provenanceRequired && contract.verificationIntervalDays === null)) continue;
      const evidenceRefs: string[] = [];
      if (contract.provenanceRequired) {
        for (const selection of selectionsForField(field, options.evidenceSelections, sources)) {
          const match = existing.find((entry) => entry.source_ref === selection.source_ref
            && entry.supports.some((support) => support.entity_ref === options.target && support.field === field)
            && JSON.stringify(entry.locator) === JSON.stringify(selection.locator));
          const evidence = match ?? repository.upsertEvidence({
            source_type: "user",
            source_ref: selection.source_ref,
            supports: [{ entity_ref: options.target, field }],
            locator: selection.locator,
            observed_at: now,
            captured_at: now,
            collector: { type: "workflow-evidence-selection", run_id: options.runId, source_id: selection.source_id },
            quality: { authority: "unknown", freshness: "current", extraction_confidence: 1 },
            status: "active",
          });
          evidenceRefs.push(evidence.evidence_id);
        }
      }
      const verification = evaluateFreshness({ lastVerified: evidenceRefs.length ? now : null, intervalDays: contract.verificationIntervalDays, now: new Date(now) });
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
