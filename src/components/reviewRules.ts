import { parseMarkdown } from "../core/bridge.js";
import { PkbError } from "../core/errors.js";
import { exists, fromVaultPath } from "../core/files.js";
import type { JsonObject, JsonValue } from "../core/types.js";

export type ReviewCondition = "missing" | "conflicting" | "missing-or-conflicting" | "always";

export interface ReviewRule extends JsonObject {
  field: string;
  condition: ReviewCondition;
}

export interface ReviewRequirement extends JsonObject {
  field: string;
  condition: ReviewCondition;
  proposed_value: JsonValue;
  current_value: JsonValue;
  reason: string;
}

function isMissing(value: JsonValue | undefined): boolean {
  return value === undefined || value === null || (typeof value === "string" && !value.trim());
}

function fieldName(reference: string): string {
  const name = reference.split(".").at(-1)?.trim();
  if (!name) throw new PkbError("REVIEW_RULE_INVALID", "Review rule field must be a non-empty field reference.");
  return name;
}

export function evaluateReviewRules(proposed: JsonObject, current: JsonObject | null, rules: ReviewRule[]): ReviewRequirement[] {
  return rules.flatMap((rule) => {
    const name = fieldName(rule.field);
    const proposedValue = proposed[name];
    const currentValue = current?.[name] ?? null;
    const missing = isMissing(proposedValue);
    const conflicting = current !== null && !isMissing(proposedValue) && JSON.stringify(currentValue) !== JSON.stringify(proposedValue);
    const required = rule.condition === "always" || (rule.condition === "missing" && missing)
      || (rule.condition === "conflicting" && conflicting) || (rule.condition === "missing-or-conflicting" && (missing || conflicting));
    if (!required) return [];
    const reason = rule.condition === "always" ? `${rule.field} always requires review.`
      : missing ? `${rule.field} is missing from the proposed result.`
        : `${rule.field} conflicts with the current record value.`;
    return [{ field: rule.field, condition: rule.condition, proposed_value: proposedValue ?? null, current_value: currentValue, reason }];
  });
}

export async function evaluateReviewRulesForDocument(input: {
  vaultRoot: string;
  target: string;
  proposed: JsonObject;
  rules: ReviewRule[];
}): Promise<JsonObject> {
  const target = fromVaultPath(input.vaultRoot, input.target);
  const current = await exists(target) ? parseMarkdown(input.vaultRoot, target).data : null;
  const matches = evaluateReviewRules(input.proposed, current, input.rules);
  return { review_required: matches.length > 0, matches };
}
