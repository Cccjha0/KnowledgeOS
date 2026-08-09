import type { JsonObject, JsonValue } from "../core/types.js";

export type Representation = "metadata" | "summary" | "full" | "sensitive-original";

export interface PermissionRiskChange extends JsonObject {
  id: string;
  category: "network" | "filesystem" | "privacy" | "codex" | "events" | "destructive";
  severity: "high" | "critical";
  title: string;
  impact: string;
  previous: JsonValue;
  next: JsonValue;
}

interface RiskProfile {
  network: boolean;
  delete: boolean;
  crossModuleWrite: boolean;
  globalEventSubscription: boolean;
  maxSensitivityClass: number;
  maxRepresentation: Representation;
  codexRoles: Record<string, boolean>;
  destructivePolicy: "forbidden" | "review-required" | "allowed";
}

const REPRESENTATIONS: Representation[] = ["metadata", "summary", "full", "sensitive-original"];

function object(value: JsonValue | undefined): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
function rank(value: JsonValue | undefined): number { const found = REPRESENTATIONS.indexOf(String(value) as Representation); return found < 0 ? 0 : found; }
function sensitivity(value: JsonValue | undefined): number { const numeric = Number(value); return Number.isInteger(numeric) && numeric >= 0 && numeric <= 3 ? numeric : 0; }
function subscriptionsAreGlobal(value: JsonValue | undefined): boolean {
  return Array.isArray(value) && value.some((entry) => object(entry).scope === "global");
}

/**
 * Normalizes the security-relevant portions of a Manifest, Blueprint, or Pack
 * into one policy shape. The caller can then use the same diff logic for
 * creation, package upgrades, and future Configuration Pack upgrades.
 */
export function moduleRiskProfile(value: JsonObject, reviewPolicy: JsonObject = {}): RiskProfile {
  const permissions = object(value.permissions);
  const privacy = object(value.privacy);
  const inbox = object(value.inbox);
  const roles = object(inbox.roles ?? inbox.asset_roles ?? privacy.input_roles);
  const defaultPolicy = object(inbox.asset_access_policy ?? privacy);
  const events = object(value.events);
  const jobs = Array.isArray(value.jobs) ? value.jobs : [];
  const policy = String(reviewPolicy.destructive_operations ?? object(value.review_policy).destructive_operations ?? "forbidden");
  const codexRoles: Record<string, boolean> = {};
  let roleMaxSensitivity = 0;
  let roleMaxRepresentation = 0;
  for (const [id, raw] of Object.entries(roles)) {
    const role = object(raw);
    const access = object(role.access_policy ?? role.asset_access_policy ?? role);
    codexRoles[id] = role.allow_codex !== false;
    roleMaxSensitivity = Math.max(roleMaxSensitivity, sensitivity(access.sensitivity_class));
    roleMaxRepresentation = Math.max(roleMaxRepresentation, rank(access.max_representation));
  }
  return {
    network: permissions.network === true || permissions.allow_external_network === true || privacy.network_allowed === true,
    delete: permissions.delete === true || permissions.allow_delete === true,
    crossModuleWrite: permissions.cross_module_write === true,
    globalEventSubscription: permissions.global_event_subscription === true || subscriptionsAreGlobal(events.subscribes)
      || jobs.some((job) => object(job).subscription_scope === "global"),
    maxSensitivityClass: Math.max(sensitivity(permissions.max_sensitivity_class ?? privacy.default_sensitivity_class ?? defaultPolicy.sensitivity_class), roleMaxSensitivity),
    maxRepresentation: REPRESENTATIONS[Math.max(rank(privacy.default_max_representation ?? defaultPolicy.max_representation), roleMaxRepresentation)]!,
    codexRoles,
    destructivePolicy: policy === "allowed" || policy === "review-required" ? policy : "forbidden",
  };
}

function change(id: string, category: PermissionRiskChange["category"], severity: PermissionRiskChange["severity"], title: string, impact: string, previous: JsonValue, next: JsonValue): PermissionRiskChange {
  return { id, category, severity, title, impact, previous, next };
}

/** Returns only privilege/risk expansions. Reductions intentionally need no confirmation. */
export function diffPermissionRisk(previousInput: JsonObject, nextInput: JsonObject, previousReviewPolicy: JsonObject = {}, nextReviewPolicy: JsonObject = {}): PermissionRiskChange[] {
  const previous = moduleRiskProfile(previousInput, previousReviewPolicy);
  const next = moduleRiskProfile(nextInput, nextReviewPolicy);
  const output: PermissionRiskChange[] = [];
  if (!previous.network && next.network) output.push(change("network-access", "network", "high", "Allow network access", "The upgraded module may contact external services.", previous.network, next.network));
  if (!previous.delete && next.delete) output.push(change("delete", "filesystem", "critical", "Allow file deletion", "The upgraded module may delete managed files.", previous.delete, next.delete));
  if (!previous.crossModuleWrite && next.crossModuleWrite) output.push(change("cross-module-write", "filesystem", "critical", "Allow cross-module writes", "The upgraded module may modify data owned by another module.", previous.crossModuleWrite, next.crossModuleWrite));
  if (!previous.globalEventSubscription && next.globalEventSubscription) output.push(change("global-event-subscription", "events", "high", "Allow global event subscriptions", "The upgraded module may receive explicitly declared events outside its own instance or module.", previous.globalEventSubscription, next.globalEventSubscription));
  if (next.maxSensitivityClass > previous.maxSensitivityClass) output.push(change("max-sensitivity-class", "privacy", "high", "Increase sensitive-data access", "The upgraded module may access a higher privacy sensitivity class.", previous.maxSensitivityClass, next.maxSensitivityClass));
  if (rank(next.maxRepresentation) > rank(previous.maxRepresentation)) output.push(change("representation-range", "privacy", "high", "Expand content representation", "The upgraded module may request a broader representation of source content.", previous.maxRepresentation, next.maxRepresentation));
  for (const [role, allowed] of Object.entries(next.codexRoles)) {
    if (allowed && previous.codexRoles[role] === false) output.push(change(`role-codex:${role}`, "codex", "critical", `Enable Codex for ${role}`, "A sensitive input role that previously blocked Codex may now be sent to Codex.", false, true));
  }
  if (previous.destructivePolicy === "forbidden" && next.destructivePolicy !== "forbidden") output.push(change("destructive-policy", "destructive", "critical", "Relax destructive operation policy", "The upgraded module permits destructive behavior that was previously forbidden.", previous.destructivePolicy, next.destructivePolicy));
  if (previous.destructivePolicy === "review-required" && next.destructivePolicy === "allowed") output.push(change("destructive-policy", "destructive", "critical", "Allow unattended destructive operations", "Destructive behavior no longer requires a review decision.", previous.destructivePolicy, next.destructivePolicy));
  return output;
}

/** A creation is an upgrade from an explicit deny-all baseline. */
export function creationPermissionRisks(input: JsonObject, reviewPolicy: JsonObject = {}): PermissionRiskChange[] {
  return diffPermissionRisk({}, input, {}, reviewPolicy);
}
