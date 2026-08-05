import assert from "node:assert/strict";
import test from "node:test";
import { representationPermits, resolveDocumentAccessPolicy } from "../core/readLevels.js";

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
