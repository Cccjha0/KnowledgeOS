import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseMarkdown, writeMarkdown } from "../core/bridge.js";
import { assertOwnedMutation } from "../core/qualityOwnership.js";
import { initializeVault } from "../core/vault.js";
import { invokeCommandApi } from "../platform/commandApi.js";
import { evaluateObservationWindow, runExternalLinkAudit, runQualityAudit } from "../quality/audit.js";
import { applyQualityBackfill, previewQualityBackfill } from "../quality/backfill.js";
import { evaluateFreshness, resolveVerificationInterval } from "../quality/freshness.js";
import { reviewFingerprint } from "../quality/fingerprint.js";
import { QualityRepository } from "../quality/repository.js";
import { RuntimeRepository } from "../runtime/repository.js";
import { qualityIssueToDashboardItem } from "../quality/presentation.js";
import type { JsonObject } from "../core/types.js";
import { readPluginSource } from "./plugin-source.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("module templates expose stable user, AI, system and source ownership regions", async () => {
  const paths = [
    "modules/application-tracker/templates/application-record.md",
    "modules/experience-log/templates/daily-log.md",
    "modules/experience-log/templates/weekly-summary.md",
    "modules/reading-log/templates/record.md",
  ];
  for (const relative of paths) {
    const template = await fs.readFile(path.join(ENGINE_ROOT, relative), "utf8");
    assert.match(template, /_ownership:/, relative);
    assert.match(template, /AI整理/, relative);
    assert.match(template, /用户/, relative);
  }
  assert.match(await fs.readFile(path.join(ENGINE_ROOT, paths[3]!), "utf8"), /type: reading-note/);
  assert.match(await readPluginSource("views/system-center.js"), /I14 真实观察/);
});

test("review deduplication remains stable when only new evidence arrives", () => {
  const base = { module: "application-tracker", instanceId: "demo", target: "20-Workspace/demo.md", action: "change-critical-field", proposedValue: { field: "deadline", new_value: "2027-05-01" } };
  assert.equal(reviewFingerprint({ ...base, evidence: ["old-source"] }), reviewFingerprint({ ...base, evidence: ["new-source"] }));
});

