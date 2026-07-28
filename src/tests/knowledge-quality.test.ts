import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeMarkdown } from "../core/bridge.js";
import { assertOwnedMutation } from "../core/qualityOwnership.js";
import { initializeVault } from "../core/vault.js";
import { invokeCommandApi } from "../platform/commandApi.js";
import { runQualityAudit } from "../quality/audit.js";
import { evaluateFreshness, resolveVerificationInterval } from "../quality/freshness.js";
import { QualityRepository } from "../quality/repository.js";
import type { JsonObject } from "../core/types.js";

test("freshness distinguishes verified, due-soon, stale, historical and hierarchy", () => {
  const now = new Date("2026-07-28T00:00:00Z");
  assert.equal(resolveVerificationInterval({ field: 7, entity: 14, module: 30, core: 90 }), 7);
  assert.equal(evaluateFreshness({ lastVerified: "2026-07-22T00:00:00Z", intervalDays: 7, now }).verification_status, "due-soon");
  assert.equal(evaluateFreshness({ lastVerified: "2026-07-20T00:00:00Z", intervalDays: 7, now }).verification_status, "stale");
  assert.equal(evaluateFreshness({ lastVerified: "2020-01-01T00:00:00Z", intervalDays: 7, now, historical: true }).verification_status, "historical");
});

test("content ownership protects user and source regions while mixed AI changes require review", () => {
  const data: JsonObject = { _ownership: { sections: { 原始记录: "user-owned", 官方原文: "source-immutable", AI整理: "ai-managed", 结论: "mixed" } } };
  assert.throws(() => assertOwnedMutation(data, { actor: "ai", section: "原始记录" }), /OWNERSHIP_VIOLATION|user-owned/);
  assert.throws(() => assertOwnedMutation(data, { actor: "user", section: "官方原文" }), /OWNERSHIP_VIOLATION|source-immutable/);
  assert.doesNotThrow(() => assertOwnedMutation(data, { actor: "ai", section: "AI整理" }));
  assert.throws(() => assertOwnedMutation(data, { actor: "ai", section: "结论" }), /requires Review/);
  assert.doesNotThrow(() => assertOwnedMutation(data, { actor: "ai", section: "结论", reviewId: "REV-2026-000001" }));
});

test("quality repository persists evidence, deduplicates issues, aggregates metrics and remembers rejection", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-quality-repo-"));
  try {
    const repository = await QualityRepository.open(vault); const now = new Date().toISOString();
    const evidence = repository.upsertEvidence({ source_type: "external-research", source_ref: "Research/report.md", supports: [{ entity_ref: "20-Workspace/record.md", field: "deadline" }], locator: {}, observed_at: now, captured_at: now, collector: { type: "test" }, quality: { authority: "unknown", freshness: "current", extraction_confidence: 0.9 }, status: "active" });
    assert.match(evidence.evidence_id, /^EVD-/);
    const base = { fingerprint: "fingerprint-knowledge-quality-0001", issue_type: "missing-provenance", dimension: "provenance" as const, severity: "high" as const, module: "application-tracker", instance_id: null, target: { path: "20-Workspace/record.md", field: "deadline" }, detected_at: now, detector: { id: "test-auditor", version: "1" }, evidence: {}, status: "open" as const, recommended_action: { type: "attach-evidence" }, last_notified: null, suppressed_until: null, resolution: null };
    assert.equal(repository.upsertIssue(base).occurrence_count, 1); assert.equal(repository.upsertIssue(base).occurrence_count, 2); assert.equal(repository.listIssues().length, 1);
    repository.recordMetric({ idempotency_key: "metric:test:1", event_type: "review.rejected", module: "application-tracker", instance_id: null, workflow_id: "review", workflow_version: "1", prompt_id: "compare", prompt_version: "1", run_id: null, occurred_at: now, dimensions: {}, values: {} });
    assert.equal(Number((repository.aggregateMetrics("2020-01-01T00:00:00Z").totals as JsonObject)["review.rejected"]), 1);
    repository.rememberRejection({ fingerprint: "review-fingerprint", rejected_value_hash: "value", evidence_hash: "evidence", reason: "not useful", rejected_at: now, suppressed_until: null });
    assert.equal(repository.rejectionMemory("review-fingerprint")?.reason, "not useful"); repository.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("quality audit creates deduplicated actionable issues and Today only surfaces high findings", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-quality-audit-"));
  try {
    await initializeVault(vault, "disabled");
    writeMarkdown(vault, path.join(vault, "30-Knowledge", "Unowned.md"), { data: { title: "Unowned" }, content: "Broken [[Missing Target]]\n" });
    await runQualityAudit(vault, "weekly", { now: "2026-07-28T00:00:00Z" });
    await runQualityAudit(vault, "weekly", { now: "2026-07-28T01:00:00Z" });
    const repository = await QualityRepository.open(vault); const issues = repository.listIssues();
    assert.equal(issues.some((item) => item.issue_type === "unowned-file" && item.severity === "high" && item.occurrence_count === 2), true);
    assert.equal(issues.some((item) => item.issue_type === "broken-internal-link"), true); repository.close();
    const today = await invokeCommandApi({ vaultRoot: vault, requestId: "QUALITY-TODAY", method: "getTodayItems", params: {} });
    assert.equal(today.ok, true, JSON.stringify(today.error)); const snapshot = today.data as JsonObject; const items = ["focus", "reviews", "due", "waiting_external", "failures", "module_summaries"].flatMap((key) => snapshot[key] as JsonObject[] ?? []);
    assert.equal(items.some((item) => item.quality_issue_id), true);
    assert.equal(items.some((item) => item.title === "broken-internal-link"), false);
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("Quality Dashboard and issue actions expose the stable command contract", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-quality-api-"));
  try {
    await initializeVault(vault, "disabled"); const repository = await QualityRepository.open(vault); const now = new Date().toISOString();
    const issue = repository.upsertIssue({ fingerprint: "quality-api-fingerprint-00001", issue_type: "stale-critical-field", dimension: "freshness", severity: "high", module: "application-tracker", instance_id: "demo", target: { path: "20-Workspace/demo.md", field: "deadline" }, detected_at: now, detector: { id: "test-auditor", version: "1" }, evidence: {}, status: "open", recommended_action: { type: "verify-field" }, last_notified: null, suppressed_until: null, resolution: null }); repository.close();
    const dashboard = await invokeCommandApi({ vaultRoot: vault, requestId: "QUALITY-DASH", method: "getQualityDashboard", params: {} });
    assert.equal(dashboard.ok, true); assert.equal(((dashboard.data as JsonObject).overview as JsonObject).high, 1);
    const managed = await invokeCommandApi({ vaultRoot: vault, requestId: "QUALITY-MANAGE", method: "manageQualityIssue", params: { issue_id: issue.issue_id, action: "suppress", suppressed_until: "2026-08-01T00:00:00Z" } });
    assert.equal((managed.data as JsonObject).status, "suppressed");
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});
