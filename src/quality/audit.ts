import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMarkdown, parseYaml, validateSchema, writeMarkdown } from "../core/bridge.js";
import { discoverInstances, discoverModulesForVault } from "../core/discovery.js";
import { ensureDir, exists, listFilesRecursive, readJson, sha256File, toVaultPath, writeJsonAtomic } from "../core/files.js";
import type { JsonObject, JsonValue, ReviewItem } from "../core/types.js";
import { persistReviewItem } from "../core/reviews.js";
import { RuntimeRepository } from "../runtime/repository.js";
import type { QualityIssue, QualityPolicy, QualitySeverity } from "./domain.js";
import { evaluateFreshness, resolveVerificationInterval } from "./freshness.js";
import { qualityFingerprint } from "./fingerprint.js";
import { QualityRepository } from "./repository.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ACTIVE_ISSUE_STATUSES = ["open", "acknowledged", "scheduled", "suppressed"] as const;
const TERMINAL_TASKS = new Set(["completed", "failed", "cancelled"]);
export type AuditFrequency = "daily" | "weekly" | "monthly";
export type ExternalLinkFetcher = (url: string, init: RequestInit) => Promise<Response>;

interface ModuleQuality { id: string; schemaVersion: number; policy: QualityPolicy; root: string; promptRegistry: JsonObject | null; schemaIds: Map<string, string>; schemaVersions: Map<string, number>; }
interface CandidateIssue { issue_type: string; dimension: QualityIssue["dimension"]; severity: QualitySeverity; module: string; instance_id: string | null; target: JsonObject; evidence: JsonObject; recommended_action: JsonObject; detector: string; }

function object(value: unknown): JsonObject | null { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null; }
function fieldValue(data: JsonObject, field: string): JsonValue | undefined {
  if (field in data) return data[field]; const facts = object(data.facts); const fact = object(facts?.[field]); return fact?.value;
}
function fieldMeta(data: JsonObject, field: string): JsonObject | null {
  const explicit = object(object(data._field_meta)?.[field]); if (explicit) return explicit;
  const fact = object(object(data.facts)?.[field]);
  if (!fact) return null;
  return { evidence_refs: Array.isArray(fact.source_refs) ? fact.source_refs : [], verification: { last_verified: fact.checked_at ?? null } };
}
function normalizeContent(value: string): string { return value.toLowerCase().replace(/<!--.*?-->/gs, "").replace(/\s+/g, " ").trim(); }
function contentShingles(value: string): Set<string> { const compact = value.replace(/\s+/g, ""); const output = new Set<string>(); for (let index = 0; index <= compact.length - 5; index += 1) output.add(compact.slice(index, index + 5)); return output; }
function jaccard(left: Set<string>, right: Set<string>): number { let intersection = 0; for (const value of left) if (right.has(value)) intersection += 1; const union = left.size + right.size - intersection; return union ? intersection / union : 0; }
function priorityRank(value: QualitySeverity): number { return { critical: 0, high: 1, medium: 2, low: 3, info: 4 }[value]; }

async function policies(vaultRoot: string): Promise<Map<string, ModuleQuality>> {
  const output = new Map<string, ModuleQuality>();
  for (const module of await discoverModulesForVault(ENGINE_ROOT, vaultRoot)) {
    const descriptor = object(module.data.quality); const relative = typeof descriptor?.policy === "string" ? descriptor.policy : null;
    if (!relative) continue;
    const root = path.dirname(module.path); const policy = parseYaml(root, path.join(root, ...relative.split("/"))) as unknown as QualityPolicy;
    let promptRegistry: JsonObject | null = null; const schemaIds = new Map<string, string>(); const schemaVersions = new Map<string, number>();
    try { const prompts = object(module.data.prompts); promptRegistry = parseYaml(root, path.join(root, ...String(prompts?.registry).split("/"))); } catch { /* Reported through module validation. */ }
    try {
      const schemas = object(module.data.schemas); const registryPath = path.join(root, ...String(schemas?.registry).split("/")); const registry = parseYaml(root, registryPath); const entries = object(registry.schemas) ?? {};
      for (const descriptor of Object.values(entries)) { const item = object(descriptor); if (!item || typeof item.path !== "string" || typeof item.entity_type !== "string") continue; const schema = await readJson<JsonObject>(path.join(path.dirname(registryPath), ...item.path.split("/")), {}); if (typeof schema.$id === "string") schemaIds.set(item.entity_type, schema.$id); if (Number.isInteger(item.version)) schemaVersions.set(item.entity_type, Number(item.version)); }
    } catch { /* Module validation reports malformed registries. */ }
    output.set(String(module.data.id), { id: String(module.data.id), schemaVersion: Number(object(module.data.data)?.schema_version ?? 1), policy, root, promptRegistry, schemaIds, schemaVersions });
  }
  return output;
}