test("I14 evaluation requires real coverage and evaluates all five exit criteria", () => {
  const metrics = (pending: number): JsonObject => ({ pending_reviews: pending, missing_critical_provenance: 0, stale_critical_fields: 1, actionable_stale_fields: 1, prompt_anomalies: 1, unattributed_prompt_anomalies: 0, high_critical_alerts: 1 });
  const snapshots: JsonObject[] = Array.from({ length: 7 }, (_, index) => ({ observed_at: `2026-07-${String(index + 1).padStart(2, "0")}T00:00:00Z`, frequency: index === 0 || index === 6 ? "weekly" : "daily", metrics: metrics(index === 0 ? 2 : 1) }));
  const observation: JsonObject = { started_at: "2026-07-01T00:00:00Z", minimum_days: 14, target_days: 28, max_high_critical_alerts: 5, snapshots };
  assert.equal(evaluateObservationWindow(observation, "2026-07-10T00:00:00Z").overall, "insufficient-evidence");
  const ready = evaluateObservationWindow(observation, "2026-07-15T00:00:00Z");
  assert.equal(ready.overall, "preliminary-pass"); assert.equal(ready.eligible_for_final_review, true);
  const sameWeek = Array.from({ length: 7 }, (_, index) => ({ observed_at: `2026-07-${String(index + 6).padStart(2, "0")}T00:00:00Z`, frequency: index === 0 || index === 6 ? "weekly" : "daily", metrics: metrics(1) }));
  assert.equal(evaluateObservationWindow({ ...observation, snapshots: sameWeek }, "2026-07-15T00:00:00Z").eligible_for_final_review, false);
  const failing = evaluateObservationWindow({ ...observation, snapshots: [...snapshots, { observed_at: "2026-07-15T00:00:00Z", frequency: "daily", metrics: metrics(3) }] }, "2026-07-15T00:00:00Z");
  assert.equal(failing.overall, "needs-attention");
  const sameShanghaiDay = evaluateObservationWindow({ ...observation, snapshots: [
    { observed_at: "2026-07-28T16:10:00Z", frequency: "daily", metrics: metrics(1) },
    { observed_at: "2026-07-29T07:00:00Z", frequency: "daily", metrics: metrics(1) },
  ] }, "2026-08-15T00:00:00Z");
  assert.equal((sameShanghaiDay.coverage as JsonObject).unique_days, 1);
  assert.equal((sameShanghaiDay.coverage as JsonObject).measured_snapshots, 1);
  assert.equal((sameShanghaiDay.coverage as JsonObject).raw_measured_snapshots, 2);
  assert.equal(sameShanghaiDay.timezone, "Asia/Shanghai");
  const sameDayNoise: JsonObject[] = [
    { observed_at: "2026-07-01T00:00:00Z", frequency: "weekly", metrics: metrics(5) },
    { observed_at: "2026-07-01T12:00:00Z", frequency: "daily", metrics: metrics(1) },
    ...Array.from({ length: 6 }, (_, index) => ({ observed_at: `2026-07-${String(index + 2).padStart(2, "0")}T12:00:00Z`, frequency: index === 5 ? "weekly" : "daily", metrics: metrics(2) })),
  ];
  const dailyTrend = evaluateObservationWindow({ ...observation, snapshots: sameDayNoise }, "2026-07-15T12:00:00Z");
  assert.equal(dailyTrend.overall, "needs-attention");
  assert.equal(((dailyTrend.criteria as JsonObject)["review-debt-not-growing"] as JsonObject).baseline_pending, 1);
  const legacyWeekly = evaluateObservationWindow({ ...observation, snapshots: [
    ...snapshots.map((item) => ({ ...item, frequency: "daily" })),
    { observed_at: "2026-07-01T01:00:00Z", frequency: "weekly" },
    { observed_at: "2026-07-08T01:00:00Z", frequency: "weekly" },
  ] }, "2026-07-15T12:00:00Z");
  assert.equal((legacyWeekly.coverage as JsonObject).weekly_audits, 0);
  assert.equal(legacyWeekly.eligible_for_final_review, false);
});

test("freshness distinguishes verified, due-soon, stale, historical and hierarchy", () => {
  const now = new Date("2026-07-28T00:00:00Z");
  assert.equal(resolveVerificationInterval({ field: 7, entity: 14, module: 30, core: 90 }), 7);
  assert.equal(evaluateFreshness({ lastVerified: "2026-07-22T00:00:00Z", intervalDays: 7, now }).verification_status, "due-soon");
  assert.equal(evaluateFreshness({ lastVerified: "2026-07-20T00:00:00Z", intervalDays: 7, now }).verification_status, "stale");
  assert.equal(evaluateFreshness({ lastVerified: "2020-01-01T00:00:00Z", intervalDays: 7, now, historical: true }).verification_status, "historical");
});

