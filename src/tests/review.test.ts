import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { decideReview, reconcileReviews } from "../platform/reviewWorkflow.js";
import { parseMarkdown, writeMarkdown } from "../core/bridge.js";
import { writeReviewItems } from "../core/reviews.js";
import { initializeVault } from "../core/vault.js";
import type { ApplicationRecord, JsonValue, ReviewItem } from "../types.js";

const TARGET = "20-Workspace/Applications/test/Records/Test.md";

function record(): ApplicationRecord {
  return {
    id: "APP-2026-0001",
    module: "application-tracker",
    module_instance: "test-instance",
    type: "application-record",
    institution: "Test University",
    program_name: "Test Program",
    program_code: "T1000",
    country: "Australia",
    intake: "2027-02",
    application_status: "not-open",
    monitoring: {
      active: true,
      check_interval_days: 7,
      last_checked: null,
      next_check: "2099-01-01T00:00:00Z",
    },
    facts: {
      application_open: {
        value: false,
        status: "confirmed",
        confidence: 0.95,
        checked_at: "2026-07-20T00:00:00Z",
        source_refs: ["[[old-source]]"],
        notes: "closed",
      },
      tuition: {
        value: null,
        status: "unknown",
        confidence: 0,
        checked_at: null,
        source_refs: [],
        notes: "unknown",
      },
    },
    source_files: [],
    created: "2026-07-20T00:00:00Z",
    updated: "2026-07-20T00:00:00Z",
    schema_version: 1,
  };
}

function reviewItem(
  reviewId: string,
  field: string,
  oldValue: JsonValue,
  newValue: JsonValue,
): ReviewItem {
  return {
    review_id: reviewId,
    schema_version: 1,
    source_module: "application-tracker",
    instance_id: "test-instance",
    target: TARGET,
    action: "change-critical-field",
    proposed_value: {
      field,
      old_value: oldValue,
      new_value: newValue,
      finding_status: "confirmed",
      source_ids: ["SRC-TEST"],
      report_id: "RPT-2026-000001",
      ...(field === "application_open" ? { application_status: "open" } : {}),
    },
    confidence: 0.98,
    priority: "high",
    status: "pending",
    reason: `Review ${field}`,
    evidence: ["[[Research/report]]", "SRC-TEST"],
    created: "2026-07-27T00:00:00Z",
    review_after: null,
    decision: null,
    decision_history: [],
    target_observation: null,
    resolution: null,
  };
}

async function fixture(item: ReviewItem): Promise<string> {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-review-test-"));
  await initializeVault(vault, "disabled");
  writeMarkdown(vault, path.join(vault, ...TARGET.split("/")), {
    data: record(),
    content: "# Test application\n\n## 变更记录\n",
  });
  await writeReviewItems(vault, [item]);
  return vault;
}

function readRecord(vault: string): ApplicationRecord {
  return parseMarkdown(vault, path.join(vault, ...TARGET.split("/"))).data as unknown as ApplicationRecord;
}

