import { PkbError } from "./errors.js";
import type { JsonObject } from "./types.js";

type Actor = "user" | "ai" | "system";
type Ownership = "user-owned" | "ai-managed" | "system-managed" | "source-immutable" | "mixed";

function object(value: unknown): JsonObject | null { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null; }

export function assertOwnedMutation(metadata: JsonObject, input: { actor: Actor; section?: string | null; fields?: string[]; reviewId?: string | null }): void {
  const ownership = object(metadata._ownership);
  const sectionPolicies = object(ownership?.sections);
  const fieldPolicies = object(ownership?.fields);
  const check = (label: string, policy: Ownership | null): void => {
    if (!policy) return;
    if (policy === "source-immutable") throw new PkbError("CONTENT_OWNERSHIP_DENIED", `${label} is source-immutable.`);
    if (policy === "user-owned" && input.actor !== "user") throw new PkbError("CONTENT_OWNERSHIP_DENIED", `${label} is user-owned.`);
    if (policy === "system-managed" && input.actor !== "system") throw new PkbError("CONTENT_OWNERSHIP_DENIED", `${label} is system-managed.`);
    if (policy === "ai-managed" && input.actor === "user") return;
    if (policy === "mixed" && input.actor === "ai" && !input.reviewId) throw new PkbError("CONTENT_REVIEW_REQUIRED", `${label} requires Review before an AI mutation.`);
  };
  if (input.section) check(`Section ${input.section}`, typeof sectionPolicies?.[input.section] === "string" ? sectionPolicies[input.section] as Ownership : null);
  for (const field of input.fields ?? []) check(`Field ${field}`, typeof fieldPolicies?.[field] === "string" ? fieldPolicies[field] as Ownership : null);
}
