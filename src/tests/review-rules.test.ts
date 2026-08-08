import assert from "node:assert/strict";
import test from "node:test";
import { evaluateReviewRules } from "../components/reviewRules.js";

const rules = [{ field: "assignment.deadline", condition: "missing-or-conflicting" as const }];

test("core.require-review-if deterministically detects missing and conflicting fields", () => {
  const missing = evaluateReviewRules({ title: "Essay" }, null, rules);
  assert.equal(missing.length, 1);
  assert.equal(missing[0]?.reason, "assignment.deadline is missing from the proposed result.");

  const conflicting = evaluateReviewRules({ deadline: "2026-09-01" }, { deadline: "2026-08-30" }, rules);
  assert.equal(conflicting.length, 1);
  assert.match(String(conflicting[0]?.reason), /conflicts/);

  const unchanged = evaluateReviewRules({ deadline: "2026-09-01" }, { deadline: "2026-09-01" }, rules);
  assert.equal(unchanged.length, 0);
});

test("core.require-review-if supports an unconditional Core Review gate", () => {
  const result = evaluateReviewRules({ title: "Private record" }, null, [{ field: "record.title", condition: "always" }]);
  assert.equal(result.length, 1);
  assert.match(String(result[0]?.reason), /always requires review/);
});