test("direct approval executes a constrained plan and closes the review", async () => {
  const id = "REV-2026-000001";
  const vault = await fixture(reviewItem(id, "application_open", false, true));
  try {
    const result = await decideReview({
      vaultRoot: vault,
      reviewId: id,
      decision: "approve",
      userComment: "Official portal confirmed.",
      now: "2026-07-27T01:00:00Z",
    });
    const updated = readRecord(vault);
    assert.equal(result.status, "approved");
    assert.equal(updated.facts.application_open?.value, true);
    assert.equal(updated.application_status, "open");
    assert.match(updated.facts.application_open?.source_refs.join(" ") ?? "", /Research\/report/);
    assert.match(result.reviewPath, /Review Queue\/Closed/);
    const plan = JSON.parse(await fs.readFile(path.join(vault, ...result.planPath!.split("/")), "utf8")) as { operations: unknown[] };
    assert.equal(plan.operations.length, 2);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test("approval with modification applies only the user value", async () => {
  const id = "REV-2026-000002";
  const vault = await fixture(reviewItem(id, "tuition", null, 50000));
  try {
    const result = await decideReview({
      vaultRoot: vault,
      reviewId: id,
      decision: "approve-with-modification",
      modifiedValue: 48000,
      userComment: "Use scholarship-adjusted amount.",
      now: "2026-07-27T01:00:00Z",
    });
    assert.equal(result.status, "approved-with-modification");
    assert.equal(readRecord(vault).facts.tuition?.value, 48000);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test("discussion remains open, rejection preserves the target, and terminal reviews cannot repeat", async () => {
  const id = "REV-2026-000003";
  const vault = await fixture(reviewItem(id, "application_open", false, true));
  try {
    const discussed = await decideReview({
      vaultRoot: vault,
      reviewId: id,
      decision: "discuss",
      userComment: "Need another source.",
      now: "2026-07-27T01:00:00Z",
    });
    assert.equal(discussed.status, "pending");
    const rejected = await decideReview({
      vaultRoot: vault,
      reviewId: id,
      decision: "reject",
      userComment: "Evidence is insufficient.",
      now: "2026-07-27T02:00:00Z",
    });
    assert.equal(rejected.status, "rejected");
    assert.equal(readRecord(vault).facts.application_open?.value, false);
    const closed = parseMarkdown(vault, path.join(vault, ...rejected.reviewPath.split("/"))).data as unknown as ReviewItem;
    assert.equal(closed.decision_history.length, 2);
    await assert.rejects(
      () => decideReview({ vaultRoot: vault, reviewId: id, decision: "approve" }),
      /不允许重复处理/,
    );
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test("deferred review is hidden and returns to pending after its due time", async () => {
  const id = "REV-2026-000004";
  const vault = await fixture(reviewItem(id, "application_open", false, true));
  try {
    const deferred = await decideReview({
      vaultRoot: vault,
      reviewId: id,
      decision: "defer",
      reviewAfter: "2099-01-02T00:00:00Z",
      userComment: "Wait for the next intake update.",
      now: "2099-01-01T00:00:00Z",
    });
    assert.equal(deferred.status, "deferred");
    assert.match(deferred.reviewPath, /Review Queue\/Deferred/);
    const reconciled = await reconcileReviews(vault, id, "2099-01-03T00:00:00Z");
    assert.deepEqual(reconciled.requeued, [id]);
    assert.match(await fs.readFile(path.join(vault, "Today.md"), "utf8"), new RegExp(id));
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test("direct YAML edits close exact matches and warn on ambiguous changes", async () => {
  const matchingId = "REV-2026-000005";
  const matchingVault = await fixture(reviewItem(matchingId, "application_open", false, true));
  try {
    const targetPath = path.join(matchingVault, ...TARGET.split("/"));
    const document = parseMarkdown(matchingVault, targetPath);
    const data = document.data as unknown as ApplicationRecord;
    data.facts.application_open!.value = true;
    data.application_status = "open";
    writeMarkdown(matchingVault, targetPath, { data, content: document.content });
    const result = await reconcileReviews(matchingVault, matchingId);
    assert.deepEqual(result.resolved, [matchingId]);
  } finally {
    await fs.rm(matchingVault, { recursive: true, force: true });
  }

  const warningId = "REV-2026-000006";
  const warningVault = await fixture(reviewItem(warningId, "tuition", null, 50000));
  try {
    const targetPath = path.join(warningVault, ...TARGET.split("/"));
    const document = parseMarkdown(warningVault, targetPath);
    const data = document.data as unknown as ApplicationRecord;
    data.facts.tuition!.value = 47000;
    writeMarkdown(warningVault, targetPath, { data, content: document.content });
    const result = await reconcileReviews(warningVault, warningId);
    assert.deepEqual(result.warnings, [warningId]);
    assert.match(
      await fs.readFile(path.join(warningVault, "Today.md"), "utf8"),
      /目标文件已被修改，但关联审核项仍未关闭/,
    );
  } finally {
    await fs.rm(warningVault, { recursive: true, force: true });
  }
});
