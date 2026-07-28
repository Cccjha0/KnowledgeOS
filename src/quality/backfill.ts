import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMarkdown, parseYaml, writeMarkdown } from "../core/bridge.js";
import { discoverInstances, discoverModulesForVault } from "../core/discovery.js";
import { allocateId } from "../core/ids.js";
import { createGitSnapshot } from "../core/git.js";
import { listFilesRecursive, toVaultPath, writeJsonAtomic } from "../core/files.js";
import { executeOperationPlan } from "../core/operationExecutor.js";
import type { JsonObject, Operation, OperationPlan } from "../core/types.js";
import { QualityRepository } from "./repository.js";
import { qualityFingerprint } from "./fingerprint.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
interface Candidate { target: string; module: string; instanceId: string | null; metadata: JsonObject; ownership: JsonObject | null; fields: { field: string; sourceRefs: string[]; checkedAt: string | null }[]; }

function object(value: unknown): JsonObject | null { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null; }
async function candidates(vaultRoot: string): Promise<{ candidates: Candidate[]; blocked_fields: JsonObject[] }> {
  const active = new Set((await discoverInstances(vaultRoot)).filter((entry) => entry.data.status === "active").map((entry) => String(entry.data.instance_id)));
  const policies = new Map<string, JsonObject>();
  for (const module of await discoverModulesForVault(ENGINE_ROOT, vaultRoot)) {
    const quality = object(module.data.quality); if (typeof quality?.policy !== "string") continue;
    policies.set(String(module.data.id), parseYaml(path.dirname(module.path), path.join(path.dirname(module.path), ...quality.policy.split("/"))));
  }
  const output: Candidate[] = []; const blocked: JsonObject[] = [];
  for (const root of ["20-Workspace", "30-Knowledge"]) for (const file of await listFilesRecursive(path.join(vaultRoot, root), ".md")) {
    let document; try { document = parseMarkdown(vaultRoot, file); } catch { continue; }
    const inferredModule = document.data.research_type === "application-update" ? "application-tracker" : "";
    const module = String(document.data.source_module ?? document.data.module_id ?? inferredModule); const instanceId = typeof document.data.instance_id === "string" ? document.data.instance_id : null;
    if (!module || (instanceId && !active.has(instanceId))) continue;
    const policy = policies.get(module); if (!policy) continue; const type = String(document.data.type ?? (document.data.research_type === "application-update" ? "research-report" : "")); const owner = object(object(policy.ownership)?.[type]);
    const expectedOwnership = owner?.required === true ? object(owner.sections) : null; const currentOwnership = object(object(document.data._ownership)?.sections);
    const ownership = expectedOwnership && JSON.stringify(currentOwnership) !== JSON.stringify(expectedOwnership) ? expectedOwnership : null;
    const metadata: JsonObject = {};
    if (inferredModule && typeof document.data.source_module !== "string") metadata.source_module = inferredModule;
    if (type && typeof document.data.type !== "string") metadata.type = type;
    if (type === "research-report" && !Number.isInteger(document.data.schema_version)) metadata.schema_version = 1;
    const fields: Candidate["fields"] = [];
    if (module === "application-tracker") for (const field of (policy.critical_fields as string[] | undefined) ?? []) {
      const fact = object(object(document.data.facts)?.[field]); const value = field in document.data ? document.data[field] : fact?.value;
      if (value === undefined || value === null || object(document.data._field_meta)?.[field]) continue;
      const rawRefs = Array.isArray(fact?.source_refs) ? fact!.source_refs : Array.isArray(document.data.source_files) ? document.data.source_files : [];
      const refs = rawRefs.filter((entry): entry is string => typeof entry === "string");
      if (!refs.length) { blocked.push({ target: toVaultPath(vaultRoot, file), field, reason: "source-reference-required" }); continue; }
      fields.push({ field, sourceRefs: refs, checkedAt: typeof fact?.checked_at === "string" ? fact.checked_at : typeof object(document.data.monitoring)?.last_checked === "string" ? String(object(document.data.monitoring)!.last_checked) : null });
    }
    if (Object.keys(metadata).length || ownership || fields.length) output.push({ target: toVaultPath(vaultRoot, file), module, instanceId, metadata, ownership, fields });
  }
  return { candidates: output, blocked_fields: blocked };
}