async function knowledgeFiles(vaultRoot: string): Promise<string[]> {
  const result: string[] = [];
  for (const root of ["20-Workspace", "30-Knowledge"]) result.push(...await listFilesRecursive(path.join(vaultRoot, root), ".md"));
  return result.filter((file) => !file.split(path.sep).some((part) => ["90-System", ".obsidian", "Templates"].includes(part)));
}

function issue(candidate: CandidateIssue, auditId: string, now: string): Omit<QualityIssue, "issue_id" | "first_seen" | "last_seen" | "occurrence_count"> {
  return {
    fingerprint: qualityFingerprint([candidate.issue_type, candidate.module, candidate.instance_id, candidate.target]), issue_type: candidate.issue_type,
    dimension: candidate.dimension, severity: candidate.severity, module: candidate.module, instance_id: candidate.instance_id,
    target: candidate.target, detected_at: now, detector: { id: candidate.detector, version: "1.0.0", run_id: auditId }, evidence: candidate.evidence,
    status: "open", recommended_action: candidate.recommended_action, last_notified: null, suppressed_until: null, resolution: null,
  };
}

async function auditDocuments(vaultRoot: string, frequency: AuditFrequency, modulePolicies: Map<string, ModuleQuality>, auditId: string, now: string, changedPaths: ReadonlySet<string>): Promise<CandidateIssue[]> {
  const files = await knowledgeFiles(vaultRoot); const candidates: CandidateIssue[] = [];
  const paths = new Set(files.map((file) => toVaultPath(vaultRoot, file).toLowerCase()));
  const basename = new Map<string, string[]>(); const incoming = new Map<string, number>(); const hashes = new Map<string, string[]>(); const anchors = new Map<string, Set<string>>(); const normalizedDocuments: Array<{ path: string; hash: string; shingles: Set<string> }> = [];
  for (const file of files) {
    const relative = toVaultPath(vaultRoot, file); const key = path.basename(file, ".md").toLowerCase(); basename.set(key, [...(basename.get(key) ?? []), relative]); incoming.set(relative.toLowerCase(), 0);
    const raw = await fs.readFile(file, "utf8"); anchors.set(relative.toLowerCase(), new Set([...raw.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((match) => match[1]!.replace(/\s+#+$/, "").trim().toLowerCase())));
  }
  for (const file of files) {
    const relative = toVaultPath(vaultRoot, file); let document;
    try { document = parseMarkdown(vaultRoot, file); } catch (error) {
      candidates.push({ issue_type: "invalid-frontmatter", dimension: "validity", severity: "high", module: "core", instance_id: null, target: { path: relative }, evidence: { error: error instanceof Error ? error.message : String(error) }, recommended_action: { type: "repair-frontmatter" }, detector: "schema-version-auditor" }); continue;
    }
    const inferredModule = document.data.research_type === "application-update" ? "application-tracker" : null;
    const moduleId = typeof document.data.source_module === "string" ? document.data.source_module : typeof document.data.module_id === "string" ? document.data.module_id : inferredModule ?? "unowned";
    const entityType = typeof document.data.type === "string" ? document.data.type : document.data.research_type === "application-update" ? "research-report" : "";
    const instanceId = typeof document.data.instance_id === "string" ? document.data.instance_id : null; const policy = modulePolicies.get(moduleId);
    if (policy?.schemaIds.has(entityType) && (frequency !== "daily" || changedPaths.has(relative))) {
      try { validateSchema(vaultRoot, policy.schemaIds.get(entityType)!, document.data); }
      catch (error) { candidates.push({ issue_type: "invalid-entity-schema", dimension: "validity", severity: "high", module: moduleId, instance_id: instanceId, target: { path: relative, entity_type: entityType }, evidence: { schema_id: policy.schemaIds.get(entityType)!, error: error instanceof Error ? error.message : String(error) }, recommended_action: { type: "repair-schema-invalid-entity" }, detector: "entity-schema-auditor" }); }
    }
    for (const match of document.content.matchAll(/\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|[^\]]+)?\]\]/g)) {
      const targetText = match[1]!.trim(); const anchor = match[2]?.trim(); const exact = targetText.toLowerCase().endsWith(".md") ? targetText.toLowerCase() : `${targetText.toLowerCase()}.md`;
      const resolved = paths.has(exact) ? exact : basename.get(path.basename(targetText, ".md").toLowerCase())?.[0]?.toLowerCase();
      if (resolved) { incoming.set(resolved, (incoming.get(resolved) ?? 0) + 1); if (anchor && !anchors.get(resolved)?.has(anchor.toLowerCase())) candidates.push({ issue_type: "broken-internal-anchor", dimension: "connectivity", severity: "medium", module: moduleId, instance_id: instanceId, target: { path: relative, link: targetText, anchor }, evidence: { link: targetText, anchor }, recommended_action: { type: "repair-anchor" }, detector: "broken-link-auditor" }); }
      else candidates.push({ issue_type: "broken-internal-link", dimension: "connectivity", severity: "medium", module: moduleId, instance_id: instanceId, target: { path: relative, link: targetText }, evidence: { link: targetText }, recommended_action: { type: "repair-link" }, detector: "broken-link-auditor" });
    }
    if (frequency !== "daily") {
      const normalized = normalizeContent(document.content); if (normalized.length > 40) { const hash = createHash("sha256").update(normalized).digest("hex"); hashes.set(hash, [...(hashes.get(hash) ?? []), relative]); if (frequency === "monthly" && normalized.length >= 80 && normalizedDocuments.length < 250) normalizedDocuments.push({ path: relative, hash, shingles: contentShingles(normalized) }); }
    }
    if (!policy) {
      if (moduleId === "unowned") candidates.push({ issue_type: "unowned-file", dimension: "connectivity", severity: "high", module: "core", instance_id: null, target: { path: relative }, evidence: { source_module: null }, recommended_action: { type: "assign-owner" }, detector: "ownership-auditor" });
      continue;
    }
    const requiredSchemaVersion = policy.schemaVersions.get(entityType) ?? policy.schemaVersion;
    if (Number(document.data.schema_version ?? 0) < requiredSchemaVersion) candidates.push({ issue_type: "outdated-schema", dimension: "validity", severity: "medium", module: moduleId, instance_id: instanceId, target: { path: relative }, evidence: { current: document.data.schema_version ?? null, required: requiredSchemaVersion, entity_type: entityType || null }, recommended_action: { type: "plan-migration" }, detector: "schema-version-auditor" });
    for (const field of policy.policy.provenance_required ?? []) {
      const value = fieldValue(document.data, field); if (value === undefined || value === null) continue;
      const meta = fieldMeta(document.data, field); const refs = meta?.evidence_refs;
      if (!Array.isArray(refs) || refs.length === 0) candidates.push({ issue_type: "missing-provenance", dimension: "provenance", severity: (policy.policy.critical_fields ?? []).includes(field) ? "high" : "medium", module: moduleId, instance_id: instanceId, target: { path: relative, entity_ref: relative, field }, evidence: { value_present: true }, recommended_action: { type: "attach-evidence" }, detector: "missing-provenance-auditor" });
    }
    for (const [field, raw] of Object.entries(object(policy.policy.freshness) ?? {})) {
      const value = fieldValue(document.data, field); if (value === undefined || value === null) continue;
      const meta = fieldMeta(document.data, field); const verification = object(meta?.verification); const configured = object(raw);
      const interval = resolveVerificationInterval({ field: Number(configured?.interval_days) || null, module: Number(policy.policy.default_verification_interval_days) || null });
      const freshness = evaluateFreshness({ lastVerified: typeof verification?.last_verified === "string" ? verification.last_verified : typeof meta?.checked_at === "string" ? meta.checked_at : null, intervalDays: interval, now: new Date(now) });
      if (["stale", "due-soon"].includes(freshness.verification_status)) candidates.push({ issue_type: freshness.stale ? "stale-critical-field" : "due-soon-field", dimension: "freshness", severity: freshness.stale ? "high" : "medium", module: moduleId, instance_id: instanceId, target: { path: relative, entity_ref: relative, field }, evidence: freshness, recommended_action: { type: moduleId === "application-tracker" ? "create-research-request" : "verify-field" }, detector: "stale-field-auditor" });
    }
    const ownershipRules = object(policy.policy.ownership); const ownershipPolicy = object(ownershipRules?.[entityType]); const ownershipRequired = ownershipPolicy?.required === true; const actualOwnership = object(object(document.data._ownership)?.sections); const expectedOwnership = object(ownershipPolicy?.sections);
    if (ownershipRequired && !actualOwnership) candidates.push({ issue_type: "missing-content-ownership", dimension: "reviewability", severity: "medium", module: moduleId, instance_id: instanceId, target: { path: relative }, evidence: { entity_type: entityType }, recommended_action: { type: "backfill-ownership" }, detector: "ownership-auditor" });
    else if (ownershipRequired && expectedOwnership && qualityFingerprint([actualOwnership]) !== qualityFingerprint([expectedOwnership])) candidates.push({ issue_type: "invalid-content-ownership", dimension: "reviewability", severity: "medium", module: moduleId, instance_id: instanceId, target: { path: relative }, evidence: { entity_type: entityType, expected_sections: expectedOwnership, actual_sections: actualOwnership }, recommended_action: { type: "repair-ownership" }, detector: "ownership-auditor" });
  }
  if (frequency !== "daily") for (const file of files) {
    const relative = toVaultPath(vaultRoot, file); if ((incoming.get(relative.toLowerCase()) ?? 0) > 0 || /(?:^|\/)(Inbox|Archive|Attachments)(?:\/|$)/i.test(relative) || /(?:index|dashboard|today)\.md$/i.test(relative)) continue;
    let data: JsonObject = {}; try { data = parseMarkdown(vaultRoot, file).data; } catch { continue; }
    const moduleId = typeof data.source_module === "string" ? data.source_module : typeof data.module_id === "string" ? data.module_id : "core";
    candidates.push({ issue_type: "orphan-file", dimension: "connectivity", severity: "medium", module: moduleId, instance_id: typeof data.instance_id === "string" ? data.instance_id : null, target: { path: relative }, evidence: { incoming_links: 0 }, recommended_action: { type: "review-connectivity" }, detector: "orphan-file-auditor" });
  }
  if (frequency === "monthly") {
    for (const [hash, duplicates] of hashes) if (duplicates.length > 1) candidates.push({ issue_type: "exact-duplicate-content", dimension: "consistency", severity: "medium", module: "core", instance_id: null, target: { paths: duplicates }, evidence: { normalized_hash: hash, count: duplicates.length }, recommended_action: { type: "review-duplicate-candidates" }, detector: "duplicate-content-auditor" });
    for (let left = 0; left < normalizedDocuments.length; left += 1) for (let right = left + 1; right < normalizedDocuments.length; right += 1) {
      const first = normalizedDocuments[left]!; const second = normalizedDocuments[right]!; if (first.hash === second.hash) continue; const similarity = jaccard(first.shingles, second.shingles);
      if (similarity >= 0.9) candidates.push({ issue_type: "near-duplicate-content", dimension: "consistency", severity: "low", module: "core", instance_id: null, target: { paths: [first.path, second.path] }, evidence: { similarity, algorithm: "five-character-shingle-jaccard" }, recommended_action: { type: "review-duplicate-candidates" }, detector: "duplicate-content-auditor" });
    }
  }
  return candidates;
}

async function auditReviewDebt(vaultRoot: string, now: string): Promise<CandidateIssue[]> {
  const output: CandidateIssue[] = [];
  for (const directory of ["Pending", "Deferred", "Error"]) {
    const root = path.join(vaultRoot, "90-System", "Review Queue", directory); if (!(await exists(root))) continue;
    for (const file of await listFilesRecursive(root, ".md")) {
      const document = parseMarkdown(vaultRoot, file); const item = document.data as unknown as ReviewItem;
      const sla = item.sla_due_at ?? new Date(Date.parse(item.created) + (item.priority === "critical" ? 1 : item.priority === "high" ? 3 : item.priority === "medium" ? 14 : 30) * 86_400_000).toISOString();
      if (Date.parse(sla) > Date.parse(now)) continue;
      if (!item.overdue) await persistReviewItem(vaultRoot, { filePath: file, document, item }, { ...item, sla_due_at: sla, overdue: true });
      output.push({ issue_type: "overdue-review", dimension: "reviewability", severity: item.priority === "critical" ? "high" : "medium", module: item.source_module, instance_id: item.instance_id, target: { review_id: item.review_id, path: toVaultPath(vaultRoot, file) }, evidence: { created: item.created, sla_due_at: sla, decision_count: item.decision_history.length }, recommended_action: { type: "review-debt-cleanup" }, detector: "review-debt-auditor" });
    }
  }
  return output;
}

async function auditInstanceTasks(vaultRoot: string): Promise<CandidateIssue[]> {
  const output: CandidateIssue[] = []; const instances = new Map((await discoverInstances(vaultRoot)).map((entry) => [String(entry.data.instance_id), entry.data]));
  const runtime = await RuntimeRepository.open(vaultRoot);
  try {
    for (const task of runtime.listTasks()) {
      if (!task.instance_id || TERMINAL_TASKS.has(task.status)) continue; const instance = instances.get(task.instance_id); if (!instance || instance.status === "active") continue;
      try { runtime.cancelTask(task.task_id); } catch { /* Running tasks use cooperative cancellation. */ }
      output.push({ issue_type: "inactive-instance-active-task", dimension: "validity", severity: "high", module: task.module, instance_id: task.instance_id, target: { task_id: task.task_id, instance_id: task.instance_id }, evidence: { instance_status: String(instance.status ?? "missing"), task_status: task.status }, recommended_action: { type: "inspect-cancelled-task" }, detector: "instance-task-auditor" });
    }
  } finally { runtime.close(); }
  return output;
}

async function promptQualityIssues(modulePolicies: Map<string, ModuleQuality>, metrics: JsonObject): Promise<CandidateIssue[]> {
  const output: CandidateIssue[] = [];
  for (const group of (metrics.groups as JsonObject[] | undefined) ?? []) {
    const moduleId = String(group.module); const promptId = typeof group.prompt_id === "string" ? group.prompt_id : null; if (!promptId) continue;
    const prompts = object(modulePolicies.get(moduleId)?.promptRegistry?.prompts); const contract = object(object(prompts?.[promptId])?.quality); if (!contract) continue;
    const events = object(group.events) ?? {}; const calls = Number(events["codex.completed"] ?? 0) + Number(events["codex.schema-failed"] ?? 0); if (calls < 5) continue;
    const schemaRate = Number(events["codex.schema-failed"] ?? 0) / calls; const reviewRate = Number(events["review.created"] ?? 0) / calls; const decisions = Number(events["review.approve"] ?? 0) + Number(events["review.approve-with-modification"] ?? 0) + Number(events["review.reject"] ?? 0); const rejectionRate = decisions ? Number(events["review.reject"] ?? 0) / decisions : 0;
    if (schemaRate > Number(contract.max_schema_failure_rate ?? 1) || reviewRate > Number(contract.max_review_rate ?? 1) || rejectionRate > Number(contract.max_rejection_rate ?? 1)) output.push({ issue_type: "prompt-quality-regression", dimension: "validity", severity: "high", module: moduleId, instance_id: null, target: { prompt_id: promptId, prompt_version: group.prompt_version ?? "unknown" }, evidence: { sample_size: calls, schema_failure_rate: schemaRate, review_rate: reviewRate, rejection_rate: rejectionRate, thresholds: contract }, recommended_action: { type: "run-prompt-regression-and-consider-rollback" }, detector: "prompt-quality-auditor" });
  }
  return output;
}

function evidenceQualityIssues(records: ReturnType<QualityRepository["listEvidence"]>): CandidateIssue[] {
  const output: CandidateIssue[] = [];
  for (const evidence of records) {
    if (!["conflicting", "unavailable"].includes(evidence.status)) continue;
    for (const support of evidence.supports) output.push({
      issue_type: evidence.status === "conflicting" ? "conflicting-evidence" : "unavailable-evidence",
      dimension: evidence.status === "conflicting" ? "consistency" : "provenance",
      severity: evidence.status === "conflicting" ? "high" : "medium", module: "core", instance_id: null,
      target: { evidence_id: evidence.evidence_id, entity_ref: String(support.entity_ref ?? "unknown"), field: support.field ?? null },
      evidence: { source_ref: evidence.source_ref, authority: evidence.quality.authority ?? "unknown", status: evidence.status },
      recommended_action: { type: evidence.status === "conflicting" ? "resolve-source-conflict" : "replace-unavailable-evidence" }, detector: "evidence-status-auditor",
    });
  }
  return output;
}

function reportMarkdown(frequency: AuditFrequency, auditId: string, summary: JsonObject, issues: QualityIssue[]): string {
  const lines = [`# Knowledge Quality ${frequency} audit`, "", `- Audit: ${auditId}`, `- Generated: ${String(summary.generated_at)}`, `- New or recurring issues: ${issues.length}`, "", "## By severity", ""];
  for (const severity of ["critical", "high", "medium", "low", "info"]) lines.push(`- ${severity}: ${issues.filter((item) => item.severity === severity).length}`);
  lines.push("", "## Actionable findings", "");
  for (const item of issues.filter((value) => ["critical", "high"].includes(value.severity)).slice(0, 50)) lines.push(`- ${item.issue_id} · ${item.issue_type} · ${String(item.target.path ?? item.target.entity_ref ?? item.target.review_id ?? item.target.task_id ?? "target")}`);
  return `${lines.join("\n")}\n`;
}

async function updateObservation(vaultRoot: string, now: string, summary: JsonObject): Promise<JsonObject> {
  const file = path.join(vaultRoot, "90-System", "State", "quality-observation.json");
  const current = await readJson<JsonObject>(file, { schema_version: 1, started_at: now, minimum_days: 14, target_days: 28, snapshots: [] });
  const snapshots = Array.isArray(current.snapshots) ? current.snapshots : []; snapshots.push({ observed_at: now, audit_id: summary.audit_id ?? null, frequency: summary.frequency ?? null, detected: summary.detected ?? 0, resolved: summary.resolved ?? 0, by_severity: summary.by_severity ?? {} });
  const elapsedDays = Math.max(0, (Date.parse(now) - Date.parse(String(current.started_at))) / 86_400_000);
  const next = { ...current, updated_at: now, elapsed_days: Math.floor(elapsedDays), status: elapsedDays >= Number(current.minimum_days ?? 14) ? "ready-for-evaluation" : "observing", snapshots: snapshots.slice(-100), evaluation_criteria: ["review-debt-not-growing", "missing-critical-provenance-not-growing", "stale-fields-actionable", "prompt-anomalies-detected", "alert-volume-acceptable"] };
  await writeJsonAtomic(file, next); return next;
}

export async function runQualityAudit(vaultRoot: string, frequency: AuditFrequency, options: { now?: string } = {}): Promise<JsonObject> {
  const now = options.now ?? new Date().toISOString(); const repository = await QualityRepository.open(vaultRoot); const audit = repository.startAudit(frequency); const auditId = String(audit.audit_id);
  try {
    const files = await knowledgeFiles(vaultRoot); const currentHashes = Object.fromEntries(await Promise.all(files.map(async (file) => [toVaultPath(vaultRoot, file), await sha256File(file)])));
    const previous = await readJson<JsonObject>(path.join(vaultRoot, "90-System", "State", "quality-audit-checkpoint.json"), {}); const previousHashes = object(previous.file_hashes) ?? {};
    const fullSchemaScan = frequency !== "daily" || previous.schema_version !== 2; const changedPaths = new Set(Object.entries(currentHashes).filter(([relative, hash]) => fullSchemaScan || previousHashes[relative] !== hash).map(([relative]) => relative));
    const modulePolicies = await policies(vaultRoot); const candidates = [...await auditDocuments(vaultRoot, frequency, modulePolicies, auditId, now, changedPaths), ...await auditReviewDebt(vaultRoot, now), ...await auditInstanceTasks(vaultRoot), ...evidenceQualityIssues(repository.listEvidence(5000))];
    if (frequency !== "daily") candidates.push(...await promptQualityIssues(modulePolicies, repository.aggregateMetrics(new Date(Date.parse(now) - 7 * 86_400_000).toISOString())));
    const seen = new Set<string>(); const issues: QualityIssue[] = [];
    for (const candidate of candidates) { const stored = repository.upsertIssue(issue(candidate, auditId, now)); seen.add(stored.fingerprint); issues.push(stored); repository.recordMetric({ idempotency_key: `quality:${auditId}:${stored.fingerprint}`, event_type: "quality.issue-detected", module: stored.module, instance_id: stored.instance_id, workflow_id: null, workflow_version: null, prompt_id: null, prompt_version: null, run_id: auditId, occurred_at: now, dimensions: { issue_type: stored.issue_type, severity: stored.severity, dimension: stored.dimension }, values: {} }); }
    const followups = await RuntimeRepository.open(vaultRoot);
    try {
      for (const stored of issues.filter((item) => item.recommended_action.type === "create-research-request")) followups.createTask({
        job_id: "quality.stale-field-followup", module: stored.module, instance_id: stored.instance_id, task_type: "workflow", workflow: "application:sync-due-research", priority: "high", scheduled_for: now, available_after: now,
        resources: { filesystem: "required", network: "not-required", codex: "not-required", user: "required" }, trigger: { type: "quality-issue", issue_id: stored.issue_id }, catch_up_policy: "latest",
        idempotency_key: `quality:${stored.fingerprint}:research-request`, max_attempts: 1, payload: { quality_issue_id: stored.issue_id, target: stored.target }, concurrency_key: `quality:${stored.instance_id ?? "global"}:research`, concurrency_policy: "merge",
      });
    } finally { followups.close(); }
    let resolved = 0;
    const executedDetectors = new Set(["broken-link-auditor", "schema-version-auditor", "missing-provenance-auditor", "stale-field-auditor", "ownership-auditor", "review-debt-auditor", "instance-task-auditor", "evidence-status-auditor"]);
    if (fullSchemaScan) executedDetectors.add("entity-schema-auditor");
    if (frequency !== "daily") { executedDetectors.add("orphan-file-auditor"); executedDetectors.add("prompt-quality-auditor"); }
    if (frequency === "monthly") executedDetectors.add("duplicate-content-auditor");
    for (const existing of repository.listIssues({ statuses: [...ACTIVE_ISSUE_STATUSES] })) {
      const detector = String(existing.detector.id ?? ""); if (!executedDetectors.has(detector) || seen.has(existing.fingerprint)) continue;
      repository.updateIssue(existing.issue_id, "resolved", { resolution: { type: "not-detected", audit_id: auditId, resolved_at: now } }); resolved += 1;
    }
    issues.sort((a, b) => priorityRank(a.severity) - priorityRank(b.severity));
    const summary: JsonObject = { audit_id: auditId, frequency, generated_at: now, detected: issues.length, resolved, by_severity: Object.fromEntries(["critical", "high", "medium", "low", "info"].map((severity) => [severity, issues.filter((item) => item.severity === severity).length])) as JsonObject };
    if (frequency !== "daily") { const report = path.join(vaultRoot, "90-System", "Logs", "Quality", `${now.slice(0, 10)}-${frequency}-${auditId}.md`); await ensureDir(path.dirname(report)); await fs.writeFile(report, reportMarkdown(frequency, auditId, summary, issues), "utf8"); summary.report_path = toVaultPath(vaultRoot, report); }
    summary.observation = await updateObservation(vaultRoot, now, summary);
    repository.finishAudit(auditId, "completed", summary); await writeJsonAtomic(path.join(vaultRoot, "90-System", "State", "quality-audit-checkpoint.json"), { schema_version: 2, last_audit_id: auditId, frequency, completed_at: now, schema_validated_paths: changedPaths.size, file_hashes: currentHashes });
    return summary;
  } catch (error) { repository.finishAudit(auditId, "failed", { error: error instanceof Error ? error.message : String(error) }); throw error; }
  finally { repository.close(); }
}

export async function runExternalLinkAudit(vaultRoot: string, options: { now?: string; fetcher?: ExternalLinkFetcher; timeoutMs?: number } = {}): Promise<JsonObject> {
  const now = options.now ?? new Date().toISOString(); const fetcher = options.fetcher ?? fetch; const timeoutMs = options.timeoutMs ?? 8_000;
  const repository = await QualityRepository.open(vaultRoot); const audit = repository.startAudit("external-links"); const auditId = String(audit.audit_id); const candidates: CandidateIssue[] = [];
  try {
    const links = new Map<string, { module: string; instanceId: string | null; paths: Set<string> }>();
    for (const file of await knowledgeFiles(vaultRoot)) {
      const relative = toVaultPath(vaultRoot, file); let document; try { document = parseMarkdown(vaultRoot, file); } catch { continue; }
      const moduleId = typeof document.data.source_module === "string" ? document.data.source_module : typeof document.data.module_id === "string" ? document.data.module_id : "core";
      for (const match of document.content.matchAll(/https?:\/\/[^\s<>\])}"']+/g)) {
        const url = match[0]!.replace(/[.,;:!?]+$/, ""); const existing = links.get(url) ?? { module: moduleId, instanceId: typeof document.data.instance_id === "string" ? document.data.instance_id : null, paths: new Set<string>() }; existing.paths.add(relative); links.set(url, existing);
      }
    }
    for (const [url, source] of [...links.entries()].slice(0, 200)) {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); let status: number | null = null; let error: string | null = null;
      try { let response = await fetcher(url, { method: "HEAD", redirect: "follow", signal: controller.signal }); if (response.status === 405) response = await fetcher(url, { method: "GET", redirect: "follow", signal: controller.signal }); status = response.status; }
      catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
      finally { clearTimeout(timer); }
      if ((status !== null && status < 400) || (status === null && error === null)) continue;
      candidates.push({ issue_type: status === null ? "external-link-unreachable" : "broken-external-link", dimension: "connectivity", severity: "medium", module: source.module, instance_id: source.instanceId, target: { url, paths: [...source.paths] }, evidence: { http_status: status, error }, recommended_action: { type: "review-external-link" }, detector: "external-link-auditor" });
    }
    const seen = new Set<string>(); const issues: QualityIssue[] = [];
    for (const candidate of candidates) { const stored = repository.upsertIssue(issue(candidate, auditId, now)); seen.add(stored.fingerprint); issues.push(stored); }
    let resolved = 0; for (const existing of repository.listIssues({ statuses: [...ACTIVE_ISSUE_STATUSES] })) if (existing.detector.id === "external-link-auditor" && !seen.has(existing.fingerprint)) { repository.updateIssue(existing.issue_id, "resolved", { resolution: { type: "link-available", audit_id: auditId, resolved_at: now } }); resolved += 1; }
    const summary: JsonObject = { audit_id: auditId, frequency: "external-links", checked: links.size, detected: issues.length, resolved, generated_at: now }; repository.finishAudit(auditId, "completed", summary); return summary;
  } catch (error) { repository.finishAudit(auditId, "failed", { error: error instanceof Error ? error.message : String(error) }); throw error; }
  finally { repository.close(); }
}
