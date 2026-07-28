import path from "node:path";
import { parseMarkdown } from "../core/bridge.js";
import { fromVaultPath, listFilesRecursive } from "../core/files.js";
import type { DashboardItem, JsonObject, ReviewItem } from "../core/types.js";
import { RuntimeRepository } from "../runtime/repository.js";
import type { QualityIssue } from "./domain.js";
import { QualityRepository } from "./repository.js";

function groupCount<T>(values: T[], key: (value: T) => string): JsonObject { const output: JsonObject = {}; for (const value of values) { const name = key(value); output[name] = Number(output[name] ?? 0) + 1; } return output; }
function ageBucket(created: string, now = Date.now()): string { const days = Math.floor((now - Date.parse(created)) / 86_400_000); return days <= 3 ? "0-3d" : days <= 7 ? "4-7d" : days <= 30 ? "8-30d" : "over-30d"; }

async function reviewSummary(vaultRoot: string): Promise<JsonObject> {
  const open: ReviewItem[] = []; const closed: ReviewItem[] = [];
  for (const directory of ["Pending", "Deferred", "Error", "Closed"]) {
    for (const file of await listFilesRecursive(path.join(vaultRoot, "90-System", "Review Queue", directory), ".md")) {
      try { const item = parseMarkdown(vaultRoot, file).data as unknown as ReviewItem; (directory === "Closed" ? closed : open).push(item); } catch { /* Audit reports invalid records separately. */ }
    }
  }
  const decisions = groupCount(closed.filter((item) => item.decision), (item) => String(item.decision!.decision));
  const resolvedDurations = closed.filter((item) => item.decision).map((item) => Date.parse(item.decision!.decided_at) - Date.parse(item.created)).filter(Number.isFinite);
  return { pending: open.length, overdue: open.filter((item) => item.overdue || (item.sla_due_at && Date.parse(item.sla_due_at) <= Date.now())).length, age_buckets: groupCount(open, (item) => ageBucket(item.created)), by_module: groupCount(open, (item) => item.source_module), decisions, average_resolution_ms: resolvedDurations.length ? Math.round(resolvedDurations.reduce((a, b) => a + b, 0) / resolvedDurations.length) : null };
}

export async function getQualityDashboard(vaultRoot: string): Promise<JsonObject> {
  const quality = await QualityRepository.open(vaultRoot); const runtime = await RuntimeRepository.open(vaultRoot);
  try {
    const active = quality.listIssues({ statuses: ["open", "acknowledged", "scheduled", "suppressed"] });
    const sevenDays = new Date(Date.now() - 7 * 86_400_000).toISOString(); const metrics = quality.aggregateMetrics(sevenDays); const reviews = await reviewSummary(vaultRoot);
    const byType = groupCount(active, (item) => item.issue_type); const byModule = groupCount(active, (item) => item.module); const bySeverity = groupCount(active, (item) => item.severity);
    return {
      generated_at: new Date().toISOString(),
      overview: { active_issues: active.length, critical: Number(bySeverity.critical ?? 0), high: Number(bySeverity.high ?? 0), new_this_week: active.filter((item) => Date.parse(item.first_seen) >= Date.parse(sevenDays)).length, resolved_this_week: quality.listIssues({ statuses: ["resolved"] }).filter((item) => Date.parse(String(item.resolution?.resolved_at ?? 0)) >= Date.parse(sevenDays)).length, failed_tasks: runtime.listTasks(["failed"]).length, modules: byModule },
      freshness: { due_soon: Number(byType["due-soon-field"] ?? 0), stale: Number(byType["stale-critical-field"] ?? 0), items: active.filter((item) => item.dimension === "freshness") },
      provenance: { missing: Number(byType["missing-provenance"] ?? 0), conflicts: Number(byType["conflicting-evidence"] ?? 0), unavailable: Number(byType["unavailable-evidence"] ?? 0), items: active.filter((item) => item.dimension === "provenance" || item.dimension === "consistency") },
      reviews,
      links_ownership: { broken_links: Number(byType["broken-internal-link"] ?? 0), orphan_files: Number(byType["orphan-file"] ?? 0), unowned_files: Number(byType["unowned-file"] ?? 0), missing_ownership: Number(byType["missing-content-ownership"] ?? 0), items: active.filter((item) => item.dimension === "connectivity" || item.issue_type.includes("ownership")) },
      schemas_migrations: { outdated: Number(byType["outdated-schema"] ?? 0), invalid: Number(byType["invalid-frontmatter"] ?? 0), items: active.filter((item) => item.dimension === "validity" && !item.issue_type.startsWith("prompt")) },
      ai_quality: { metrics, anomalies: active.filter((item) => item.issue_type === "prompt-quality-regression") },
      operational: runtime.runtimeStats(), audit_history: quality.listAudits(50), by_severity: bySeverity,
    };
  } finally { quality.close(); runtime.close(); }
}

export async function getFieldProvenance(vaultRoot: string, target: string, field: string): Promise<JsonObject> {
  const document = parseMarkdown(vaultRoot, fromVaultPath(vaultRoot, target)); const metaRoot = document.data._field_meta as JsonObject | undefined; const meta = metaRoot?.[field] as JsonObject | undefined;
  const facts = document.data.facts as JsonObject | undefined; const fact = facts?.[field] as JsonObject | undefined; const evidenceRefs = Array.isArray(meta?.evidence_refs) ? meta.evidence_refs : Array.isArray(fact?.source_refs) ? fact.source_refs : [];
  const quality = await QualityRepository.open(vaultRoot);
  try {
    const evidence = evidenceRefs.filter((item): item is string => typeof item === "string").map((id) => quality.getEvidence(id)).filter(Boolean);
    const value = (field in document.data ? document.data[field] : fact?.value) ?? null;
    return { target, field, value, provenance: meta ?? { authorship: "unknown", evidence_refs: evidenceRefs, generation: null, review: null, verification: { last_verified: fact?.checked_at ?? null, verification_status: "unknown" } }, evidence, change_history: quality.listChanges(target).filter((change) => change.field === field) };
  } finally { quality.close(); }
}

export function qualityIssueToDashboardItem(issue: QualityIssue): DashboardItem {
  const target = typeof issue.target.path === "string" ? issue.target.path : typeof issue.target.entity_ref === "string" ? issue.target.entity_ref : null;
  return { item_id: `DSH-${issue.issue_id}`, source_module: issue.module, instance_id: issue.instance_id, category: issue.dimension === "freshness" ? "deadline" : ["critical", "high"].includes(issue.severity) ? "system" : "warning", priority: issue.severity === "info" ? "low" : issue.severity, title: issue.issue_type, description: String(issue.recommended_action.type ?? "Inspect quality issue"), target, due_at: null, actions: ["open", "acknowledge", "suppress"], created_at: issue.first_seen, blocks_count: issue.severity === "critical" ? 1 : 0, active_context: ["critical", "high"].includes(issue.severity), quality_issue_id: issue.issue_id };
}
