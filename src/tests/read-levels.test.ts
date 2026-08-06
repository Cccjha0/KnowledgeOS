import assert from "node:assert/strict";
import test from "node:test";
import { representationPermits, requireSafeSummary, resolveDocumentAccessPolicy } from "../core/readLevels.js";

test("explicit document policy separates sensitivity authorization from content representation", () => {
  const policy = resolveDocumentAccessPolicy({ sensitivity_class: 0, access_policy: { max_representation: "metadata" } });
  assert.equal(policy.sensitivity_class, 0);
  assert.equal(policy.max_representation, "metadata");
  assert.equal(representationPermits(policy.max_representation, "full"), false);
});

test("legacy read_level remains readable until explicitly migrated", () => {
  const policy = resolveDocumentAccessPolicy({ read_level: 0 });
  assert.equal(policy.sensitivity_class, 0);
  assert.equal(policy.max_representation, "sensitive-original");
  assert.equal(policy.policy_source, "legacy");
});

test("summary representation accepts only an explicit safe_summary and never falls back to body-like fields", () => {
  assert.equal(requireSafeSummary({ safe_summary: "Safe, user-approved overview.", summary: "Private conventional summary." }, "Journal/private.md"), "Safe, user-approved overview.");
  assert.throws(() => requireSafeSummary({ summary: "Private conventional summary.", abstract: "Also private." }, "Journal/private.md"), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "SAFE_SUMMARY_REQUIRED");
});
