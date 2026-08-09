import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseMarkdown, parseYaml, writeMarkdown, writeYaml } from "../core/bridge.js";
import { updateAssetAccessPolicy } from "../core/ingestion.js";
import { executeOperationPlan } from "../core/operationExecutor.js";
import type { JsonObject, OperationPlan } from "../core/types.js";
import { initializeVault } from "../core/vault.js";
import { createInstance, manageModule } from "../platform/lifecycleWorkflow.js";
import { syncInstalledConfiguration } from "../platform/configuration.js";
import { assertCodexRolePermitted, createModuleWorkflowRunner, operationPlanTypeForRecordMode } from "../modules/workflowRunner.js";
import { discoverInboxItems } from "../platform/inboxDiscovery.js";
import { materializeInboxAiTasks } from "../platform/inboxWorkflow.js";
import { dispatchOnce } from "../runtime/dispatcher.js";
import { RuntimeRepository } from "../runtime/repository.js";
import { locateReviewItem } from "../core/reviews.js";
import { decideReview } from "../platform/reviewWorkflow.js";
import { QualityRepository } from "../quality/repository.js";
import { runQualityAudit } from "../quality/audit.js";

function makePdf(text: string): Buffer {
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${text.replace(/[()\\]/g, "\\$&")}) Tj\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n%\xFF\xFF\xFF\xFF\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "binary"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, "binary");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "binary");
}

test("Blueprint record operation modes map only to executable Core operations", () => {
  assert.equal(operationPlanTypeForRecordMode("create-record"), "create-file");
  assert.equal(operationPlanTypeForRecordMode("update-record"), "update-frontmatter");
  assert.equal(operationPlanTypeForRecordMode("append-record"), "append-section");
  assert.throws(() => operationPlanTypeForRecordMode("replace-record"), /Unsupported Blueprint operation.type/);
});

test("Codex is denied at runtime when either role policy forbids it", () => {
  assert.throws(() => assertCodexRolePermitted(
    { asset_role: "private-diary" },
    { inbox: { asset_roles: { "private-diary": { allow_codex: false } } } },
    { role_policies: { "private-diary": { allow_codex: true } } },
  ), /does not permit Codex/);
  assert.throws(() => assertCodexRolePermitted(
    { asset_role: "private-diary" },
    { inbox: { asset_roles: { "private-diary": { allow_codex: true } } } },
    { role_policies: { "private-diary": { allow_codex: false } } },
  ), /does not permit Codex/);
  assert.doesNotThrow(() => assertCodexRolePermitted(
    { asset_role: "lecture-material" },
    { inbox: { asset_roles: { "lecture-material": { allow_codex: true } } } },
    { role_policies: { "lecture-material": { allow_codex: true } } },
  ));
});

