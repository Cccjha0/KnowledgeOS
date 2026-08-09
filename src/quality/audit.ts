import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMarkdown, parseYaml, validateSchema, writeMarkdown } from "../core/bridge.js";
import { discoverInstances, discoverModulesForVault, type DiscoveredDocument } from "../core/discovery.js";
import { ensureDir, exists, listFilesRecursive, readJson, sha256File, toVaultPath, writeJsonAtomic } from "../core/files.js";
import type { JsonObject, JsonValue, ReviewItem } from "../core/types.js";
import { persistReviewItem } from "../core/reviews.js";
import { RuntimeRepository } from "../runtime/repository.js";
import type { ResourceRequirement, TaskResources } from "../runtime/domain.js";
import type { QualityIssue, QualityPolicy, QualitySeverity } from "./domain.js";
import { evaluateFreshness, resolveVerificationInterval } from "./freshness.js";
import { qualityFingerprint } from "./fingerprint.js";
import { QualityRepository } from "./repository.js";
import { resolveWorkflowResourceContract } from "../modules/workflowResources.js";
import { resolveFieldQualityPolicies } from "./policy.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ACTIVE_ISSUE_STATUSES = ["open", "acknowledged", "scheduled", "suppressed"] as const;
const TERMINAL_TASKS = new Set(["completed", "failed", "cancelled"]);
export type AuditFrequency = "daily" | "weekly" | "monthly";
export type ExternalLinkFetcher = (url: string, init: RequestInit) => Promise<Response>;

interface ModuleQuality { id: string; module: DiscoveredDocument; schemaVersion: number; policy: QualityPolicy; root: string; promptRegistry: JsonObject | null; schemaIds: Map<string, string>; schemaVersions: Map<string, number>; }
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
function localDayKey(value: string, timezone: string): string {
  const date = new Date(value); if (!Number.isFinite(date.getTime())) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch { return date.toISOString().slice(0, 10); }
}
function weekKey(value: string, timezone: string): string { const localDay = localDayKey(value, timezone); if (!localDay) return ""; const date = new Date(`${localDay}T00:00:00Z`); const mondayOffset = (date.getUTCDay() + 6) % 7; date.setUTCDate(date.getUTCDate() - mondayOffset); return date.toISOString().slice(0, 10); }
function compactObservationSnapshots(snapshots: JsonObject[], timezone: string): JsonObject[] {
  const retained: JsonObject[] = []; const seen = new Set<string>();
  for (const snapshot of [...snapshots].reverse()) {
    const day = localDayKey(String(snapshot.observed_at ?? ""), timezone); const frequency = String(snapshot.frequency ?? "unknown");
    const key = object(snapshot.metrics) && day ? `${frequency}:${day}` : null;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    retained.push(snapshot);
  }
  return retained.reverse().slice(-100);
}
function priorityRank(value: QualitySeverity): number { return { critical: 0, high: 1, medium: 2, low: 3, info: 4 }[value]; }

function documentEntityType(data: JsonObject): string {
  return typeof data.type === "string" ? data.type : data.research_type === "application-update" ? "research-report" : "";
}

/** A policy-owned Workflow action. Core only schedules this declared contract. */
function staleFollowupAction(config: JsonObject): JsonObject | null {
  const action = object(config.stale_action);
  return action?.type === "workflow" && typeof action.workflow_id === "string" && action.workflow_id.trim() ? action : null;
}

/** Additional gates may only make a Workflow more restrictive, never less. */
function followupResources(module: DiscoveredDocument, action: JsonObject): TaskResources {
  const workflowId = String(action.workflow_id);
  const base = resolveWorkflowResourceContract(module, workflowId).resources;
  const gates = object(action.additional_gates) ?? {};
  const merge = (name: keyof TaskResources): ResourceRequirement => gates[name] === "required" || base[name] === "required" ? "required" : "not-required";
  return { filesystem: merge("filesystem"), network: merge("network"), codex: merge("codex"), user: merge("user") };
}

function followupDedupe(action: JsonObject): JsonObject | null {
  const dedupe = object(action.dedupe);
  return typeof dedupe?.entity_type === "string" && typeof dedupe?.target_field === "string" ? dedupe : null;
}

