import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "../core/types.js";
import { creationPermissionRisks } from "./permissionRiskDiff.js";

export interface BlueprintApprovalRequirement extends JsonObject {
  id: string;
  title: string;
  impact: string;
}

export interface BlueprintApproval extends JsonObject {
  blueprint_hash: string;
  requirements: BlueprintApprovalRequirement[];
}

export function object(value: JsonValue | undefined): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

export function strings(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function workflowObjects(blueprint: JsonObject): JsonObject[] {
  return Array.isArray(blueprint.workflows) ? blueprint.workflows.map((item) => object(item)).filter((item): item is JsonObject => Boolean(item)) : [];
}

export function entityObjects(blueprint: JsonObject): JsonObject[] {
  return Array.isArray(blueprint.entities) ? blueprint.entities.map((item) => object(item)).filter((item): item is JsonObject => Boolean(item)) : [];
}

/**
 * Inbox roles are the v1.1 source of truth for both routing and access. The
 * older privacy.input_roles remains readable so existing v1 Blueprints can be
 * upgraded deliberately instead of losing their access policy at once.
 */
export function blueprintInputRoles(blueprint: JsonObject): JsonObject {
  const inboxRoles = object(object(blueprint.inbox)?.roles);
  if (!inboxRoles) return object(object(blueprint.privacy)?.input_roles) ?? {};
  return Object.fromEntries(Object.entries(inboxRoles).map(([id, value]) => {
    const role = object(value) ?? {};
    const access = object(role.access_policy) ?? {};
    return [id, {
      sensitivity_class: access.sensitivity_class ?? null,
      max_representation: access.max_representation ?? null,
      allow_codex: role.allow_codex !== false,
    } as JsonObject];
  })) as JsonObject;
}

export function representationRank(value: string): number {
  return ["metadata", "summary", "full", "sensitive-original"].indexOf(value);
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
  return JSON.stringify(value);
}

function approvalRequirement(id: BlueprintApprovalRequirement["id"], title: string, impact: string): BlueprintApprovalRequirement {
  return { id, title, impact };
}

/**
 * The Core-owned security contract for a Blueprint. Its canonical hash binds
 * approvals to the exact proposal the user reviewed; callers cannot safely
 * reuse an approval after changing a high-risk field.
 */
export function deriveBlueprintApproval(blueprint: JsonObject): BlueprintApproval {
  const privacy = object(blueprint.privacy) ?? {};
  const inputRoles = blueprintInputRoles(blueprint);
  const workflows = workflowObjects(blueprint);
  const reviewPolicy = object(blueprint.review_policy) ?? {};
  const entityCriticalFields = entityObjects(blueprint).some((entity) => Object.values(object(object(entity.schema)?.fields) ?? {}).some((field) => object(field)?.critical === true));
  const sensitiveFullRead = Object.values(inputRoles).some((raw) => {
    const policy = object(raw) ?? {};
    return Number(policy.sensitivity_class) >= 2 && representationRank(String(policy.max_representation ?? "metadata")) >= representationRank("full");
  }) || Number(privacy.default_sensitivity_class) >= 2 && representationRank(String(privacy.default_max_representation ?? "metadata")) >= representationRank("full");
  const risks = creationPermissionRisks(blueprint, reviewPolicy);
  const requirements: BlueprintApprovalRequirement[] = [];
  if (risks.some((risk) => risk.id === "network-access") || workflows.some((workflow) => workflow.requires_network === true)) requirements.push(approvalRequirement("network-access", "Allow network access", "This module may contact external services while processing its declared workflows."));
  if (sensitiveFullRead) requirements.push(approvalRequirement("sensitive-full-read", "Allow sensitive full-text access", "One or more input roles may provide sensitive content in full to a workflow or Codex."));
  if (privacy.user_original_content_mutable === true) requirements.push(approvalRequirement("mutable-user-original", "Allow editing user original content", "A workflow may modify content owned directly by the user."));
  if (risks.some((risk) => risk.id === "global-event-subscription")) requirements.push(approvalRequirement("global-event-subscription", "Allow global event subscriptions", "This module may receive explicitly declared events from other modules or instances."));
  if (risks.some((risk) => risk.id === "destructive-policy")) requirements.push(approvalRequirement("destructive-operation", "Allow review-gated destructive operations", "The Blueprint permits destructive behavior after a separate review decision."));
  if (strings(reviewPolicy.critical_fields).length > 0 || entityCriticalFields) requirements.push(approvalRequirement("critical-fields", "Accept critical field policy", "Declared critical fields will be protected by the module Review Policy and Quality checks."));
  return { blueprint_hash: createHash("sha256").update(canonicalJson(blueprint), "utf8").digest("hex"), requirements };
}