test("a Blueprint review_when rule blocks the write, creates a Review, and executes only after approval", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-module-review-rule-"));
  try {
    await initializeVault(vault, "disabled");
    await manageModule(vault, { module_id: "course", action: "enable", preview_only: false });
    const instanceId = "course-review-2026";
    await createInstance(vault, {
      module_id: "course", instance_id: instanceId, display_name: "Course Review",
      fields: { course_code: "COMP9000", course_name: "Course Review", semester: "2026-S2", timezone: "Asia/Shanghai" },
    });
    const sourceRelative = `20-Workspace/课程管理/${instanceId}/Inbox/Assignments/brief.md`;
    const source = path.join(vault, ...sourceRelative.split("/"));
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, "# Essay brief\n\nPlease track the deadline.", "utf8");
    const repository = await RuntimeRepository.open(vault);
    const task = repository.createTask({
      job_id: `course.normalize-assignment.${instanceId}`, module: "course", instance_id: instanceId, task_type: "workflow", workflow: "course:normalize-assignment",
      priority: "high", scheduled_for: "2020-08-09T10:00:00.000Z", resources: { filesystem: "required", network: "not-required", codex: "required", user: "not-required" },
      trigger: { type: "inbox", workflow_id: "normalize-assignment", workflow_version: "1.0.0" }, catch_up_policy: "none", idempotency_key: `course:${instanceId}:review-rule`,
      payload: { source_file: sourceRelative, item_id: "assignment-001", asset_role: "assignment-brief" },
    }).task;
    repository.setResourceStatus({ resource: "codex", status: "available", reason: null, checked_at: new Date().toISOString(), details: { test: true } });
    repository.close();
    const output = {
      id: "ASSIGN-2026-000001", type: "course-assignment", schema_id: "assignment", schema_version: 1, module_version: "0.2.0-beta", instance_id: instanceId,
      title: "Essay", source_refs: [sourceRelative], created: "2026-08-09T18:00:00+08:00", updated: "2026-08-09T18:00:00+08:00", safe_summary: "Essay brief", status: "planned",
    };
    await dispatchOnce({ vaultRoot: vault, limit: 1, moduleWorkflowHandler: createModuleWorkflowRunner(async () => ({ output, stderr: "" })) });
    const after = await RuntimeRepository.open(vault);
    assert.equal(after.getTask(task.task_id)?.status, "waiting-for-user", JSON.stringify(after.getTask(task.task_id)?.last_error));
    after.close();
    const pending = await fs.readdir(path.join(vault, "90-System", "Review Queue", "Pending"));
    const reviewFile = pending.find((file) => parseMarkdown(vault, path.join(vault, "90-System", "Review Queue", "Pending", file)).data.origin_task_id === task.task_id);
    assert.ok(reviewFile, "The review rule must create a Review tied to this Task.");
    const reviewId = path.basename(reviewFile, ".md");
    const review = await locateReviewItem(vault, reviewId);
    assert.equal(review.item.action, "module-operation");
    assert.equal((review.item.proposed_value as JsonObject).field, "assignment.deadline");
    const target = path.join(vault, "20-Workspace", "课程管理", instanceId, "Assignments", "assignment-001.md");
    await assert.rejects(fs.access(target), "Review-gated output must not be written before a user decision.");
    const approved = { ...output, deadline: "2026-09-01T09:00:00+08:00" };
    await decideReview({ vaultRoot: vault, reviewId, decision: "approve-with-modification", modifiedValue: approved, userComment: "Confirmed the official deadline." });
    const approvedDocument = parseMarkdown(vault, target).data;
    assert.equal(approvedDocument.deadline, "2026-09-01T09:00:00+08:00");
    const deadlineMeta = ((approvedDocument._field_meta as JsonObject).deadline as JsonObject);
    assert.equal(deadlineMeta.authorship, "ai");
    assert.equal((deadlineMeta.verification as JsonObject).verification_interval_days, 7);
    assert.equal((deadlineMeta.verification as JsonObject).verification_status, "verified");
    assert.equal(Array.isArray(deadlineMeta.evidence_refs), true);
    assert.match(String((deadlineMeta.evidence_refs as string[])[0]), /^EVD-/);
    const quality = await QualityRepository.open(vault);
    const evidence = quality.getEvidence((deadlineMeta.evidence_refs as string[])[0]!);
    quality.close();
    assert.equal(evidence?.source_ref, sourceRelative, "Evidence must refer to a Core-authorized input, never a model-supplied source_ref.");
    const staleAfter = String((deadlineMeta.verification as JsonObject).stale_after);
    await runQualityAudit(vault, "weekly", { now: new Date(Date.parse(staleAfter) + 1).toISOString() });
    const afterAudit = await QualityRepository.open(vault);
    const issues = afterAudit.listIssues(); afterAudit.close();
    assert.equal(issues.some((entry) => entry.issue_type === "missing-provenance" && entry.target.field === "deadline"), false);
    assert.equal(issues.some((entry) => entry.issue_type === "stale-critical-field" && entry.target.field === "deadline"), true, "Field metadata must enter the verified → stale lifecycle.");
    const completed = await RuntimeRepository.open(vault);
    assert.equal(completed.getTask(task.task_id)?.status, "completed");
    completed.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("a green module operation replaces model provenance with Core-authorized evidence", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-module-field-provenance-"));
  try {
    await initializeVault(vault, "disabled");
    await manageModule(vault, { module_id: "course", action: "enable", preview_only: false });
    const instanceId = "course-provenance-2026";
    await createInstance(vault, {
      module_id: "course", instance_id: instanceId, display_name: "Course Provenance",
      fields: { course_code: "COMP9000", course_name: "Course Provenance", semester: "2026-S2", timezone: "Asia/Shanghai" },
    });
    const sourceRelative = `20-Workspace/课程管理/${instanceId}/Inbox/Assignments/brief.md`;
    const source = path.join(vault, ...sourceRelative.split("/"));
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, "# Essay brief\n\nDeadline: 2026-09-01.", "utf8");
    const repository = await RuntimeRepository.open(vault);
    const task = repository.createTask({
      job_id: `course.normalize-assignment.${instanceId}`, module: "course", instance_id: instanceId, task_type: "workflow", workflow: "course:normalize-assignment",
      priority: "high", scheduled_for: "2020-08-09T10:00:00.000Z", resources: { filesystem: "required", network: "not-required", codex: "required", user: "not-required" },
      trigger: { type: "inbox", workflow_id: "normalize-assignment", workflow_version: "1.0.0" }, catch_up_policy: "none", idempotency_key: `course:${instanceId}:field-provenance`,
      payload: { source_file: sourceRelative, item_id: "assignment-provenance", asset_role: "assignment-brief" },
    }).task;
    repository.setResourceStatus({ resource: "codex", status: "available", reason: null, checked_at: new Date().toISOString(), details: { test: true } });
    repository.close();
    const output = {
      id: "ASSIGN-2026-000099", type: "course-assignment", schema_id: "assignment", schema_version: 1, module_version: "0.3.0-beta", instance_id: instanceId,
      title: "Essay", source_refs: ["fabricated-source.md"], created: "2026-08-09T18:00:00+08:00", updated: "2026-08-09T18:00:00+08:00", safe_summary: "Essay brief",
      deadline: "2026-09-01T09:00:00+08:00", status: "planned",
      _field_meta: { deadline: { authorship: "ai", evidence_refs: ["EVD-2099-999999"], verification: { last_verified: "2099-01-01T00:00:00Z" } } },
    };
    await dispatchOnce({ vaultRoot: vault, limit: 1, moduleWorkflowHandler: createModuleWorkflowRunner(async () => ({ output, stderr: "" })) });
    const after = await RuntimeRepository.open(vault); assert.equal(after.getTask(task.task_id)?.status, "completed"); after.close();
    const target = path.join(vault, "20-Workspace", "课程管理", instanceId, "Assignments", "assignment-provenance.md");
    const data = parseMarkdown(vault, target).data;
    assert.deepEqual(data.source_refs, [sourceRelative]);
    const deadlineMeta = ((data._field_meta as JsonObject).deadline as JsonObject);
    assert.notEqual((deadlineMeta.evidence_refs as string[])[0], "EVD-2099-999999");
    assert.equal((deadlineMeta.verification as JsonObject).verification_interval_days, 7);
    const quality = await QualityRepository.open(vault);
    assert.equal(quality.getEvidence((deadlineMeta.evidence_refs as string[])[0]!)?.source_ref, sourceRelative);
    quality.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("Core forces Review for a Critical update and strips model-controlled system fields", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-critical-update-"));
  try {
    await initializeVault(vault, "disabled");
    await syncInstalledConfiguration(vault);
    await manageModule(vault, { module_id: "course", action: "enable", preview_only: false });
    const instanceId = "course-critical-update-2026";
    await createInstance(vault, {
      module_id: "course", instance_id: instanceId, display_name: "Course Critical Update",
      fields: { course_code: "COMP9000", course_name: "Course Critical Update", semester: "2026-S2", timezone: "Asia/Shanghai" },
    });
    const contentRoot = `20-Workspace/课程管理/${instanceId}`;
    const targetRelative = `${contentRoot}/Assignments/assignment-update.md`;
    const target = path.join(vault, ...targetRelative.split("/"));
    const original = {
      id: "ASSIGN-ORIGINAL", type: "course-assignment", schema_id: "assignment", schema_version: 1, module_version: "0.3.0-beta", instance_id: instanceId,
      title: "Essay", source_refs: [], generation: null, created: "2026-08-01T00:00:00Z", updated: "2026-08-01T00:00:00Z", safe_summary: "Original essay",
      deadline: "2026-09-01T09:00:00+08:00", status: "planned",
    };
    await fs.mkdir(path.dirname(target), { recursive: true });
    writeMarkdown(vault, target, { data: original, content: "# Essay\n" });
    const installed = JSON.parse(await fs.readFile(path.join(vault, "90-System", "Modules", "installed.json"), "utf8")) as { modules: Array<{ id: string; installed_path: string }> };
    const installedCourse = installed.modules.find((entry) => entry.id === "course")!;
    const workflowPath = path.join(vault, ...installedCourse.installed_path.split("/"), "workflows", "normalize-assignment", "v1.0.0.yaml");
    const workflow = parseYaml(vault, workflowPath);
    (((workflow.steps as JsonObject[]).find((step) => step.uses === "core.build-operation-plan")!.with as JsonObject).operation_type) = "update-record";
    writeYaml(vault, workflowPath, workflow);
    const sourceRelative = `${contentRoot}/Inbox/Assignments/update.md`;
    const source = path.join(vault, ...sourceRelative.split("/"));
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, "# Updated assignment brief\n", "utf8");
    const repository = await RuntimeRepository.open(vault);
    const task = repository.createTask({
      job_id: `course.update-assignment.${instanceId}`, module: "course", instance_id: instanceId, task_type: "workflow", workflow: "course:normalize-assignment",
      priority: "high", scheduled_for: "2020-08-09T10:00:00.000Z", resources: { filesystem: "required", network: "not-required", codex: "required", user: "not-required" },
      trigger: { type: "inbox", workflow_id: "normalize-assignment", workflow_version: "1.0.0" }, catch_up_policy: "none", idempotency_key: `course:${instanceId}:critical-update`,
      payload: { source_file: sourceRelative, item_id: "assignment-update", asset_role: "assignment-brief" },
    }).task;
    repository.setResourceStatus({ resource: "codex", status: "available", reason: null, checked_at: new Date().toISOString(), details: { test: true } }); repository.close();
    const output = {
      ...original,
      id: "ASSIGN-MODEL-OVERRIDE", module_version: "99.0.0", created: "2099-01-01T00:00:00Z", instance_id: "other-instance",
      deadline: "2026-09-15T09:00:00+08:00", status: "submitted", updated: "2099-01-01T00:00:00Z",
    };
    await dispatchOnce({ vaultRoot: vault, limit: 1, moduleWorkflowHandler: createModuleWorkflowRunner(async () => ({ output, stderr: "" })) });
    const after = await RuntimeRepository.open(vault); assert.equal(after.getTask(task.task_id)?.status, "waiting-for-user"); after.close();
    assert.equal(parseMarkdown(vault, target).data.deadline, original.deadline, "Critical fields must not change before approval.");
    const pending = await fs.readdir(path.join(vault, "90-System", "Review Queue", "Pending"));
    const reviewId = path.basename(pending.find((file) => parseMarkdown(vault, path.join(vault, "90-System", "Review Queue", "Pending", file)).data.origin_task_id === task.task_id)!, ".md");
    const review = await locateReviewItem(vault, reviewId);
    assert.equal(((review.item.proposed_value as JsonObject).matching_rules as JsonObject[]).some((rule) => rule.condition === "critical-field-update"), true);
    await decideReview({ vaultRoot: vault, reviewId, decision: "approve" });
    const updated = parseMarkdown(vault, target).data;
    assert.equal(updated.deadline, output.deadline);
    assert.equal(updated.status, output.status);
    assert.equal(updated.id, original.id);
    assert.equal(updated.instance_id, original.instance_id);
    assert.equal(updated.module_version, original.module_version);
    assert.equal(updated.created, original.created);
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("update-record and append-record use controlled executable Operations", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-record-operation-modes-"));
  try {
    await initializeVault(vault, "disabled");
    const target = "20-Workspace/Journal/demo/Entries/today.md";
    const absolute = path.join(vault, ...target.split("/"));
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    writeMarkdown(vault, absolute, { data: { title: "Before", _ownership: { sections: { "AI Updates": "ai-managed" } } }, content: "# Today\n" });
    const plan = (planId: string, operation: OperationPlan["operations"][number]): OperationPlan => ({
      plan_id: planId, task_id: "TASK-2026-000901", source_module: "reading-log", instance_id: "demo", summary: "Test record operation mode", operations: [operation], review_items: [],
    });
    await executeOperationPlan(vault, plan("PLAN-2026-000901", {
      operation_id: "OP-001", type: operationPlanTypeForRecordMode("update-record"), target, risk: "green", confidence: 1,
      idempotency_key: "test:update-record:000901", requires_review_id: null, payload: { patch: { title: "After" }, replace_top_level: ["title"], actor: "ai" },
    }), { allowedTypes: ["update-frontmatter"], allowedTargets: [target], requiredReviewId: null });
    const append = plan("PLAN-2026-000902", {
      operation_id: "OP-001", type: operationPlanTypeForRecordMode("append-record"), target, risk: "green", confidence: 1,
      idempotency_key: "test:append-record:000902", requires_review_id: null,
      payload: { section: "AI Updates", content: "Normalized journal entry.", marker: "test:append-record:000902", actor: "ai" },
    });
    await executeOperationPlan(vault, append, { allowedTypes: ["append-section"], allowedTargets: [target], requiredReviewId: null });
    await executeOperationPlan(vault, append, { allowedTypes: ["append-section"], allowedTargets: [target], requiredReviewId: null });
    const document = parseMarkdown(vault, absolute);
    assert.equal(document.data.title, "After");
    assert.equal((document.content.match(/Normalized journal entry\./g) ?? []).length, 1, "Append mode remains idempotent through the Core ledger and section marker.");
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("a declared experience-log workflow executes through the generic Runner without a platform Handler", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-module-workflow-runner-"));
  try {
    await initializeVault(vault, "disabled");
    const instanceId = "internship-2026";
    await createInstance(vault, {
      module_id: "experience-log", instance_id: instanceId, display_name: "Internship 2026",
      fields: { organization: "Example", role: "Intern", start_date: "2026-01-01", end_date: null, timezone: "Asia/Shanghai" },
    });
    const dailyPath = path.join(vault, "20-Workspace", "Experience Log", instanceId, "Daily", "2026-07-27.md");
    await fs.mkdir(path.dirname(dailyPath), { recursive: true });
    await fs.writeFile(dailyPath, [
      "---", "daily_id: DAY-2026-07-27", "type: experience-daily-log", `instance_id: ${instanceId}`, "date: 2026-07-27", "entry_ids: [EXP-2026-000001]",
      "accomplishments: [Implemented the workflow runner]", "blockers: []", "learnings: [Keep execution declarative]", "next_actions: [Add tests]",
      `source_refs: [20-Workspace/Experience Log/${instanceId}/Inbox/entry.md]`, "created_at: '2026-07-27T18:00:00+08:00'", "schema_version: 1", "---", "", "# Daily", "",
    ].join("\n"), "utf8");
    const output = {
      summary_id: "WEEK-2026-W31", type: "experience-weekly-summary", instance_id: instanceId, week: "2026-W31",
      period_start: "2026-07-27", period_end: "2026-08-02", daily_log_ids: ["DAY-2026-07-27"], highlights: ["Implemented the workflow runner"],
      progress: ["Module workflows now execute"], blockers: [], learnings: ["Use registries at runtime"], next_week: ["Add capture routing"],
      source_refs: [`20-Workspace/Experience Log/${instanceId}/Daily/2026-07-27.md`], created_at: "2026-07-31T18:00:00+08:00", schema_version: 1,
    };

    const repository = await RuntimeRepository.open(vault);
    const task = repository.createTask({
      job_id: `experience-log.weekly-summary.${instanceId}`, module: "experience-log", instance_id: instanceId,
      task_type: "workflow", workflow: "experience-log:weekly-summary", priority: "normal",
      scheduled_for: "2026-07-31T10:00:00.000Z",
      resources: { filesystem: "required", network: "not-required", codex: "required", user: "not-required" },
      trigger: { type: "weekly", workflow_id: "build-weekly-summary", workflow_version: "1.0.0", timezone: "Asia/Shanghai" },
      catch_up_policy: "latest", idempotency_key: "experience-log:internship-2026:weekly:2026-W31",
    }).task;
    repository.setResourceStatus({ resource: "codex", status: "available", reason: null, checked_at: new Date().toISOString(), details: { test: true } });
    repository.close();

    let contextRoot = "";
    let request = "";
    const runner = createModuleWorkflowRunner(async (options) => {
      contextRoot = options.contextRoot;
      request = options.prompt;
      assert.notEqual(contextRoot, vault, "Codex must not run with the real Vault as its working directory");
      assert.match(await fs.readFile(path.join(contextRoot, "primary-input.md"), "utf8"), /Implemented the workflow runner/);
      assert.match(await fs.readFile(path.join(contextRoot, "module-prompt.md"), "utf8"), /weekly-summary/);
      const manifest = JSON.parse(await fs.readFile(path.join(contextRoot, "context-manifest.json"), "utf8")) as { primary_input: { sensitivity_class: number; requested_representation: string; representation: string; policy_source: string }; budget: { max_files: number; max_total_bytes: number; max_file_bytes: number; max_estimated_tokens: number; overflow_policy: string; candidate_files: number; included_files: number; excluded_file_count: number; truncated_file_count: number; review_required: boolean } };
      assert.equal(manifest.primary_input.sensitivity_class, 0);
      assert.equal(manifest.primary_input.requested_representation, "full", "Workflow declaration must be preserved in the Context manifest");
      assert.equal(manifest.primary_input.representation, "full");
      assert.equal(manifest.primary_input.policy_source, "default");
      assert.equal(manifest.budget.max_files, 50);
      assert.equal(manifest.budget.max_total_bytes, 500000);
      assert.equal(manifest.budget.max_file_bytes, 50000);
      assert.equal(manifest.budget.max_estimated_tokens, 125000);
      assert.equal(manifest.budget.overflow_policy, "truncate-and-review");
      assert.deepEqual({ candidate_files: manifest.budget.candidate_files, included_files: manifest.budget.included_files, excluded_file_count: manifest.budget.excluded_file_count, truncated_file_count: manifest.budget.truncated_file_count, review_required: manifest.budget.review_required }, { candidate_files: 1, included_files: 1, excluded_file_count: 0, truncated_file_count: 0, review_required: false });
      return { output, stderr: "" };
    });
    const dispatched = await dispatchOnce({ vaultRoot: vault, limit: 1, moduleWorkflowHandler: runner });
    assert.equal(dispatched.completed, 1, JSON.stringify(dispatched.tasks[0]?.last_error));
    const weeklyPath = path.join(vault, "20-Workspace", "Experience Log", instanceId, "Weekly", "2026-W31.md");
    assert.equal(parseMarkdown(vault, weeklyPath).data.type, "experience-weekly-summary");
    assert.equal((parseMarkdown(vault, weeklyPath).data.generation as { prompt?: { id?: string } }).prompt?.id, "weekly-summary");
    assert.doesNotMatch(request, /Implemented the workflow runner/, "document bodies belong in the isolated context workspace, not the process prompt");
    await assert.rejects(fs.access(contextRoot), "temporary context workspace should not remain after the Codex call");

    const after = await RuntimeRepository.open(vault);
    assert.equal(after.getTask(task.task_id)?.status, "completed");
    assert.equal(after.listCodexInvocations(task.task_id)[0]?.prompt_id, "weekly-summary");
    after.close();
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test("a workflow module Inbox item materializes a generic capture Task", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-module-workflow-inbox-"));
  try {
    await initializeVault(vault, "disabled");
    const instanceId = "internship-inbox-2026";
    await createInstance(vault, {
      module_id: "experience-log", instance_id: instanceId, display_name: "Internship Inbox",
      fields: { organization: "Example", role: "Intern", start_date: "2026-01-01", end_date: null, timezone: "Asia/Shanghai" },
    });
    const source = path.join(vault, "20-Workspace", "Experience Log", instanceId, "Inbox", "notes.md");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, "# Monday\n\nFinished the onboarding checklist and documented the deployment process.\n", "utf8");

    const inboxItem = (await discoverInboxItems(vault)).find((item) => item.path.endsWith("/Inbox/notes.md"));
    assert.equal(inboxItem?.required_representation, "full", "Inbox presentation must be inferred from the declared capture Workflow.");
    const materialized = await materializeInboxAiTasks(vault);
    assert.equal(materialized.created.length, 1);
    const repository = await RuntimeRepository.open(vault);
    const task = repository.getTask(materialized.created[0]!);
    assert.equal(task?.workflow, "module:experience-log:capture");
    assert.equal(task?.trigger.entrypoint, "capture");
    assert.equal(task?.resources.codex, "required", "Inbox task resources must come from the capture Workflow");
    repository.close();
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test("a configuration module uses the same generic Runner for an Inbox capture", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-module-config-runner-"));
  try {
    await initializeVault(vault, "disabled");
    const instanceId = "reading-2026";
    await createInstance(vault, {
      module_id: "reading-log", instance_id: instanceId, display_name: "Reading 2026",
      fields: { timezone: "Asia/Shanghai" },
    });
    const sourceRelative = `20-Workspace/Reading Log/${instanceId}/Inbox/paper.md`;
    const source = path.join(vault, ...sourceRelative.split("/"));
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, "# A practical paper\n\nNotes about the paper's method and a question to revisit.\n", "utf8");

    const materialized = await materializeInboxAiTasks(vault);
    assert.equal(materialized.created.length, 1);
    const repository = await RuntimeRepository.open(vault);
    const task = repository.getTask(materialized.created[0]!);
    assert.equal(task?.workflow, "module:reading-log:capture");
    repository.setResourceStatus({ resource: "codex", status: "available", reason: null, checked_at: new Date().toISOString(), details: { test: true } });
    repository.close();

    const output = {
      id: "READ-2026-000001", type: "reading-note", schema_id: "record", schema_version: 1, module_version: "0.1.0", instance_id: instanceId,
      title: "A practical paper", source_refs: [sourceRelative], created: "2026-08-04T10:00:00+08:00", updated: "2026-08-04T10:00:00+08:00",
    };
    const dispatched = await dispatchOnce({ vaultRoot: vault, limit: 1, moduleWorkflowHandler: createModuleWorkflowRunner(async () => ({ output, stderr: "" })) });
    assert.equal(dispatched.completed, 1);
    const note = path.join(vault, "20-Workspace", "Reading Log", instanceId, "Notes", `${String(task!.payload.item_id)}.md`);
    assert.equal(parseMarkdown(vault, note).data.type, "reading-note");
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test("a module policy that allows partial PDFs reaches the Runner, Codex Context, and completed Run", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-partial-pdf-allow-"));
  try {
    await initializeVault(vault, "disabled");
    const instanceId = "reading-partial-pdf";
    await createInstance(vault, { module_id: "reading-log", instance_id: instanceId, display_name: "Partial PDF reading", fields: { timezone: "Asia/Shanghai" } });
    const sourceRelative = `20-Workspace/Reading Log/${instanceId}/Inbox/partial-paper.pdf`;
    await fs.writeFile(path.join(vault, ...sourceRelative.split("/")), makePdf("A".repeat(55_000)));

    const first = await materializeInboxAiTasks(vault);
    const repository = await RuntimeRepository.open(vault);
    const waiting = repository.getTask(first.created[0]!);
    assert.equal(waiting?.status, "waiting-for-user", "The user must classify a new attachment before any PDF policy can permit content.");
    const capturePath = String((waiting?.payload.ingestion as JsonObject).capture_path);
    repository.close();
    await updateAssetAccessPolicy(vault, capturePath, { sensitivity_class: 0, max_representation: "full" });

    const second = await materializeInboxAiTasks(vault);
    assert.equal(second.deduplicated, 1, "Classification resumes the same idempotent Task rather than creating a duplicate.");
    const queuedRepository = await RuntimeRepository.open(vault);
    const queued = queuedRepository.getTask(first.created[0]!);
    assert.equal(queued?.status, "queued");
    assert.deepEqual(queued?.payload.pdf_policy, { accepted_statuses: ["completed", "partial"], partial_policy: "allow" });
    queuedRepository.setResourceStatus({ resource: "codex", status: "available", reason: null, checked_at: new Date().toISOString(), details: { test: true } });
    queuedRepository.close();

    let runtimeContext: JsonObject = {};
    const output = {
      id: "READ-2026-000002", type: "reading-note", schema_id: "record", schema_version: 1, module_version: "0.2.0-beta", instance_id: instanceId,
      title: "Partial paper", source_refs: [sourceRelative], created: "2026-08-06T10:00:00+08:00", updated: "2026-08-06T10:00:00+08:00",
    };
    const dispatched = await dispatchOnce({ vaultRoot: vault, limit: 1, moduleWorkflowHandler: createModuleWorkflowRunner(async (options) => {
      runtimeContext = JSON.parse(await fs.readFile(path.join(options.contextRoot, "runtime-context.json"), "utf8")) as JsonObject;
      return { output, stderr: "" };
    }) });
    const diagnosticRepository = await RuntimeRepository.open(vault);
    const diagnosticTask = diagnosticRepository.getTask(first.created[0]!);
    diagnosticRepository.close();
    assert.equal(dispatched.completed, 1, JSON.stringify({ status: diagnosticTask?.status, error: diagnosticTask?.last_error }));
    const pdfInputs = runtimeContext.pdf_inputs as Array<JsonObject>;
    assert.equal(pdfInputs[0]?.extraction_status, "partial");
    assert.equal(pdfInputs[0]?.usable, true);
    assert.deepEqual(pdfInputs[0]?.policy, { accepted_statuses: ["completed", "partial"], partial_policy: "allow" });
    const completedRepository = await RuntimeRepository.open(vault);
    const completed = completedRepository.getTask(first.created[0]!);
    const run = completedRepository.getRuns(first.created[0]!)[0];
    completedRepository.close();
    assert.equal(completed?.status, "completed");
    assert.equal((run?.metrics.pdf_inputs as Array<JsonObject>)[0]?.usable, true, "Run metrics preserve the actual PDF policy decision.");
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("a sensitive document stops at waiting-for-user before Codex receives it", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-read-level-gate-"));
  try {
    await initializeVault(vault, "disabled");
    const instanceId = "reading-sensitive-2026";
    await createInstance(vault, { module_id: "reading-log", instance_id: instanceId, display_name: "Sensitive Reading", fields: { timezone: "Asia/Shanghai" } });
    const source = path.join(vault, "20-Workspace", "Reading Log", instanceId, "Inbox", "private.md");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, "---\nread_level: 3\n---\n\n# Private source\n\nSensitive original text.\n", "utf8");
    const materialized = await materializeInboxAiTasks(vault);
    const repository = await RuntimeRepository.open(vault);
    repository.setResourceStatus({ resource: "codex", status: "available", reason: null, checked_at: new Date().toISOString(), details: { test: true } });
    repository.close();
    let codexCalled = false;
    await dispatchOnce({ vaultRoot: vault, limit: 1, moduleWorkflowHandler: createModuleWorkflowRunner(async () => { codexCalled = true; return { output: {}, stderr: "" }; }) });
    assert.equal(codexCalled, false);
    const checked = await RuntimeRepository.open(vault); const task = checked.getTask(materialized.created[0]!); checked.close();
    assert.equal(task?.status, "waiting-for-user");
    assert.equal(task?.last_error?.code, "MODULE_READ_DENIED");
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("a restrictive document representation policy stops a full-content Workflow before Codex receives it", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-representation-gate-"));
  try {
    await initializeVault(vault, "disabled");
    const instanceId = "reading-restricted-2026";
    await createInstance(vault, { module_id: "reading-log", instance_id: instanceId, display_name: "Restricted Reading", fields: { timezone: "Asia/Shanghai" } });
    const source = path.join(vault, "20-Workspace", "Reading Log", instanceId, "Inbox", "metadata-only.md");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, "---\nsensitivity_class: 0\naccess_policy:\n  max_representation: metadata\n---\n\n# Restricted source\n\nThe body must not reach Codex.\n", "utf8");
    const materialized = await materializeInboxAiTasks(vault);
    const repository = await RuntimeRepository.open(vault);
    repository.setResourceStatus({ resource: "codex", status: "available", reason: null, checked_at: new Date().toISOString(), details: { test: true } });
    repository.close();
    let codexCalled = false;
    await dispatchOnce({ vaultRoot: vault, limit: 1, moduleWorkflowHandler: createModuleWorkflowRunner(async () => { codexCalled = true; return { output: {}, stderr: "" }; }) });
    assert.equal(codexCalled, false);
    const checked = await RuntimeRepository.open(vault); const task = checked.getTask(materialized.created[0]!); checked.close();
    assert.equal(task?.status, "waiting-for-user");
    assert.equal(task?.last_error?.code, "DOCUMENT_REPRESENTATION_DENIED");
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("application due-research work runs as a declared module workflow without a Platform Handler", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-module-due-research-"));
  try {
    await initializeVault(vault, "disabled");
    const instanceId = "applications-2027";
    await createInstance(vault, {
      module_id: "application-tracker", instance_id: instanceId, display_name: "Applications 2027",
      fields: { application_type: "masters", region: "Australia", intake: "2027-S1", default_currency: "AUD", "monitoring.enabled": true, "monitoring.default_check_interval_days": 30 },
    });
    const record = path.join(vault, "20-Workspace", "Applications", instanceId, "Records", "Monash-C6007.md");
    await fs.mkdir(path.dirname(record), { recursive: true });
    writeMarkdown(vault, record, { data: {
      id: "APP-2027-0001", source_module: "application-tracker", instance_id: instanceId, type: "application-record",
      institution: "Monash University", program_name: "Master of Artificial Intelligence", program_code: "C6007", country: "AU", intake: "2027-S1", application_status: "watching",
      monitoring: { active: true, check_interval_days: 30, last_checked: null, next_check: "2020-01-01T00:00:00Z", stopped: [] }, facts: {}, source_files: [],
      created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z", schema_version: 1,
    }, content: "# Monash C6007\n" });
    const repository = await RuntimeRepository.open(vault);
    const task = repository.createTask({
      job_id: "application-tracker.due-research-check", module: "application-tracker", instance_id: null, task_type: "workflow", workflow: "module:application-tracker:sync-due-research", priority: "normal",
      resources: { filesystem: "required", network: "not-required", codex: "not-required", user: "not-required" },
      trigger: { type: "field-due", workflow_id: "sync-due-research", workflow_version: "1.0.0" }, catch_up_policy: "latest", idempotency_key: "application:due-research:test",
    }).task;
    repository.close();
    const dispatched = await dispatchOnce({ vaultRoot: vault, limit: 1 });
    assert.equal(dispatched.completed, 1);
    const requestRoot = path.join(vault, "20-Workspace", "Applications", instanceId, "Research Requests");
    assert.equal((await fs.readdir(requestRoot)).filter((file) => file.endsWith(".md")).length, 1);
    const events = await RuntimeRepository.open(vault);
    const event = events.listEvents().find((candidate) => candidate.event_type === "research.required");
    assert.equal(event?.status, "published");
    assert.equal(typeof (event?.payload as JsonObject).entity_id, "string");
    assert.equal("created" in (event?.payload as JsonObject), false);
    events.close();
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});