async function openFollowupTargets(vaultRoot: string, action: JsonObject): Promise<Set<string>> {
  const dedupe = followupDedupe(action); const targets = new Set<string>();
  if (!dedupe) return targets;
  const statuses = Array.isArray(dedupe.open_statuses) ? new Set(dedupe.open_statuses.filter((value): value is string => typeof value === "string")) : null;
  for (const file of await knowledgeFiles(vaultRoot)) {
    let data: JsonObject; try { data = parseMarkdown(vaultRoot, file).data; } catch { continue; }
    if (data.type !== dedupe.entity_type || (statuses && !statuses.has(String(data.status)))) continue;
    const target = data[String(dedupe.target_field)];
    if (typeof target === "string") targets.add(target.replaceAll("\\", "/").toLowerCase());
  }
  return targets;
}

function moduleForDocument(data: JsonObject, type: string, modulePolicies: Map<string, ModuleQuality>): string {
  if (typeof data.source_module === "string") return data.source_module;
  if (typeof data.module_id === "string") return data.module_id;
  const schemaOwners = [...modulePolicies.values()].filter((policy) => policy.schemaIds.has(type));
  if (schemaOwners.length === 1) return schemaOwners[0]!.id;
  if (data.research_type === "application-update") return "application-tracker";
  return "unowned";
}

