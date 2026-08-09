import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compareApplicationUpdate } from "../application/compare.js";
import { collectModuleDashboardItems } from "../modules/dashboardProvider.js";
import { applyReportToResearchRequest, createResearchRequest, researchRequestKey } from "../application/researchRequest.js";
import { assertApplicationTransition } from "../application/stateMachine.js";
import { writeMarkdown } from "../core/bridge.js";
import { initializeVault } from "../core/vault.js";
import { startResearchRequest, syncDueResearchRequests } from "../platform/researchRequestWorkflow.js";
import type { ApplicationRecord, ResearchReport } from "../types.js";

function record(id: string, instance: string, status: ApplicationRecord["application_status"] = "open"): ApplicationRecord {
  return {
    id, source_module: "application-tracker", instance_id: instance, type: "application-record",
    institution: `University ${id}`, program_name: `Program ${id}`, program_code: null,
    country: "AU", intake: "2027-S1", application_status: status,
    monitoring: { active: true, check_interval_days: 7, last_checked: null, next_check: "2026-07-20T00:00:00Z", stopped: [] },
    facts: {}, source_files: [], created: "2026-07-01T00:00:00Z", updated: "2026-07-01T00:00:00Z", schema_version: 1,
  };
}

function report(requestId: string, reportId: string, unresolved: string[]): ResearchReport {
  return {
    report_id: reportId, research_type: "application-update", request_id: requestId, instance_id: "instance-a",
    institution: "University", program_name: "Program", program_code: null, intake: "2027-S1",
    checked_at: "2026-07-27T00:00:00Z", material_change: false, confidence: 1,
    sources: [], findings: {}, unresolved, summary: "Checked",
  };
}

test("application state machine accepts the main path and rejects skips", () => {
  assert.doesNotThrow(() => assertApplicationTransition("open", "preparing"));
  assert.doesNotThrow(() => assertApplicationTransition("awaiting-result", "conditional-offer"));
  assert.throws(() => assertApplicationTransition("open", "submitted"), /cannot move/);
});

test("research cannot infer prior-confirmation fields", async () => {
  const base = record("APP-2026-0101", "instance-a", "preparing");
  base.facts.submitted_at = { value: null, status: "unknown", confidence: 0, checked_at: null, source_refs: [], notes: "" };
  const incoming = report("REQ-2026-000001", "RPT-2026-000001", []);
  incoming.findings.submitted_at = { value: "2026-07-27T00:00:00Z", status: "confirmed", confidence: 1, source_ids: [], notes: "portal evidence" };
  const result = await compareApplicationUpdate(base, incoming, {
    targetRecordPath: "Records/app.md", reportReference: "[[report]]", now: "2026-07-27T00:00:00Z",
    allocateReviewId: async () => "REV-2026-000001",
  });
  assert.equal(result.field_changes[0]?.action, "user-confirmation-required");
  assert.equal(result.review_items.length, 1);
  assert.equal(result.review_items[0]?.action, "confirm-user-action");
  assert.equal((result.frontmatter_patch.facts as Record<string, { value: unknown }>).submitted_at?.value, null);
});

test("one Research Request accepts multiple reports until evidence is complete", () => {
  const base = record("APP-2026-0101", "instance-a");
  const request = createResearchRequest(base, "Records/app.md", "REQ-2026-000001", "2026-07-27T00:00:00Z");
  const partial = applyReportToResearchRequest(request, report(request.request_id, "RPT-2026-000001", ["deadline"]), "2026-07-27T01:00:00Z");
  assert.equal(partial.status, "needs-more-information");
  const complete = applyReportToResearchRequest(partial, report(request.request_id, "RPT-2026-000002", []), "2026-07-27T02:00:00Z");
  assert.equal(complete.status, "completed");
  assert.deepEqual(complete.report_ids, ["RPT-2026-000001", "RPT-2026-000002"]);
});

test("due-request sync handles multiple projects and is idempotent", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-multi-application-"));
  try {
    await initializeVault(vault, "disabled", ["20-Workspace/Applications/Inbox"]);
    for (const [id, instance] of [["APP-2026-0101", "instance-a"], ["APP-2026-0102", "instance-b"]] as const) {
      const directory = path.join(vault, "20-Workspace", "Applications", instance, "Records");
      await fs.mkdir(directory, { recursive: true });
      writeMarkdown(vault, path.join(directory, `${id}.md`), { data: record(id, instance), content: `# ${id}\n` });
    }
    const first = await syncDueResearchRequests(vault, "2026-07-27T00:00:00Z");
    const started = await startResearchRequest(vault, first.created[0]!, "2026-07-27T01:00:00Z");
    const second = await syncDueResearchRequests(vault, "2026-07-27T00:00:00Z");
    assert.equal(first.created.length, 2);
    assert.equal(started.status, "in-progress");
    assert.equal(second.created.length, 0);
    assert.equal(second.existing.length, 2);
    assert.notEqual(researchRequestKey(record("APP-2026-0101", "instance-a")), researchRequestKey(record("APP-2026-0102", "instance-b")));
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test("an open Research Request replaces the overdue application action in Today", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-application-dashboard-"));
  try {
    await initializeVault(vault, "disabled", ["20-Workspace/Applications/instance-a/Inbox"]);
    const instanceDirectory = path.join(vault, "90-System", "Instances", "instance-a");
    await fs.mkdir(instanceDirectory, { recursive: true });
    await fs.writeFile(path.join(instanceDirectory, "instance.yaml"), [
      "instance_id: instance-a",
      "module_id: application-tracker",
      "status: active",
      "display_name: Applications",
      "content_root: 20-Workspace/Applications/instance-a",
      "inbox_path: 20-Workspace/Applications/instance-a/Inbox",
      "created: \"2026-07-01T00:00:00Z\"",
      "updated: \"2026-07-01T00:00:00Z\"",
      "",
    ].join("\n"), "utf8");

    const application = record("APP-2026-0101", "instance-a");
    application.institution = "Monash University";
    application.program_name = "Master of Information Technology";
    application.monitoring.next_check = "2000-01-01T00:00:00Z";
    const recordPath = path.join(vault, "20-Workspace", "Applications", "instance-a", "Records", "Monash.md");
    await fs.mkdir(path.dirname(recordPath), { recursive: true });
    writeMarkdown(vault, recordPath, { data: application, content: "# Monash\n" });

    const request = createResearchRequest(application, "20-Workspace/Applications/instance-a/Records/Monash.md", "REQ-2026-000001", "2026-07-30T00:00:00Z");
    const requestPath = path.join(vault, "20-Workspace", "Applications", "instance-a", "Research Requests", "REQ-2026-000001.md");
    await fs.mkdir(path.dirname(requestPath), { recursive: true });
    writeMarkdown(vault, requestPath, { data: request, content: "# Research Request\n" });

    const items = await collectModuleDashboardItems(vault, Date.parse("2026-07-30T00:00:00Z"));
    const project = items.find((item) => item.item_id.includes("current-project"));
    const requestItem = items.find((item) => item.item_id.includes("research-request"));
    assert.equal(project?.category, "status");
    assert.equal(project?.due_at, null);
    assert.match(project?.description ?? "", /2000-01-01/);
    assert.match(requestItem?.title ?? "", /REQ-2026-000001/);
    assert.match(requestItem?.description ?? "", /application_open/);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});