export async function previewQualityBackfill(vaultRoot: string): Promise<JsonObject> {
  const scan = await candidates(vaultRoot);
  return { mode: "preview", active_files: scan.candidates.length, ownership_updates: scan.candidates.filter((entry) => entry.ownership).length, provenance_fields: scan.candidates.reduce((sum, entry) => sum + entry.fields.length, 0), blocked_fields: scan.blocked_fields, requires_confirmation: true, strategy: "active-critical-first; deterministic; no AI scan" };
}

export async function applyQualityBackfill(vaultRoot: string): Promise<JsonObject> {
  const scan = await candidates(vaultRoot); const runId = await allocateId(vaultRoot, "RUN"); const planId = await allocateId(vaultRoot, "PLAN"); const taskId = await allocateId(vaultRoot, "TASK");
  const snapshot = await createGitSnapshot(vaultRoot, runId); const quality = await QualityRepository.open(vaultRoot); const operations: Operation[] = []; const now = new Date().toISOString();
  try {
    for (const [index, candidate] of scan.candidates.entries()) {
      const patch: JsonObject = { ...candidate.metadata }; if (candidate.ownership) patch._ownership = { sections: candidate.ownership }; const fieldMeta: JsonObject = {};
      for (const field of candidate.fields) {
        const evidenceIds: string[] = [];
        for (const sourceRef of field.sourceRefs) {
          const existing = quality.listEvidence(5000).find((entry) => entry.source_ref === sourceRef && entry.supports.some((support) => support.entity_ref === candidate.target && support.field === field.field));
          evidenceIds.push((existing ?? quality.upsertEvidence({ source_type: "external-research", source_ref: sourceRef, supports: [{ entity_ref: candidate.target, field: field.field }], locator: {}, observed_at: field.checkedAt ?? now, captured_at: now, collector: { type: "provenance-backfill", run_id: runId }, quality: { authority: "unknown", freshness: "unknown", extraction_confidence: 1 }, status: "active" })).evidence_id);
        }
        fieldMeta[field.field] = { authorship: "external-research", evidence_refs: evidenceIds, generation: { run_id: runId, module: { id: candidate.module, version: "unknown" }, workflow: null, prompt: null, processor: { id: "quality-backfill", version: "1.0.0" }, adapter: null, model: null, generated_at: now }, review: { status: "unreviewed", review_id: null, reviewed_by: null, reviewed_at: null, decision: null }, verification: { last_verified: field.checkedAt, verification_interval_days: null, stale_after: null, stale: false, verification_status: field.checkedAt ? "verified" : "unknown" } };
      }
      if (Object.keys(fieldMeta).length) patch._field_meta = fieldMeta;
      operations.push({ operation_id: `OP-${String(index + 1).padStart(3, "0")}`, type: "update-frontmatter", target: candidate.target, risk: "yellow", confidence: 1, idempotency_key: `quality-backfill-v2:${candidate.target}:${qualityFingerprint([patch]).slice(0, 16)}`, payload: { patch, actor: "system", replace_top_level: candidate.ownership ? ["_ownership"] : [] }, requires_review_id: null });
    }
  } finally { quality.close(); }
  const plan: OperationPlan = { plan_id: planId, task_id: taskId, source_module: "core", instance_id: null, summary: "Backfill active Knowledge Quality metadata without AI scanning.", operations, review_items: [] };
  const planPath = path.join(vaultRoot, "90-System", "State", "Plans", `${planId}.json`); await writeJsonAtomic(planPath, plan);
  await executeOperationPlan(vaultRoot, plan, { allowedTypes: ["update-frontmatter"], allowedTargets: operations.map((entry) => entry.target!).filter(Boolean), gitSnapshot: snapshot });
  const completed = new Date().toISOString(); writeMarkdown(vaultRoot, path.join(vaultRoot, "90-System", "Logs", `${runId}.md`), { data: { run_id: runId, task_id: taskId, plan_id: planId, source_module: "core", instance_id: null, review_id: null, status: "completed", git_snapshot: snapshot, started_at: now, completed_at: completed, schema_version: 1 }, content: `# Quality metadata backfill\n\n- Updated files: ${operations.length}\n- Blocked fields: ${scan.blocked_fields.length}\n` });
  return { mode: "applied", run_id: runId, plan_id: planId, git_snapshot: snapshot, updated_files: operations.length, blocked_fields: scan.blocked_fields };
}