test("Today translates stale quality issues into a user action", () => {
  const item = qualityIssueToDashboardItem({
    issue_id: "QI-TEST-STALE",
    fingerprint: "stale-presentation",
    issue_type: "stale-critical-field",
    dimension: "freshness",
    severity: "high",
    module: "application-tracker",
    instance_id: "demo",
    target: { path: "20-Workspace/Applications/demo/Records/Application.md", field: "application_open" },
    detected_at: "2026-08-04T00:00:00Z",
    detector: { id: "stale-field-auditor", version: "1" },
    evidence: {},
    status: "open",
    recommended_action: { type: "create-research-request" },
    first_seen: "2026-08-04T00:00:00Z",
    last_seen: "2026-08-04T00:00:00Z",
    occurrence_count: 1,
    last_notified: null,
    suppressed_until: null,
    resolution: null,
  });
  assert.equal(item.title, "重要申请信息需要重新核验");
  assert.match(item.description, /申请开放状态/);
  assert.match(item.description, /不会直接覆盖正式档案/);
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
    const stored = repository.upsertIssue(base); assert.equal(stored.occurrence_count, 1); assert.equal(repository.upsertIssue(base).occurrence_count, 2); assert.equal(repository.listIssues().length, 1);
    repository.updateIssue(stored.issue_id, "suppressed", { suppressed_until: "2000-01-01T00:00:00Z" });
    assert.equal(repository.upsertIssue(base).status, "open");
    repository.updateIssue(stored.issue_id, "ignored");
    assert.equal(repository.upsertIssue(base).status, "ignored");
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

test("Blueprint-generated Quality Policies drive provenance and freshness audits for Course fields", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-course-quality-contract-"));
  try {
    await initializeVault(vault, "disabled");
    const record = path.join(vault, "20-Workspace", "课程管理", "demo", "Assignments", "essay.md");
    writeMarkdown(vault, record, { data: {
      source_module: "course", type: "course-assignment", schema_id: "assignment", schema_version: 1, module_version: "0.2.0-beta", instance_id: "demo",
      id: "ASSIGN-2026-000001", title: "Essay", source_refs: [], created: "2026-07-01T00:00:00Z", updated: "2026-07-01T00:00:00Z", safe_summary: "Essay", deadline: "2026-08-01T00:00:00Z", status: "planned",
      _field_meta: { deadline: { evidence_refs: [], verification: { last_verified: "2026-07-20T00:00:00Z" } } },
    }, content: "# Essay\n" });
    await runQualityAudit(vault, "weekly", { now: "2026-08-01T00:00:00Z" });
    const repository = await QualityRepository.open(vault); const issues = repository.listIssues(); repository.close();
    assert.equal(issues.some((item) => item.module === "course" && item.issue_type === "missing-provenance" && item.target.field === "deadline" && item.severity === "high"), true);
    assert.equal(issues.some((item) => item.module === "course" && item.issue_type === "stale-critical-field" && item.target.field === "deadline" && item.severity === "high"), true);
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("quality audit infers module ownership, honors frontmatter links, and suppresses duplicate research followups", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-quality-application-contract-"));
  try {
    await initializeVault(vault, "disabled");
    const declaredFollowup = {
      type: "workflow",
      workflow_id: "sync-due-research",
      workflow_version: "1.0.0",
      resources: { filesystem: "required", network: "not-required", codex: "not-required", user: "required" },
      dedupe: { entity_type: "research-request", target_field: "record_path", open_statuses: ["pending", "in-progress", "needs-more-information"] },
    };
    const recordPath = "20-Workspace/Applications/demo/Records/Application.md";
    const requestPath = path.join(vault, "20-Workspace", "Applications", "demo", "Research Requests", "REQ-2026-000001.md");
    writeMarkdown(vault, requestPath, { data: {
      request_id: "REQ-2026-000001", type: "research-request", instance_id: "demo", application_id: "APP-2026-0001",
      record_path: recordPath, status: "pending", reason: "Verification is due.", requested_fields: ["tuition"], report_ids: [],
      idempotency_key: "application:demo:request", created_at: "2026-07-28T00:00:00Z", updated_at: "2026-07-28T00:00:00Z",
      completed_at: null, next_action_at: "2026-07-28T00:00:00Z", schema_version: 1,
    }, content: "# Research Request\n" });
    writeMarkdown(vault, path.join(vault, "30-Knowledge", "Target.md"), { data: { title: "Target" }, content: "# Target\n" });
    writeMarkdown(vault, path.join(vault, "30-Knowledge", "Source.md"), { data: { source_ref: "[[30-Knowledge/Target]]" }, content: "# Source\n" });
    const runtime = await RuntimeRepository.open(vault);
    const task = runtime.createTask({
      job_id: "quality.stale-field-followup", module: "application-tracker", instance_id: "demo", task_type: "workflow",
      workflow: "module:application-tracker:sync-due-research", priority: "high", resources: { filesystem: "required", network: "not-required", codex: "not-required", user: "required" },
      trigger: { type: "quality-issue", issue_id: "QI-TEST", workflow_id: "sync-due-research", workflow_version: "1.0.0" }, catch_up_policy: "latest", idempotency_key: "quality:demo:followup",
      payload: { quality_issue_id: "QI-TEST", target: { path: recordPath }, quality_followup: declaredFollowup }, concurrency_key: "quality:demo:research", concurrency_policy: "merge",
    }).task;
    runtime.transitionTask(task.task_id, "waiting-for-user"); runtime.close();

    await runQualityAudit(vault, "weekly", { now: "2026-07-28T01:00:00Z" });
    const quality = await QualityRepository.open(vault); const issues = quality.listIssues(); quality.close();
    assert.equal(issues.some((item) => item.target.path === "20-Workspace/Applications/demo/Research Requests/REQ-2026-000001.md" && item.issue_type === "unowned-file"), false);
    assert.equal(issues.some((item) => item.target.path === "20-Workspace/Applications/demo/Research Requests/REQ-2026-000001.md" && item.issue_type === "orphan-file"), false);
    assert.equal(issues.some((item) => item.target.path === "30-Knowledge/Target.md" && item.issue_type === "orphan-file"), false);
    assert.equal(issues.some((item) => item.recommended_action.type === "workflow" && item.target.path === recordPath), false);
    const checkedRuntime = await RuntimeRepository.open(vault); assert.equal(checkedRuntime.getTask(task.task_id)?.status, "completed"); checkedRuntime.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("stale followups are scheduled from the module Quality Policy, not an application Core branch", async () => {
  const source = await fs.readFile(path.join(ENGINE_ROOT, "src", "quality", "audit.ts"), "utf8");
  assert.equal(source.includes('moduleId === "application-tracker"'), false);
  assert.equal(source.includes("module:application-tracker:sync-due-research"), false);

  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-quality-policy-followup-"));
  try {
    await initializeVault(vault, "disabled");
    const recordPath = "20-Workspace/Applications/demo/Records/Application.md";
    writeMarkdown(vault, path.join(vault, recordPath), { data: {
      source_module: "application-tracker", type: "application-record", schema_id: "application-record", schema_version: 1, module_version: "0.3.0-beta", instance_id: "demo",
      id: "APP-2026-000001", title: "Application", source_refs: ["[[Official source]]"], created: "2026-06-01T00:00:00Z", updated: "2026-06-01T00:00:00Z",
      application_status: "watching", application_open: false, deadline: "2026-07-01", tuition: "50000", academic_requirement: "Bachelor", english_requirement: "IELTS 6.5",
      _field_meta: { deadline: { evidence_refs: ["EVD-2026-000001"], verification: { last_verified: "2026-07-01T00:00:00Z" } } },
    }, content: "# Application\n" });

    await runQualityAudit(vault, "weekly", { now: "2026-08-01T00:00:00Z" });
    const runtime = await RuntimeRepository.open(vault);
    const followup = runtime.listTasks().find((task) => task.job_id === "quality.stale-field-followup" && (task.payload.target as JsonObject | undefined)?.path === recordPath);
    runtime.close();
    assert.ok(followup);
    assert.equal(followup.module, "application-tracker");
    assert.equal(followup.workflow, "module:application-tracker:sync-due-research");
    assert.equal(followup.trigger.workflow_id, "sync-due-research");
    assert.equal((followup.payload.quality_followup as JsonObject).type, "workflow");

    const quality = await QualityRepository.open(vault); const issues = quality.listIssues(); quality.close();
    const stale = issues.find((item) => item.target.path === recordPath && item.target.field === "deadline");
    assert.equal((stale?.recommended_action as JsonObject | undefined)?.workflow_id, "sync-due-research");
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

test("quality audit validates entity schemas and WikiLink anchors", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-quality-contract-audit-"));
  try {
    await initializeVault(vault, "disabled");
    writeMarkdown(vault, path.join(vault, "30-Knowledge", "Target.md"), { data: { title: "Target" }, content: "# Existing section\n" });
    writeMarkdown(vault, path.join(vault, "30-Knowledge", "Invalid Reading.md"), {
      data: { source_module: "reading-log", type: "reading-note", schema_id: "record", schema_version: 1 },
      content: "[[Target#Missing section]]\n",
    });
    await runQualityAudit(vault, "weekly", { now: "2026-07-28T00:00:00Z" });
    const repository = await QualityRepository.open(vault); const issues = repository.listIssues(); repository.close();
    assert.equal(issues.some((item) => item.issue_type === "broken-internal-anchor"), true);
    assert.equal(issues.some((item) => item.issue_type === "invalid-entity-schema" && item.severity === "high"), true);
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("quality backfill infers application research report ownership", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-quality-backfill-"));
  try {
    await initializeVault(vault, "disabled");
    writeMarkdown(vault, path.join(vault, "20-Workspace", "Research.md"), { data: { research_type: "application-update", report_id: "RPT-2026-000001", _ownership: { sections: { Legacy: "ai-managed" } } }, content: "# Research\n" });
    const preview = await previewQualityBackfill(vault);
    assert.equal(preview.active_files, 1);
    assert.equal(preview.ownership_updates, 1);
    await applyQualityBackfill(vault);
    const updated = parseMarkdown(vault, path.join(vault, "20-Workspace", "Research.md"));
    assert.equal(updated.data.schema_version, 1);
    assert.equal((updated.data._ownership as JsonObject).sections !== undefined, true);
    assert.equal("Legacy" in ((updated.data._ownership as JsonObject).sections as JsonObject), false);
    assert.equal((await previewQualityBackfill(vault)).active_files, 0);
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("external link audit is independently resource-gated and deduplicated", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-external-link-audit-"));
  try {
    await initializeVault(vault, "disabled");
    writeMarkdown(vault, path.join(vault, "30-Knowledge", "Links.md"), { data: { title: "Links" }, content: "Bad https://example.invalid/missing and again https://example.invalid/missing\n" });
    await runExternalLinkAudit(vault, { now: "2026-07-28T00:00:00Z", fetcher: async () => new Response(null, { status: 404 }) });
    const repository = await QualityRepository.open(vault); const issues = repository.listIssues(); repository.close();
    assert.equal(issues.filter((item) => item.issue_type === "broken-external-link").length, 1);
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("prompt quality audit attributes review-rate regressions to an exact prompt version", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-prompt-quality-audit-"));
  try {
    await initializeVault(vault, "disabled"); const repository = await QualityRepository.open(vault);
    for (let index = 0; index < 5; index += 1) repository.recordMetric({ idempotency_key: `prompt-call:${index}`, event_type: "codex.completed", module: "experience-log", instance_id: null, workflow_id: "normalize", workflow_version: "1.0.0", prompt_id: "normalize-daily-log", prompt_version: "1.0.0", run_id: null, occurred_at: "2026-07-27T00:00:00Z", dimensions: {}, values: {} });
    for (let index = 0; index < 2; index += 1) repository.recordMetric({ idempotency_key: `prompt-review:${index}`, event_type: "review.created", module: "experience-log", instance_id: null, workflow_id: "normalize", workflow_version: "1.0.0", prompt_id: "normalize-daily-log", prompt_version: "1.0.0", run_id: null, occurred_at: "2026-07-27T00:00:00Z", dimensions: {}, values: {} });
    repository.close(); await runQualityAudit(vault, "weekly", { now: "2026-07-28T00:00:00Z" });
    const checked = await QualityRepository.open(vault); const issues = checked.listIssues(); checked.close();
    assert.equal(issues.some((item) => item.issue_type === "prompt-quality-regression" && item.target.prompt_id === "normalize-daily-log" && item.target.prompt_version === "1.0.0"), true);
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("quality audit turns enforced Read Level denials into a visible remediation issue", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-read-level-audit-"));
  try {
    await initializeVault(vault, "disabled");
    const runtime = await RuntimeRepository.open(vault);
    runtime.recordMetricEvent({ idempotency_key: "read-denied-1", event_type: "read.denied", module: "experience-log", instance_id: "internship-2026", workflow_id: "build-daily-log", workflow_version: "1.0.0", prompt_id: null, prompt_version: null, run_id: "RUN-READ-001", occurred_at: "2026-07-28T00:30:00Z", dimensions: { reason: "read-level-denied" }, values: {} });
    runtime.close();
    await runQualityAudit(vault, "daily", { now: "2026-07-28T01:00:00Z" });
    const quality = await QualityRepository.open(vault); const issues = quality.listIssues(); quality.close();
    assert.equal(issues.some((item) => item.issue_type === "read-level-denied" && item.module === "experience-log" && item.instance_id === "internship-2026"), true);
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});