interface WikiLink { targetText: string; anchor: string | null }
function collectWikiLinks(value: unknown, output = new Map<string, WikiLink>()): Map<string, WikiLink> {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|[^\]]+)?\]\]/g)) {
      const targetText = match[1]!.trim(); const anchor = match[2]?.trim() ?? null;
      output.set(`${targetText.toLowerCase()}#${anchor?.toLowerCase() ?? ""}`, { targetText, anchor });
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectWikiLinks(item, output);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectWikiLinks(item, output);
  }
  return output;
}

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
    output.set(String(module.data.id), { id: String(module.data.id), module, schemaVersion: Number(object(module.data.data)?.schema_version ?? 1), policy, root, promptRegistry, schemaIds, schemaVersions });
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
    const entityType = documentEntityType(document.data);
    const moduleId = moduleForDocument(document.data, entityType, modulePolicies);
    const instanceId = typeof document.data.instance_id === "string" ? document.data.instance_id : null; const policy = modulePolicies.get(moduleId);
    if (policy?.schemaIds.has(entityType) && (frequency !== "daily" || changedPaths.has(relative))) {
      try { validateSchema(vaultRoot, policy.schemaIds.get(entityType)!, document.data); }
      catch (error) { candidates.push({ issue_type: "invalid-entity-schema", dimension: "validity", severity: "high", module: moduleId, instance_id: instanceId, target: { path: relative, entity_type: entityType }, evidence: { schema_id: policy.schemaIds.get(entityType)!, error: error instanceof Error ? error.message : String(error) }, recommended_action: { type: "repair-schema-invalid-entity" }, detector: "entity-schema-auditor" }); }
    }
    for (const { targetText, anchor } of collectWikiLinks([document.content, document.data]).values()) {
      const exact = targetText.toLowerCase().endsWith(".md") ? targetText.toLowerCase() : `${targetText.toLowerCase()}.md`;
      const resolved = paths.has(exact) ? exact : basename.get(path.basename(targetText, ".md").toLowerCase())?.[0]?.toLowerCase();
      if (resolved) { incoming.set(resolved, (incoming.get(resolved) ?? 0) + 1); if (anchor && !anchors.get(resolved)?.has(anchor.toLowerCase())) candidates.push({ issue_type: "broken-internal-anchor", dimension: "connectivity", severity: "medium", module: moduleId, instance_id: instanceId, target: { path: relative, link: targetText, anchor }, evidence: { link: targetText, anchor }, recommended_action: { type: "repair-anchor" }, detector: "broken-link-auditor" }); }
      else candidates.push({ issue_type: "broken-internal-link", dimension: "connectivity", severity: "medium", module: moduleId, instance_id: instanceId, target: { path: relative, link: targetText }, evidence: { link: targetText }, recommended_action: { type: "repair-link" }, detector: "broken-link-auditor" });
    }
    if (frequency !== "daily") {
      const normalized = normalizeContent(document.content); if (normalized.length > 40) { const hash = createHash("sha256").update(normalized).digest("hex"); hashes.set(hash, [...(hashes.get(hash) ?? []), relative]); if (frequency === "monthly" && normalized.length >= 80 && normalizedDocuments.length < 250) normalizedDocuments.push({ path: relative, hash, shingles: contentShingles(normalized) }); }
    }
    // Companion Notes are Core-owned, user-visible attachment records. They
    // deliberately do not belong to a business module and must not become
    // noisy "unowned" findings merely because an asset was ingested.
    if (entityType === "attachment-note") continue;
    if (!policy) {
      if (moduleId === "unowned") candidates.push({ issue_type: "unowned-file", dimension: "connectivity", severity: "high", module: "core", instance_id: null, target: { path: relative }, evidence: { source_module: null }, recommended_action: { type: "assign-owner" }, detector: "ownership-auditor" });
      continue;
    }
    const requiredSchemaVersion = policy.schemaVersions.get(entityType) ?? policy.schemaVersion;
    if (Number(document.data.schema_version ?? 0) < requiredSchemaVersion) candidates.push({ issue_type: "outdated-schema", dimension: "validity", severity: "medium", module: moduleId, instance_id: instanceId, target: { path: relative }, evidence: { current: document.data.schema_version ?? null, required: requiredSchemaVersion, entity_type: entityType || null }, recommended_action: { type: "plan-migration" }, detector: "schema-version-auditor" });
    const entityId = entityType.startsWith(`${moduleId}-`) ? entityType.slice(moduleId.length + 1) : entityType;
    const declaredRules = resolveFieldQualityPolicies(policy.policy, entityId);
    for (const [field, contract] of declaredRules) {
      if (!contract.provenanceRequired) continue;
      const value = fieldValue(document.data, field); if (value === undefined || value === null) continue;
      const meta = fieldMeta(document.data, field); const refs = meta?.evidence_refs;
      if (!Array.isArray(refs) || refs.length === 0) candidates.push({ issue_type: "missing-provenance", dimension: "provenance", severity: contract.critical ? "high" : "medium", module: moduleId, instance_id: instanceId, target: { path: relative, entity_ref: relative, field }, evidence: { value_present: true }, recommended_action: { type: "attach-evidence" }, detector: "missing-provenance-auditor" });
    }
    for (const [field, contract] of declaredRules) {
      if (contract.verificationIntervalDays === null) continue;
      const value = fieldValue(document.data, field); if (value === undefined || value === null) continue;
      const meta = fieldMeta(document.data, field); const verification = object(meta?.verification);
      const interval = resolveVerificationInterval({ field: contract.verificationIntervalDays, module: Number(policy.policy.default_verification_interval_days) || null });
      const freshness = evaluateFreshness({ lastVerified: typeof verification?.last_verified === "string" ? verification.last_verified : typeof meta?.checked_at === "string" ? meta.checked_at : null, intervalDays: interval, now: new Date(now) });
      if (["stale", "due-soon"].includes(freshness.verification_status)) {
        const action = freshness.stale && contract.staleAction ? staleFollowupAction({ stale_action: contract.staleAction }) : null;
        candidates.push({ issue_type: freshness.stale ? "stale-critical-field" : "due-soon-field", dimension: "freshness", severity: freshness.stale ? "high" : "medium", module: moduleId, instance_id: instanceId, target: { path: relative, entity_ref: relative, field }, evidence: freshness, recommended_action: action ?? { type: "verify-field" }, detector: "stale-field-auditor" });
      }
    }
    const ownershipRules = object(policy.policy.ownership); const ownershipPolicy = object(ownershipRules?.[entityType]); const ownershipRequired = ownershipPolicy?.required === true; const actualOwnership = object(object(document.data._ownership)?.sections); const expectedOwnership = object(ownershipPolicy?.sections);
    if (ownershipRequired && !actualOwnership) candidates.push({ issue_type: "missing-content-ownership", dimension: "reviewability", severity: "medium", module: moduleId, instance_id: instanceId, target: { path: relative }, evidence: { entity_type: entityType }, recommended_action: { type: "backfill-ownership" }, detector: "ownership-auditor" });
    else if (ownershipRequired && expectedOwnership && qualityFingerprint([actualOwnership]) !== qualityFingerprint([expectedOwnership])) candidates.push({ issue_type: "invalid-content-ownership", dimension: "reviewability", severity: "medium", module: moduleId, instance_id: instanceId, target: { path: relative }, evidence: { entity_type: entityType, expected_sections: expectedOwnership, actual_sections: actualOwnership }, recommended_action: { type: "repair-ownership" }, detector: "ownership-auditor" });
  }
  if (frequency !== "daily") for (const file of files) {
    const relative = toVaultPath(vaultRoot, file); if ((incoming.get(relative.toLowerCase()) ?? 0) > 0 || /(?:^|\/)(Inbox|Archive|Attachments)(?:\/|$)/i.test(relative) || /(?:index|dashboard|today)\.md$/i.test(relative)) continue;
    let data: JsonObject = {}; try { data = parseMarkdown(vaultRoot, file).data; } catch { continue; }
    const type = documentEntityType(data); const moduleId = moduleForDocument(data, type, modulePolicies); const policy = modulePolicies.get(moduleId);
    if ((policy?.policy.orphan_exempt_entity_types ?? []).includes(type)) continue;
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

/** A denied Read Level is a healthy enforcement outcome, but it still needs a
 * visible Quality Issue so the user can classify the file or adjust the module
 * policy rather than leave a Workflow silently waiting forever. */
function readAccessIssues(metrics: JsonObject): CandidateIssue[] {
  const output: CandidateIssue[] = [];
  for (const group of (metrics.groups as JsonObject[] | undefined) ?? []) {
    const events = object(group.events) ?? {};
    const denied = Number(events["read.denied"] ?? 0);
    if (!Number.isFinite(denied) || denied <= 0) continue;
    output.push({
      issue_type: "read-level-denied", dimension: "reviewability", severity: "medium",
      module: String(group.module ?? "core"), instance_id: typeof group.instance_id === "string" ? group.instance_id : null,
      target: { workflow_id: group.workflow_id ?? null, workflow_version: group.workflow_version ?? null },
      evidence: { denied_reads: denied, period: "last-24-hours" },
      recommended_action: { type: "review-file-read-level-or-module-permission" }, detector: "read-level-auditor",
    });
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

async function observationMetrics(vaultRoot: string, quality: QualityRepository, now: string): Promise<JsonObject> {
  const active = quality.listIssues({ statuses: ["open", "acknowledged", "scheduled"] }); const reviews: ReviewItem[] = [];
  for (const directory of ["Pending", "Deferred", "Error"]) for (const file of await listFilesRecursive(path.join(vaultRoot, "90-System", "Review Queue", directory), ".md")) try { reviews.push(parseMarkdown(vaultRoot, file).data as unknown as ReviewItem); } catch { /* Invalid review records are detected separately. */ }
  const runtime = await RuntimeRepository.open(vaultRoot); let followupIssueIds = new Set<string>();
  try { followupIssueIds = new Set(runtime.listTasks().filter((task) => task.job_id === "quality.stale-field-followup" && !["failed", "cancelled"].includes(task.status)).map((task) => String(task.trigger.issue_id ?? task.payload.quality_issue_id ?? "")).filter(Boolean)); }
  finally { runtime.close(); }
  const stale = active.filter((item) => item.issue_type === "stale-critical-field"); const promptAnomalies = active.filter((item) => item.issue_type === "prompt-quality-regression"); const alerts = active.filter((item) => ["critical", "high"].includes(item.severity));
  return {
    active_issues: active.length, high_critical_alerts: alerts.length, pending_reviews: reviews.length,
    overdue_reviews: reviews.filter((item) => item.overdue || (item.sla_due_at && Date.parse(item.sla_due_at) <= Date.parse(now))).length,
    missing_critical_provenance: active.filter((item) => item.issue_type === "missing-provenance" && item.severity === "high").length,
    stale_critical_fields: stale.length, actionable_stale_fields: stale.filter((item) => followupIssueIds.has(item.issue_id)).length,
    prompt_anomalies: promptAnomalies.length,
    unattributed_prompt_anomalies: promptAnomalies.filter((item) => typeof item.target.prompt_id !== "string" || typeof item.target.prompt_version !== "string").length,
  };
}

export function evaluateObservationWindow(observation: JsonObject, now: string): JsonObject {
  const snapshots = (Array.isArray(observation.snapshots) ? observation.snapshots : []).filter((item): item is JsonObject => Boolean(item && typeof item === "object" && !Array.isArray(item))); const startedAt = String(observation.started_at ?? now);
  const elapsedDays = Math.max(0, (Date.parse(now) - Date.parse(startedAt)) / 86_400_000); const minimumDays = Number(observation.minimum_days ?? 14); const targetDays = Number(observation.target_days ?? 28);
  const timezone = String(observation.timezone ?? "Asia/Shanghai"); const rawMeasured = snapshots.filter((item) => object(item.metrics)); const sampleByDay = new Map<string, JsonObject>();
  for (const item of [...rawMeasured].sort((left, right) => Date.parse(String(left.observed_at ?? "")) - Date.parse(String(right.observed_at ?? "")))) { const day = localDayKey(String(item.observed_at ?? ""), timezone); if (day) sampleByDay.set(day, item); }
  const measured = [...sampleByDay.values()]; const uniqueDays = measured.length; const weeklyAuditWindows = new Set(rawMeasured.filter((item) => item.frequency === "weekly").map((item) => weekKey(String(item.observed_at ?? ""), timezone)).filter(Boolean)); const weeklyAudits = weeklyAuditWindows.size;
  const requiredMeasuredDays = Math.min(7, Math.max(2, Math.floor(minimumDays / 2))); const coveragePass = uniqueDays >= requiredMeasuredDays && weeklyAudits >= 2; const baseline = object(measured[0]?.metrics); const latest = object(measured.at(-1)?.metrics);
  const trend = (key: string): JsonObject => baseline && latest ? { status: Number(latest[key] ?? 0) <= Number(baseline[key] ?? 0) ? "pass" : "fail", baseline: Number(baseline[key] ?? 0), current: Number(latest[key] ?? 0) } : { status: "insufficient-evidence", baseline: null, current: null };
  const stale = latest ? { status: Number(latest.stale_critical_fields ?? 0) === 0 || Number(latest.actionable_stale_fields ?? 0) >= Number(latest.stale_critical_fields ?? 0) ? "pass" : "fail", stale: Number(latest.stale_critical_fields ?? 0), actionable: Number(latest.actionable_stale_fields ?? 0) } : { status: "insufficient-evidence", stale: null, actionable: null };
  const prompts = latest ? { status: Number(latest.unattributed_prompt_anomalies ?? 0) === 0 ? "pass" : "fail", anomalies: Number(latest.prompt_anomalies ?? 0), unattributed: Number(latest.unattributed_prompt_anomalies ?? 0) } : { status: "insufficient-evidence", anomalies: null, unattributed: null };
  const alertLimit = Number(observation.max_high_critical_alerts ?? 5); const alerts = latest ? { status: Number(latest.high_critical_alerts ?? 0) <= alertLimit ? "pass" : "fail", current: Number(latest.high_critical_alerts ?? 0), limit: alertLimit } : { status: "insufficient-evidence", current: null, limit: alertLimit };
  const reviewDebt = baseline && latest ? { status: Number(latest.pending_reviews ?? 0) <= Number(baseline.pending_reviews ?? 0) && Number(latest.overdue_reviews ?? 0) <= Number(baseline.overdue_reviews ?? 0) ? "pass" : "fail", baseline_pending: Number(baseline.pending_reviews ?? 0), current_pending: Number(latest.pending_reviews ?? 0), baseline_overdue: Number(baseline.overdue_reviews ?? 0), current_overdue: Number(latest.overdue_reviews ?? 0) } : { status: "insufficient-evidence", baseline_pending: null, current_pending: null, baseline_overdue: null, current_overdue: null };
  const criteria: JsonObject = { "review-debt-not-growing": reviewDebt, "missing-critical-provenance-not-growing": trend("missing_critical_provenance"), "stale-fields-actionable": stale, "prompt-anomalies-attributable": prompts, "alert-volume-acceptable": alerts }; const criterionValues = Object.values(criteria).map((value) => String(object(value)?.status ?? "insufficient-evidence"));
  const eligible = elapsedDays >= minimumDays && coveragePass; const overall = !eligible ? "insufficient-evidence" : criterionValues.every((value) => value === "pass") ? "preliminary-pass" : "needs-attention";
  return { evaluated_at: now, timezone, elapsed_days: Math.floor(elapsedDays), minimum_days: minimumDays, target_days: targetDays, target_reached: elapsedDays >= targetDays, coverage: { measured_snapshots: measured.length, raw_measured_snapshots: rawMeasured.length, unique_days: uniqueDays, required_unique_days: requiredMeasuredDays, weekly_audits: weeklyAudits, required_weekly_audits: 2, status: coveragePass ? "pass" : "insufficient-evidence" }, criteria, eligible_for_final_review: eligible, overall };
}

async function updateObservation(vaultRoot: string, now: string, summary: JsonObject, quality: QualityRepository): Promise<JsonObject> {
  const file = path.join(vaultRoot, "90-System", "State", "quality-observation.json");
  const current = await readJson<JsonObject>(file, { schema_version: 2, timezone: "Asia/Shanghai", started_at: now, minimum_days: 14, target_days: 28, max_high_critical_alerts: 5, snapshots: [] });
  const snapshots = Array.isArray(current.snapshots) ? current.snapshots.filter((item): item is JsonObject => Boolean(item && typeof item === "object" && !Array.isArray(item))) : []; snapshots.push({ observed_at: now, audit_id: summary.audit_id ?? null, frequency: summary.frequency ?? null, detected: summary.detected ?? 0, resolved: summary.resolved ?? 0, by_severity: summary.by_severity ?? {}, metrics: await observationMetrics(vaultRoot, quality, now) });
  const timezone = String(current.timezone ?? "Asia/Shanghai"); const compacted = compactObservationSnapshots(snapshots, timezone); const evaluation = evaluateObservationWindow({ ...current, timezone, snapshots: compacted }, now); const status = evaluation.eligible_for_final_review === true ? evaluation.overall === "preliminary-pass" ? "ready-for-evaluation" : "needs-attention" : "observing";
  const next: JsonObject = { ...current, schema_version: 2, timezone, updated_at: now, elapsed_days: Number(evaluation.elapsed_days ?? 0), status, snapshots: compacted, evaluation_criteria: Object.keys(object(evaluation.criteria) ?? {}), snapshots_retained: 100, evaluation };
  await writeJsonAtomic(file, next); return next;
}

export async function runQualityAudit(vaultRoot: string, frequency: AuditFrequency, options: { now?: string } = {}): Promise<JsonObject> {
  const now = options.now ?? new Date().toISOString(); const repository = await QualityRepository.open(vaultRoot); const audit = repository.startAudit(frequency); const auditId = String(audit.audit_id);
  try {
    const files = await knowledgeFiles(vaultRoot); const currentHashes = Object.fromEntries(await Promise.all(files.map(async (file) => [toVaultPath(vaultRoot, file), await sha256File(file)])));
    const previous = await readJson<JsonObject>(path.join(vaultRoot, "90-System", "State", "quality-audit-checkpoint.json"), {}); const previousHashes = object(previous.file_hashes) ?? {};
    const fullSchemaScan = frequency !== "daily" || previous.schema_version !== 2; const changedPaths = new Set(Object.entries(currentHashes).filter(([relative, hash]) => fullSchemaScan || previousHashes[relative] !== hash).map(([relative]) => relative));
    const modulePolicies = await policies(vaultRoot);
    const recentMetrics = repository.aggregateMetrics(new Date(Date.parse(now) - 24 * 86_400_000).toISOString());
    const candidates = [...await auditDocuments(vaultRoot, frequency, modulePolicies, auditId, now, changedPaths), ...await auditReviewDebt(vaultRoot, now), ...await auditInstanceTasks(vaultRoot), ...evidenceQualityIssues(repository.listEvidence(5000)), ...readAccessIssues(recentMetrics)];
    if (frequency !== "daily") candidates.push(...await promptQualityIssues(modulePolicies, repository.aggregateMetrics(new Date(Date.parse(now) - 7 * 86_400_000).toISOString())));
    const openTargetsByAction = new Map<string, Set<string>>();
    const targetsFor = async (action: JsonObject): Promise<Set<string>> => {
      const key = JSON.stringify(action.dedupe ?? {});
      const existing = openTargetsByAction.get(key); if (existing) return existing;
      const targets = await openFollowupTargets(vaultRoot, action); openTargetsByAction.set(key, targets); return targets;
    };
    for (const candidate of candidates) {
      const targetPath = typeof candidate.target.path === "string" ? candidate.target.path.replaceAll("\\", "/").toLowerCase() : "";
      if (candidate.recommended_action.type === "workflow" && (await targetsFor(candidate.recommended_action)).has(targetPath)) candidate.recommended_action = { type: "await-existing-followup" };
    }
    const seen = new Set<string>(); const issues: QualityIssue[] = [];
    for (const candidate of candidates) { const stored = repository.upsertIssue(issue(candidate, auditId, now)); seen.add(stored.fingerprint); issues.push(stored); repository.recordMetric({ idempotency_key: `quality:${auditId}:${stored.fingerprint}`, event_type: "quality.issue-detected", module: stored.module, instance_id: stored.instance_id, workflow_id: null, workflow_version: null, prompt_id: null, prompt_version: null, run_id: auditId, occurred_at: now, dimensions: { issue_type: stored.issue_type, severity: stored.severity, dimension: stored.dimension }, values: {} }); }
    const followups = await RuntimeRepository.open(vaultRoot);
    try {
      for (const task of followups.listTasks().filter((item) => item.job_id === "quality.stale-field-followup" && !TERMINAL_TASKS.has(item.status))) {
        const target = object(task.payload.target); const targetPath = typeof target?.path === "string" ? target.path.replaceAll("\\", "/").toLowerCase() : "";
        const action = object(task.payload.quality_followup);
        if (!action || !(await targetsFor(action)).has(targetPath)) continue;
        if (task.status === "waiting-for-user") followups.transitionTask(task.task_id, "completed", { error: null, completionReason: "followup-already-open" });
        else followups.cancelTask(task.task_id);
      }
      for (const stored of issues.filter((item) => item.recommended_action.type === "workflow")) {
        const targetPath = typeof stored.target.path === "string" ? stored.target.path.replaceAll("\\", "/").toLowerCase() : "";
        if ((await targetsFor(stored.recommended_action)).has(targetPath)) continue;
          const workflowId = String(stored.recommended_action.workflow_id);
          const workflowVersion = typeof stored.recommended_action.workflow_version === "string" ? stored.recommended_action.workflow_version : "active";
          const module = modulePolicies.get(stored.module)?.module;
          if (!module) continue;
          followups.createTask({
        job_id: "quality.stale-field-followup", module: stored.module, instance_id: stored.instance_id, task_type: "workflow", workflow: `module:${stored.module}:${workflowId}`, priority: "high", scheduled_for: now, available_after: now,
        resources: followupResources(module, stored.recommended_action), trigger: { type: "quality-issue", issue_id: stored.issue_id, workflow_id: workflowId, workflow_version: workflowVersion }, catch_up_policy: "latest",
        idempotency_key: `quality:${stored.fingerprint}:followup:${workflowId}`, max_attempts: 1, payload: { quality_issue_id: stored.issue_id, target: stored.target, quality_followup: stored.recommended_action }, concurrency_key: `quality:${stored.instance_id ?? "global"}:${workflowId}`, concurrency_policy: "merge",
        });
      }
    } finally { followups.close(); }
    let resolved = 0;
    const executedDetectors = new Set(["broken-link-auditor", "schema-version-auditor", "missing-provenance-auditor", "stale-field-auditor", "ownership-auditor", "review-debt-auditor", "instance-task-auditor", "evidence-status-auditor", "read-level-auditor"]);
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
    summary.observation = await updateObservation(vaultRoot, now, summary, repository);
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
