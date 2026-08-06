import path from "node:path";
import { parseMarkdown } from "../core/bridge.js";
import { fromVaultPath, listFilesRecursive, readJson } from "../core/files.js";
import type { DashboardItem, JsonObject, ReviewItem } from "../core/types.js";
import { RuntimeRepository } from "../runtime/repository.js";
import type { QualityIssue } from "./domain.js";
import { QualityRepository } from "./repository.js";
import { legacyAccessPolicyMigrationSummary } from "../core/legacyAccessMigration.js";

function groupCount<T>(values: T[], key: (value: T) => string): JsonObject { const output: JsonObject = {}; for (const value of values) { const name = key(value); output[name] = Number(output[name] ?? 0) + 1; } return output; }
function ageBucket(created: string, now = Date.now()): string { const days = Math.floor((now - Date.parse(created)) / 86_400_000); return days <= 3 ? "0-3d" : days <= 7 ? "4-7d" : days <= 30 ? "8-30d" : "over-30d"; }

const QUALITY_FIELD_LABELS: Record<string, string> = {
  application_open: "申请开放状态",
  application_status: "申请状态",
  deadline: "申请截止日期",
  tuition: "学费",
  academic_requirement: "学术要求",
  english_requirement: "英语要求",
  credit_exemption: "学分减免",
};

function qualityFieldLabel(field: unknown): string {
  const value = String(field ?? "").trim();
  return QUALITY_FIELD_LABELS[value] ?? (value ? value.replaceAll("_", " ") : "重要信息");
}

function qualityIssuePresentation(issue: QualityIssue): { title: string; description: string } {
  const field = qualityFieldLabel(issue.target.field);
  if (issue.issue_type === "stale-critical-field") return { title: "重要申请信息需要重新核验", description: `「${field}」已超过建议核验周期。请发起一次申请信息核验；系统会先创建核验请求，不会直接覆盖正式档案。` };
  if (issue.issue_type === "due-soon-field") return { title: "重要申请信息即将需要核验", description: `「${field}」即将达到建议核验时间。可以提前安排一次申请信息核验。` };
  if (issue.issue_type === "missing-provenance") return { title: "重要信息缺少来源", description: `「${field}」目前没有足够的来源记录，请补充证据后再作为正式信息使用。` };
  if (issue.issue_type === "conflicting-evidence") return { title: "申请信息存在来源冲突", description: `「${field}」的来源给出了不同结果，需要比较证据后再决定保留哪个值。` };
  if (issue.issue_type === "unowned-file") return { title: "文件尚未归类", description: "请为这个文件选择所属模块或实例，避免它脱离 KnowledgeOS 的管理范围。" };
  if (issue.issue_type === "orphan-file") return { title: "发现未关联文件", description: "这个文件没有明确的知识归属或链接，建议检查后决定保留位置。" };
  return { title: issue.issue_type.replaceAll("-", " "), description: String(issue.recommended_action.type ?? "需要检查相关信息") };
}

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
  const runtime = await RuntimeRepository.open(vaultRoot);
  try {
    const sevenDays = new Date(Date.now() - 7 * 86_400_000).toISOString();
    return getQualityDashboardFromRuntimeSnapshot(vaultRoot, runtime.systemCenterData(sevenDays));
  } finally { runtime.close(); }
}

export async function getQualityDashboardFromRuntimeSnapshot(vaultRoot: string, snapshot: JsonObject): Promise<JsonObject> {
    const active = (snapshot.quality_active ?? []) as unknown as QualityIssue[];
    const resolved = (snapshot.quality_resolved ?? []) as unknown as QualityIssue[];
    const tasks = (snapshot.tasks ?? []) as unknown as JsonObject[];
    const metrics = (snapshot.metrics ?? {}) as JsonObject;
    const reviews = await reviewSummary(vaultRoot);
    const byType = groupCount(active, (item) => item.issue_type); const byModule = groupCount(active, (item) => item.module); const bySeverity = groupCount(active, (item) => item.severity);
    const sevenDays = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const legacyAccess = await legacyAccessPolicyMigrationSummary(vaultRoot);
    return {
      generated_at: new Date().toISOString(),
      overview: { active_issues: active.length, critical: Number(bySeverity.critical ?? 0), high: Number(bySeverity.high ?? 0), new_this_week: active.filter((item) => Date.parse(item.first_seen) >= Date.parse(sevenDays)).length, resolved_this_week: resolved.filter((item) => Date.parse(String(item.resolution?.resolved_at ?? 0)) >= Date.parse(sevenDays)).length, failed_tasks: tasks.filter((task) => task.status === "failed").length, modules: byModule },
      freshness: { due_soon: Number(byType["due-soon-field"] ?? 0), stale: Number(byType["stale-critical-field"] ?? 0), items: active.filter((item) => item.dimension === "freshness") },
      provenance: { missing: Number(byType["missing-provenance"] ?? 0), conflicts: Number(byType["conflicting-evidence"] ?? 0), unavailable: Number(byType["unavailable-evidence"] ?? 0), items: active.filter((item) => item.dimension === "provenance" || item.dimension === "consistency") },
      reviews,
      links_ownership: { broken_links: Number(byType["broken-internal-link"] ?? 0) + Number(byType["broken-internal-anchor"] ?? 0) + Number(byType["broken-external-link"] ?? 0) + Number(byType["external-link-unreachable"] ?? 0), orphan_files: Number(byType["orphan-file"] ?? 0), unowned_files: Number(byType["unowned-file"] ?? 0), missing_ownership: Number(byType["missing-content-ownership"] ?? 0) + Number(byType["invalid-content-ownership"] ?? 0), items: active.filter((item) => item.dimension === "connectivity" || item.issue_type.includes("ownership")) },
      schemas_migrations: { outdated: Number(byType["outdated-schema"] ?? 0), invalid: Number(byType["invalid-frontmatter"] ?? 0) + Number(byType["invalid-entity-schema"] ?? 0), legacy_access_policy: legacyAccess, items: active.filter((item) => item.dimension === "validity" && !item.issue_type.startsWith("prompt")) },
      ai_quality: { metrics, anomalies: active.filter((item) => item.issue_type === "prompt-quality-regression") },
      operational: (snapshot.runtime_stats ?? {}) as JsonObject, audit_history: (snapshot.audits ?? []) as JsonObject[], observation: await readJson<JsonObject>(path.join(vaultRoot, "90-System", "State", "quality-observation.json"), {}), by_severity: bySeverity,
    };
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
  const presentation = qualityIssuePresentation(issue);
  return { item_id: `DSH-${issue.issue_id}`, source_module: issue.module, instance_id: issue.instance_id, category: issue.dimension === "freshness" ? "deadline" : ["critical", "high"].includes(issue.severity) ? "system" : "warning", priority: issue.severity === "info" ? "low" : issue.severity, title: presentation.title, description: presentation.description, target, due_at: null, actions: ["open", "acknowledge", "suppress"], created_at: issue.first_seen, blocks_count: issue.severity === "critical" ? 1 : 0, active_context: ["critical", "high"].includes(issue.severity), quality_issue_id: issue.issue_id };
}
