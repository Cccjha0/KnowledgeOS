import test from "node:test";
import assert from "node:assert/strict";
import type { ApplicationRecord, ResearchReport } from "../application/types.js";
import { compareApplicationUpdate } from "../application/compare.js";

const baseRecord: ApplicationRecord = {
  id: "APP-2026-0001",
  source_module: "application-tracker",
  instance_id: "australia-masters-2027",
  type: "application-record",
  institution: "Monash University",
  program_name: "Master of Artificial Intelligence",
  program_code: "C6007",
  country: "Australia",
  intake: "2027-02",
  application_status: "not-open",
  monitoring: {
    active: true,
    check_interval_days: 3,
    last_checked: "2026-07-22T10:00:00+09:00",
    next_check: "2026-07-25T10:00:00+09:00",
    stopped: [],
  },
  facts: {
    application_open: {
      value: false,
      status: "confirmed",
      confidence: 0.95,
      checked_at: "2026-07-22T10:00:00+09:00",
      source_refs: ["[[old-report]]"],
      notes: "not open",
    },
  },
  source_files: ["[[old-report]]"],
  created: "2026-07-22T10:00:00+09:00",
  updated: "2026-07-22T10:00:00+09:00",
  schema_version: 1,
};

function report(open: boolean): ResearchReport {
  return {
    report_id: open ? "RPT-2026-000003" : "RPT-2026-000002",
    research_type: "application-update",
    request_id: null,
    instance_id: "australia-masters-2027",
    institution: "Monash University",
    program_name: "Master of Artificial Intelligence",
    program_code: "C6007",
    intake: "2027-02",
    checked_at: "2026-07-27T12:00:00+09:00",
    material_change: open,
    confidence: 0.97,
    sources: [],
    findings: {
      application_open: {
        value: open,
        status: "confirmed",
        confidence: 0.97,
        source_ids: ["SRC-001"],
        notes: open ? "portal shows intake" : "not available",
      },
    },
    unresolved: [],
    summary: open ? "Application appears open." : "No change.",
  };
}

test("no-change updates timestamps without review", async () => {
  const result = await compareApplicationUpdate(baseRecord, report(false), {
    targetRecordPath: "Records/Monash-C6007.md",
    reportReference: "[[Research/report]]",
    now: "2026-07-27T06:00:00.000Z",
    allocateReviewId: async () => "REV-2026-000001",
  });
  assert.equal(result.material_change, false);
  assert.equal(result.review_items.length, 0);
  assert.equal(result.field_changes[0]?.action, "no-change");
});

test("critical change creates review and does not overwrite fact", async () => {
  const result = await compareApplicationUpdate(baseRecord, report(true), {
    targetRecordPath: "Records/Monash-C6007.md",
    reportReference: "[[Research/report]]",
    now: "2026-07-27T06:00:00.000Z",
    allocateReviewId: async () => "REV-2026-000001",
  });
  assert.equal(result.material_change, true);
  assert.equal(result.review_items.length, 1);
  assert.equal(result.field_changes[0]?.action, "review");
  const facts = result.frontmatter_patch.facts as Record<string, { value: boolean }>;
  assert.equal(facts.application_open?.value, false);
});

test("record-level aliases do not create duplicate facts or reviews", async () => {
  const incoming = report(false);
  incoming.findings = {
    course_code: { value: "C6007", status: "confirmed", confidence: 0.99, source_ids: ["SRC-001"], notes: "official code" },
    verified_date: { value: "2026-07-27", status: "confirmed", confidence: 0.99, source_ids: ["SRC-001"], notes: "checked today" },
    intake_month: { value: "February", status: "confirmed", confidence: 0.98, source_ids: ["SRC-001"], notes: "February intake" },
    intake_term: { value: "2027 Semester 1", status: "confirmed", confidence: 0.98, source_ids: ["SRC-001"], notes: "semester one" },
  };
  const result = await compareApplicationUpdate(baseRecord, incoming, {
    targetRecordPath: "Records/Monash-C6007.md", reportReference: "[[Research/report]]",
    now: "2026-07-27T06:00:00.000Z", allocateReviewId: async () => "REV-2026-000099",
  });
  assert.equal(result.review_items.length, 0);
  assert.equal(result.field_changes.every((change) => change.action === "no-change"), true);
  const facts = result.frontmatter_patch.facts as Record<string, unknown>;
  assert.equal("course_code" in facts, false);
  assert.equal("verified_date" in facts, false);
  assert.equal("intake_month" in facts, false);
  assert.equal("intake_term" in facts, false);
});

test("declared informational facts auto-update only with strong confirmed evidence", async () => {
  const incoming = report(false);
  incoming.findings = {
    campus: { value: "Clayton", status: "confirmed", confidence: 0.97, source_ids: ["SRC-001"], notes: "official campus" },
    accreditation: { value: "ACS", status: "confirmed", confidence: 0.9, source_ids: ["SRC-001"], notes: "low confidence extraction" },
    unexpected_field: { value: "keep in report", status: "confirmed", confidence: 1, source_ids: ["SRC-001"], notes: "not in contract" },
  };
  const result = await compareApplicationUpdate(baseRecord, incoming, {
    targetRecordPath: "Records/Monash-C6007.md", reportReference: "[[Research/report]]",
    now: "2026-07-27T06:00:00.000Z", allocateReviewId: async () => "REV-2026-000099",
  });
  assert.equal(result.review_items.length, 0);
  assert.deepEqual(result.field_changes.map((change) => change.action), ["auto-update", "ignore", "ignore"]);
  const facts = result.frontmatter_patch.facts as Record<string, { value: unknown }>;
  assert.equal(facts.campus?.value, "Clayton");
  assert.equal("accreditation" in facts, false);
  assert.equal("unexpected_field" in facts, false);
});
