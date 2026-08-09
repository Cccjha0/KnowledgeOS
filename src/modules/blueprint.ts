import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { availableIngestionAdapter } from "../core/adapterRegistry.js";
import { parseYaml, validateSchema, writeYaml } from "../core/bridge.js";
import { PkbError } from "../core/errors.js";
import { exists } from "../core/files.js";
import type { JsonObject, JsonValue } from "../core/types.js";
import { createModuleScaffold } from "./scaffold.js";
import { loadModuleBuilderRegistry } from "./platformContract.js";
import type { ModuleTemplate } from "./types.js";

const BLUEPRINT_SCHEMA = "https://pkb.local/schemas/core/module-blueprint.schema.json";
const PACK_REGISTRY = path.join("core", "module-builder", "capability-packs.yaml");

export interface BlueprintCheck extends JsonObject {
  code: string;
  status: "pass" | "warning" | "fail";
  message: string;
  path: string | null;
}

export interface BlueprintValidationReport extends JsonObject {
  report_version: 2;
  blueprint_version: number;
  module_id: string;
  checks: BlueprintCheck[];
  resolved_capability_packs: string[];
  resolved_capabilities: string[];
  required_components: JsonObject;
  required_rule_files: string[];
  overall: "PASS" | "PASS WITH WARNINGS" | "FAIL";
}

export interface BlueprintApprovalRequirement extends JsonObject {
  id: "network-access" | "sensitive-full-read" | "mutable-user-original" | "global-event-subscription" | "destructive-operation" | "critical-fields";
  title: string;
  impact: string;
}

export interface BlueprintApproval extends JsonObject {
  blueprint_hash: string;
  requirements: BlueprintApprovalRequirement[];
}

interface ResolvedBlueprint {
  blueprint: JsonObject;
  report: BlueprintValidationReport;
  scaffoldTemplate: ModuleTemplate;
}

function object(value: JsonValue | undefined): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function strings(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function blueprintEventNames(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => typeof item === "string" ? [item] : typeof item === "object" && item && !Array.isArray(item) && typeof (item as JsonObject).event === "string" ? [String((item as JsonObject).event)] : []);
}

export function isSemanticBlueprint(blueprint: JsonObject): boolean {
  return Number(blueprint.blueprint_version) >= 1.1;
}

function workflowObjects(blueprint: JsonObject): JsonObject[] {
  return Array.isArray(blueprint.workflows) ? blueprint.workflows.map((item) => object(item)).filter((item): item is JsonObject => Boolean(item)) : [];
}

function entityObjects(blueprint: JsonObject): JsonObject[] {
  return Array.isArray(blueprint.entities) ? blueprint.entities.map((item) => object(item)).filter((item): item is JsonObject => Boolean(item)) : [];
}

function sourceObjects(workflow: JsonObject): JsonObject[] {
  return Array.isArray(workflow.sources) ? workflow.sources.map((item) => object(item)).filter((item): item is JsonObject => Boolean(item)) : [];
}

function subscriptionObjects(value: JsonValue | undefined): JsonObject[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    if (typeof item === "string") return [{ event: item }];
    const subscription = object(item);
    return subscription ? [subscription] : [];
  }) : [];
}

function materializedSubscriptions(value: JsonValue | undefined): JsonValue[] {
  if (!Array.isArray(value)) return [];
  return value.reduce<JsonValue[]>((output, item) => {
    if (typeof item === "string") output.push(item);
    const subscription = object(item);
    if (subscription) output.push({
      event: subscription.event,
      ...(typeof subscription.scope === "string" ? { scope: subscription.scope } : {}),
      ...(Array.isArray(subscription.source_modules) ? { source_modules: subscription.source_modules } : {}),
    } as JsonObject);
    return output;
  }, []);
}

/**
 * Inbox roles are the v1.1 source of truth for both routing and access.  The
 * older privacy.input_roles remains readable so existing v1 Blueprints can be
 * upgraded deliberately instead of losing their access policy at once.
 */
function blueprintInputRoles(blueprint: JsonObject): JsonObject {
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

function representationRank(value: string): number {
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
  const events = object(blueprint.events) ?? {};
  const reviewPolicy = object(blueprint.review_policy) ?? {};
  const entityCriticalFields = entityObjects(blueprint).some((entity) => Object.values(object(object(entity.schema)?.fields) ?? {}).some((field) => object(field)?.critical === true));
  const sensitiveFullRead = Object.values(inputRoles).some((raw) => {
    const policy = object(raw) ?? {};
    return Number(policy.sensitivity_class) >= 2 && representationRank(String(policy.max_representation ?? "metadata")) >= representationRank("full");
  }) || Number(privacy.default_sensitivity_class) >= 2 && representationRank(String(privacy.default_max_representation ?? "metadata")) >= representationRank("full");
  const hasGlobalSubscription = subscriptionObjects(events.subscribes).some((subscription) => subscription.scope === "global")
    || (Array.isArray(blueprint.jobs) && blueprint.jobs.some((job) => object(job)?.subscription_scope === "global"));
  const requirements: BlueprintApprovalRequirement[] = [];
  if (privacy.network_allowed === true || workflows.some((workflow) => workflow.requires_network === true)) requirements.push(approvalRequirement("network-access", "Allow network access", "This module may contact external services while processing its declared workflows."));
  if (sensitiveFullRead) requirements.push(approvalRequirement("sensitive-full-read", "Allow sensitive full-text access", "One or more input roles may provide sensitive content in full to a workflow or Codex."));
  if (privacy.user_original_content_mutable === true) requirements.push(approvalRequirement("mutable-user-original", "Allow editing user original content", "A workflow may modify content owned directly by the user."));
  if (hasGlobalSubscription) requirements.push(approvalRequirement("global-event-subscription", "Allow global event subscriptions", "This module may receive explicitly declared events from other modules or instances."));
  if (reviewPolicy.destructive_operations === "review-required") requirements.push(approvalRequirement("destructive-operation", "Allow review-gated destructive operations", "The Blueprint permits destructive behavior after a separate review decision."));
  if (strings(reviewPolicy.critical_fields).length > 0 || entityCriticalFields) requirements.push(approvalRequirement("critical-fields", "Accept critical field policy", "Declared critical fields will be protected by the module Review Policy and Quality checks."));
  return { blueprint_hash: createHash("sha256").update(canonicalJson(blueprint), "utf8").digest("hex"), requirements };
}

function check(code: string, status: BlueprintCheck["status"], message: string, itemPath: string | null = null): BlueprintCheck {
  return { code, status, message, path: itemPath };
}

function addUnique(target: string[], values: string[]): void {
  for (const value of values) if (!target.includes(value)) target.push(value);
}

function validateCapabilityPackContracts(packs: JsonObject, resolved: string[], blueprint: JsonObject, checks: BlueprintCheck[], requiredRuleFiles: string[]): void {
  const privacy = object(blueprint.privacy) ?? {};
  const workflows = workflowObjects(blueprint);
  const inputRoles = blueprintInputRoles(blueprint);
  const testing = object(blueprint.testing) ?? {};
  const moduleType = String(object(blueprint.module_class)?.type ?? "");
  for (const id of resolved) {
    const contract = object(object(packs[id])?.contract);
    if (!contract) continue;
    addUnique(requiredRuleFiles, strings(contract.required_rules));
    const requiredTests = strings(contract.required_tests);
    const missingTests = requiredTests.filter((name) => testing[name] !== "required");
    checks.push(missingTests.length === 0
      ? check("CAPABILITY_PACK_TESTS_BOUND", "pass", `${id} requires and received its executable test scenarios.`, `capability_packs.${id}`)
      : check("CAPABILITY_PACK_TESTS_MISSING", "fail", `${id} requires testing.${missingTests.join(", ")}: required.`, `capability_packs.${id}`));
    const allowedTypes = strings(contract.module_types);
    if (allowedTypes.length) checks.push(allowedTypes.includes(moduleType)
      ? check("CAPABILITY_PACK_MODULE_TYPE_VALID", "pass", `${id} is valid for ${moduleType}.`, `capability_packs.${id}`)
      : check("CAPABILITY_PACK_MODULE_TYPE_DENIED", "fail", `${id} requires module_class.type to be one of ${allowedTypes.join(", ")}.`, `capability_packs.${id}`));
    const policy = object(contract.privacy);
    if (!policy) continue;
    const networkValid = policy.network_allowed === undefined || privacy.network_allowed === policy.network_allowed;
    const mutableValid = policy.user_original_content_mutable === undefined || privacy.user_original_content_mutable === policy.user_original_content_mutable;
    const sensitivityValid = typeof policy.min_sensitivity_class !== "number" || Number(privacy.default_sensitivity_class) >= policy.min_sensitivity_class;
    const unsafeSummary = policy.forbid_summary_for_sensitive_roles === true && workflows.some((workflow) =>
      String(object(workflow.read)?.representation ?? "metadata") === "summary"
      && strings(workflow.input_roles).some((role) => Number(object(inputRoles[role])?.sensitivity_class ?? 0) >= 2));
    checks.push(networkValid && mutableValid && sensitivityValid && !unsafeSummary
      ? check("CAPABILITY_PACK_PRIVACY_BOUND", "pass", `${id} privacy and Workflow restrictions are satisfied.`, `capability_packs.${id}`)
      : check("CAPABILITY_PACK_PRIVACY_DENIED", "fail", `${id} requires its declared privacy and Workflow restrictions.`, `capability_packs.${id}`));
  }
}

export async function validateModuleBlueprint(engineRoot: string, blueprintPath: string): Promise<ResolvedBlueprint> {
  const absolute = path.resolve(blueprintPath);
  if (!(await exists(absolute))) throw new PkbError("BLUEPRINT_NOT_FOUND", `Module Blueprint not found: ${absolute}`);
  const blueprint = parseYaml(path.dirname(absolute), absolute);
  validateSchema(engineRoot, BLUEPRINT_SCHEMA, blueprint);
  const registryPath = path.join(engineRoot, PACK_REGISTRY);
  if (!(await exists(registryPath))) throw new PkbError("CAPABILITY_PACK_REGISTRY_MISSING", `Capability Pack Registry not found: ${registryPath}`);
  const registry = await loadModuleBuilderRegistry(engineRoot);
  const packs = registry.packs;
  const templates = registry.templates;
  const requested = strings(blueprint.capability_packs);
  const resolved: string[] = [];
  const checks: BlueprintCheck[] = [check("BLUEPRINT_SCHEMA_VALID", "pass", "Blueprint v1 schema passed.", path.basename(absolute))];

  const visit = (id: string, stack: string[]): void => {
    if (resolved.includes(id)) return;
    if (stack.includes(id)) {
      checks.push(check("CAPABILITY_PACK_CYCLE", "fail", `Capability Pack dependency cycle: ${[...stack, id].join(" -> ")}.`, "capability_packs"));
      return;
    }
    const pack = object(packs[id]);
    if (!pack) {
      checks.push(check("CAPABILITY_PACK_UNKNOWN", "fail", `Capability Pack ${id} is not registered.`, "capability_packs"));
      return;
    }
    for (const dependency of strings(pack.requires)) visit(dependency, [...stack, id]);
    resolved.push(id);
  };
  for (const id of requested) visit(id, []);

  const resolvedCapabilities: string[] = [];
  const requiredComponents: JsonObject = {};
  const requiredRuleFiles: string[] = [];
  for (const id of resolved) {
    const pack = object(packs[id])!;
    addUnique(resolvedCapabilities, strings(pack.capabilities));
    for (const conflict of strings(pack.conflicts)) if (resolved.includes(conflict)) checks.push(check("CAPABILITY_PACK_CONFLICT", "fail", `${id} conflicts with ${conflict}.`, "capability_packs"));
    for (const adapter of strings(pack.adapters)) if (!availableIngestionAdapter(adapter)) checks.push(check("CAPABILITY_ADAPTER_UNAVAILABLE", "fail", `${id} requires unavailable adapter ${adapter}.`, "capability_packs"));
    for (const [component, range] of Object.entries(object(pack.components) ?? {})) {
      if (!(await exists(path.join(engineRoot, "components", component, "component.yaml")))) checks.push(check("CAPABILITY_COMPONENT_MISSING", "fail", `${id} requires missing component ${component}.`, "capability_packs"));
      else requiredComponents[component] = range;
    }
  }
  if (!checks.some((item) => item.code.startsWith("CAPABILITY_") && item.status === "fail")) checks.push(check("CAPABILITY_PACKS_RESOLVED", "pass", `Resolved ${resolved.length} Capability Packs.`, "capability_packs"));
  validateCapabilityPackContracts(packs, resolved, blueprint, checks, requiredRuleFiles);

  for (const format of strings(blueprint.inputs)) {
    const adapter = availableIngestionAdapter(format);
    checks.push(adapter
      ? check("INPUT_ADAPTER_AVAILABLE", "pass", `${format} uses ${adapter.adapter_id}@${adapter.adapter_version}.`, "inputs")
      : check("INPUT_ADAPTER_UNAVAILABLE", "fail", `${format} has no installed, available Ingestion Adapter.`, "inputs"));
  }
  const templateId = String(blueprint.base_template);
  const template = object(templates[templateId]);
  if (!template) checks.push(check("BASE_TEMPLATE_UNKNOWN", "fail", `Base template ${templateId} is not registered.`, "base_template"));
  const moduleClass = object(blueprint.module_class);
  const allowedTypes = strings(template?.module_types);
  if (template && !allowedTypes.includes(String(moduleClass?.type))) checks.push(check("BASE_TEMPLATE_CLASS_MISMATCH", "fail", `${templateId} does not support module class ${String(moduleClass?.type)}.`, "module_class.type"));
  else if (template) checks.push(check("BASE_TEMPLATE_COMPATIBLE", "pass", `${templateId} is compatible with ${String(moduleClass?.type)}.`, "base_template"));

  const privacy = object(blueprint.privacy);
  if (privacy?.network_allowed === true && moduleClass?.type !== "integration") checks.push(check("NETWORK_PERMISSION_CLASS_MISMATCH", "fail", "Only an integration Blueprint may enable network access.", "privacy.network_allowed"));
  const workflows = workflowObjects(blueprint);
  if (workflows.some((workflow) => workflow.requires_network === true) && privacy?.network_allowed !== true) checks.push(check("WORKFLOW_NETWORK_UNDECLARED", "fail", "A Workflow requires network but privacy.network_allowed is false.", "workflows"));
  const events = object(blueprint.events);
  if (blueprintEventNames(events?.publishes).length && !resolvedCapabilities.includes("event-publishing")) checks.push(check("EVENT_CAPABILITY_MISSING", "fail", "Published Events require the event-publishing Capability Pack.", "events.publishes"));
  if (blueprintEventNames(events?.subscribes).length && !resolvedCapabilities.includes("event-subscription")) checks.push(check("EVENT_SUBSCRIPTION_CAPABILITY_MISSING", "fail", "Event subscriptions require the event-subscription Capability Pack.", "events.subscribes"));
  const testing = object(blueprint.testing);
  if (workflows.some((workflow) => workflow.trigger === "schedule") && testing?.periodic_job !== "required") checks.push(check("PERIODIC_TEST_REQUIRED", "fail", "Scheduled Workflows require testing.periodic_job: required.", "testing.periodic_job"));
  if (blueprintEventNames(events?.publishes).length && testing?.event_publication !== "required") checks.push(check("EVENT_PUBLICATION_TEST_REQUIRED", "fail", "Published Events require an Event publication test.", "testing.event_publication"));
  if (blueprintEventNames(events?.subscribes).length && testing?.event_consumption !== "required") checks.push(check("EVENT_CONSUMPTION_TEST_REQUIRED", "fail", "Event subscriptions require an Event consumption test.", "testing.event_consumption"));
  if (strings(blueprint.inputs).some((format) => ["pdf", "pptx", "image"].includes(format)) && testing?.attachment_policy !== "required") checks.push(check("ATTACHMENT_POLICY_TEST_REQUIRED", "fail", "Attachment inputs require testing.attachment_policy: required.", "testing.attachment_policy"));

  if (isSemanticBlueprint(blueprint)) validateSemanticBlueprintContract(blueprint, checks);

  const failed = checks.filter((item) => item.status === "fail").length;
  const warnings = checks.filter((item) => item.status === "warning").length;
  const moduleInfo = object(blueprint.module);
  const report: BlueprintValidationReport = {
    report_version: 2,
    blueprint_version: Number(blueprint.blueprint_version),
    module_id: String(moduleInfo?.id ?? "unknown"),
    checks,
    resolved_capability_packs: resolved,
    resolved_capabilities: resolvedCapabilities,
    required_components: requiredComponents,
    required_rule_files: requiredRuleFiles,
    overall: failed ? "FAIL" : warnings ? "PASS WITH WARNINGS" : "PASS",
  };
  return { blueprint, report, scaffoldTemplate: String(template?.scaffold_template ?? "minimal-config") as ModuleTemplate };
}

function validateSemanticBlueprintContract(blueprint: JsonObject, checks: BlueprintCheck[]): void {
  const entities = entityObjects(blueprint);
  const entityIds = entities.map((entity) => String(entity.id));
  const review = object(blueprint.review_policy);
  const criticalFields = strings(review?.critical_fields);
  const privacy = object(blueprint.privacy);
  const inputRoles = blueprintInputRoles(blueprint);
  const inbox = object(blueprint.inbox);
  const inboxRoles = object(inbox?.roles) ?? {};
  const workflows = workflowObjects(blueprint);
  const workflowIds = workflows.map((workflow) => String(workflow.id));
  const events = object(blueprint.events);
  const publishedEvents = blueprintEventNames(events?.publishes);
  const subscriptions = subscriptionObjects(events?.subscribes);

  if (Object.keys(inboxRoles).length) {
    const defaultRole = String(inbox?.default_asset_role ?? "");
    checks.push(Object.prototype.hasOwnProperty.call(inboxRoles, defaultRole)
      ? check("SEMANTIC_INBOX_DEFAULT_ROLE_VALID", "pass", `Default Inbox role ${defaultRole} is declared.`, "inbox.default_asset_role")
      : check("SEMANTIC_INBOX_DEFAULT_ROLE_INVALID", "fail", "Inbox roles require inbox.default_asset_role to name a declared role.", "inbox.default_asset_role"));
    for (const [roleId, rawRole] of Object.entries(inboxRoles)) {
      const role = object(rawRole);
      const access = object(role?.access_policy);
      const entrypoint = typeof role?.entrypoint === "string" ? role.entrypoint : "";
      const action = typeof role?.required_user_action === "string" ? role.required_user_action : "";
      const validAction = ["select-route", "classify-attachment", "review-partial-extraction", "close-open-file", "resolve-review"].includes(action);
      checks.push(access && typeof role?.inbox_subpath === "string" && (Boolean(entrypoint) || Boolean(action)) && (!action || validAction)
        ? check("SEMANTIC_INBOX_ROLE_CONTRACT_VALID", "pass", `${roleId} declares path, access policy, and a continuation.`, `inbox.roles.${roleId}`)
        : check("SEMANTIC_INBOX_ROLE_CONTRACT_INVALID", "fail", `${roleId} must declare inbox_subpath, access_policy, and a valid continuation.`, `inbox.roles.${roleId}`));
      if (entrypoint) checks.push(workflowIds.includes(entrypoint)
        ? check("SEMANTIC_INBOX_ROLE_ENTRYPOINT_VALID", "pass", `${roleId} routes to ${entrypoint}.`, `inbox.roles.${roleId}.entrypoint`)
        : check("SEMANTIC_INBOX_ROLE_ENTRYPOINT_UNKNOWN", "fail", `${roleId} routes to unknown Workflow ${entrypoint}.`, `inbox.roles.${roleId}.entrypoint`));
    }
  }

  for (const entity of entities) {
    const entityId = String(entity.id);
    const schema = object(entity.schema);
    const fields = object(schema?.fields);
    checks.push(schema && fields && Object.keys(fields).length
      ? check("SEMANTIC_ENTITY_SCHEMA_DECLARED", "pass", `${entityId} declares an Entity Schema.`, `entities.${entityId}.schema`)
      : check("SEMANTIC_ENTITY_SCHEMA_REQUIRED", "fail", `${entityId} must declare schema.fields in Blueprint v1.1.`, `entities.${entityId}.schema`));
    if (!fields) continue;
    for (const [fieldId, fieldValue] of Object.entries(fields)) {
      const field = object(fieldValue);
      if (field?.critical === true) {
        const reference = `${entityId}.${fieldId}`;
        checks.push(criticalFields.includes(reference)
          ? check("SEMANTIC_CRITICAL_FIELD_REVIEWED", "pass", `${reference} is declared in the Review Policy.`, `review_policy.critical_fields`)
          : check("SEMANTIC_CRITICAL_FIELD_REVIEW_REQUIRED", "fail", `${reference} is critical and must be listed in review_policy.critical_fields.`, `review_policy.critical_fields`));
      }
      if (field?.type === "enum" && !Array.isArray(field.values)) checks.push(check("SEMANTIC_ENUM_VALUES_REQUIRED", "fail", `${entityId}.${fieldId} is an enum and must declare values.`, `entities.${entityId}.schema.fields.${fieldId}`));
    }
    const lifecycle = object(entity.lifecycle);
    if (lifecycle) {
      const initial = String(lifecycle.initial ?? "");
      const transitions = object(lifecycle.transitions) ?? {};
      const stateField = object(entity.schema)?.fields && object(object(entity.schema)?.fields)?.status ? "status" : null;
      const states = new Set(Object.keys(transitions));
      const transitionsValid = Object.values(transitions).every((targets) => Array.isArray(targets) && targets.every((target) => typeof target === "string" && states.has(target)));
      checks.push(initial && stateField && Object.prototype.hasOwnProperty.call(transitions, initial) && transitionsValid
        ? check("SEMANTIC_LIFECYCLE_VALID", "pass", `${entityId} lifecycle has an initial state and transitions.`, `entities.${entityId}.lifecycle`)
        : check("SEMANTIC_LIFECYCLE_INVALID", "fail", `${entityId} lifecycle must use a declared status field, an initial state, and only declared transition targets.`, `entities.${entityId}.lifecycle`));
    }
  }
  for (const fieldRef of criticalFields) {
    const [entityId, fieldId] = fieldRef.split(".", 2);
    const entity = entities.find((item) => item.id === entityId);
    const fields = object(object(entity?.schema)?.fields);
    const field = object(fields?.[fieldId ?? ""]);
    checks.push(field?.critical === true
      ? check("SEMANTIC_REVIEW_FIELD_EXISTS", "pass", `${fieldRef} has a matching critical Entity field.`, "review_policy.critical_fields")
      : check("SEMANTIC_REVIEW_FIELD_UNKNOWN", "fail", `${fieldRef} must reference a critical field declared by an Entity.`, "review_policy.critical_fields"));
  }

  const outputs = Array.isArray(blueprint.outputs) ? blueprint.outputs.map((item) => object(item)).filter((item): item is JsonObject => Boolean(item)) : [];
  if (!outputs.length) checks.push(check("SEMANTIC_OUTPUT_CONTRACT_REQUIRED", "fail", "Blueprint v1.1 outputs must declare entity, schema, template, and target.", "outputs"));
  for (const output of outputs) {
    const entityId = String(output.entity ?? "");
    const schemaId = String(output.schema ?? "");
    const valid = entityIds.includes(entityId) && schemaId === entityId && typeof output.template === "string" && typeof output.target === "string";
    checks.push(valid
      ? check("SEMANTIC_OUTPUT_CONTRACT_VALID", "pass", `${String(output.id)} has an explicit output contract.`, `outputs.${String(output.id)}`)
      : check("SEMANTIC_OUTPUT_CONTRACT_INVALID", "fail", `${String(output.id)} must reference an Entity with its schema, template, and target.`, `outputs.${String(output.id)}`));
  }

  const mappedEvents: string[] = [];
  for (const workflow of workflows) {
    const id = String(workflow.id);
    const inputEntities = strings(workflow.input_entities);
    const sources = sourceObjects(workflow);
    const outputEntity = String(workflow.output_entity ?? "");
    const roles = strings(workflow.input_roles);
    const read = object(workflow.read);
    const operation = object(workflow.operation);
    const prompt = object(workflow.prompt);
    const reviewWhen = Array.isArray(workflow.review_when) ? workflow.review_when.map((item) => object(item)).filter((item): item is JsonObject => Boolean(item)) : [];
    const fieldsPresent = inputEntities.length > 0 && entityIds.includes(outputEntity) && read && operation;
    checks.push(fieldsPresent
      ? check("SEMANTIC_WORKFLOW_CONTRACT_VALID", "pass", `${id} declares inputs, output, read policy, and Operation target.`, `workflows.${id}`)
      : check("SEMANTIC_WORKFLOW_CONTRACT_REQUIRED", "fail", `${id} must declare input_entities, output_entity, read, and operation in Blueprint v1.1.`, `workflows.${id}`));
    if (workflow.requires_ai === true) checks.push(prompt?.id
      ? check("SEMANTIC_WORKFLOW_PROMPT_DECLARED", "pass", `${id} declares its Prompt.`, `workflows.${id}.prompt`)
      : check("SEMANTIC_WORKFLOW_PROMPT_REQUIRED", "fail", `${id} requires AI and must declare prompt.id.`, `workflows.${id}.prompt`));
    if (workflow.trigger === "capture") checks.push(roles.length > 0
      ? check("SEMANTIC_CAPTURE_ROLE_DECLARED", "pass", `${id} declares an input role.`, `workflows.${id}.input_roles`)
      : check("SEMANTIC_CAPTURE_ROLE_REQUIRED", "fail", `${id} is capture-triggered and must declare input_roles.`, `workflows.${id}.input_roles`));
    for (const role of roles) {
      const inboxRole = object(inboxRoles[role]);
      const routedToWorkflow = inboxRole?.entrypoint === id;
      checks.push(!Object.keys(inboxRoles).length || routedToWorkflow
        ? check("SEMANTIC_CAPTURE_ROLE_ROUTED", "pass", `${id} is selected by the Inbox role contract for ${role}.`, `inbox.roles.${role}.entrypoint`)
        : check("SEMANTIC_CAPTURE_ROLE_UNROUTED", "fail", `${id} uses ${role}, but that Inbox role does not route to this Workflow.`, `inbox.roles.${role}.entrypoint`));
    }
    for (const rule of reviewWhen) {
      const reference = String(rule.field ?? "");
      const [entityId, fieldId] = reference.split(".", 2);
      const entity = entities.find((candidate) => candidate.id === entityId);
      const fieldExists = Boolean(object(object(entity?.schema)?.fields)?.[fieldId ?? ""]);
      const condition = String(rule.condition ?? "");
      const validCondition = ["missing", "conflicting", "missing-or-conflicting", "always"].includes(condition);
      checks.push(fieldExists && validCondition && entityId === outputEntity
        ? check("SEMANTIC_REVIEW_WHEN_VALID", "pass", `${id} has an executable review rule for ${reference}.`, `workflows.${id}.review_when`)
        : check("SEMANTIC_REVIEW_WHEN_INVALID", "fail", `${id} review_when must reference an output Entity field and a supported condition.`, `workflows.${id}.review_when`));
    }
    if (workflow.trigger === "schedule") {
      checks.push(sources.length > 0
        ? check("SEMANTIC_SCHEDULE_SOURCES_DECLARED", "pass", `${id} declares the source query contract for its scheduled input.`, `workflows.${id}.sources`)
        : check("SEMANTIC_SCHEDULE_SOURCES_REQUIRED", "fail", `${id} is scheduled and must declare sources that Core will query before prompting.`, `workflows.${id}.sources`));
      for (const source of sources) {
        const entityId = String(source.entity ?? "");
        const entity = entities.find((candidate) => candidate.id === entityId);
        const dateField = String(source.date_field ?? "");
        const fieldExists = Boolean(object(object(entity?.schema)?.fields)?.[dateField]);
        const outputExists = outputs.some((output) => output.entity === entityId);
        const window = String(source.window ?? "");
        const validWindow = ["current-day", "current-week", "active-or-upcoming", "all"].includes(window);
        checks.push(entity && fieldExists && outputExists && validWindow
          ? check("SEMANTIC_SCHEDULE_SOURCE_VALID", "pass", `${id} queries ${entityId} using ${window}.`, `workflows.${id}.sources`)
          : check("SEMANTIC_SCHEDULE_SOURCE_INVALID", "fail", `${id} source ${entityId || "unknown"} must reference an output Entity, declared date field, and supported window.`, `workflows.${id}.sources`));
      }
    }
    for (const role of roles) {
      const policy = object(inputRoles[role]);
      const requested = String(read?.representation ?? "metadata");
      const allowed = String(policy?.max_representation ?? "");
      checks.push(policy && representationRank(requested) <= representationRank(allowed)
        ? check("SEMANTIC_ROLE_READ_POLICY_VALID", "pass", `${id} read policy is allowed for ${role}.`, `workflows.${id}.read`)
        : check("SEMANTIC_ROLE_READ_POLICY_DENIED", "fail", `${id} requests ${requested} for ${role}, but no compatible input role policy exists.`, `workflows.${id}.read`));
      if (workflow.requires_ai === true) checks.push(policy?.allow_codex !== false
        ? check("SEMANTIC_ROLE_CODEX_ALLOWED", "pass", `${id} may use Codex for ${role}.`, `workflows.${id}.input_roles`)
        : check("SEMANTIC_ROLE_CODEX_DENIED", "fail", `${id} requires AI but ${role} explicitly sets allow_codex: false.`, `workflows.${id}.input_roles`));
    }
    const publishes = Array.isArray(workflow.publishes) ? workflow.publishes.map((item) => object(item)).filter((item): item is JsonObject => Boolean(item)) : [];
    for (const publication of publishes) {
      const event = String(publication.event ?? "");
      mappedEvents.push(event);
      checks.push(publishedEvents.includes(event)
        ? check("SEMANTIC_WORKFLOW_EVENT_VALID", "pass", `${id} explicitly publishes ${event}.`, `workflows.${id}.publishes`)
        : check("SEMANTIC_WORKFLOW_EVENT_UNDECLARED", "fail", `${id} publishes ${event}, which is absent from events.publishes.`, `workflows.${id}.publishes`));
    }
  }
  for (const event of publishedEvents) checks.push(mappedEvents.includes(event)
    ? check("SEMANTIC_EVENT_WORKFLOW_BOUND", "pass", `${event} is bound to a Workflow.`, "events.publishes")
    : check("SEMANTIC_EVENT_WORKFLOW_REQUIRED", "fail", `${event} must be explicitly bound to exactly one Workflow publication.`, "events.publishes"));

  const jobs = Array.isArray(blueprint.jobs) ? blueprint.jobs.map((item) => object(item)).filter((item): item is JsonObject => Boolean(item)) : [];
  for (const job of jobs) {
    const jobId = String(job.id);
    const workflowId = String(job.workflow_id ?? "");
    const schedule = String(job.schedule ?? "");
    const hasClock = typeof job.timezone === "string" && typeof job.at === "string";
    const scheduleValid = schedule === "daily" ? hasClock
      : schedule === "weekly" ? hasClock
        : schedule === "monthly" ? hasClock && Number.isInteger(job.day ?? 1) && Number(job.day ?? 1) >= 1 && Number(job.day ?? 1) <= 31
          : schedule === "startup" ? (job.dedupe === undefined || job.dedupe === "startup" || (job.dedupe === "daily" && typeof job.timezone === "string"))
            : schedule === "field-due" ? typeof job.source_root === "string" && !String(job.source_root).includes("{") && typeof job.field === "string" && typeof job.id_field === "string"
              : schedule === "event" ? typeof job.event === "string" && ["instance", "module", "global"].includes(String(job.subscription_scope))
                && (job.subscription_scope !== "global" || Array.isArray(job.source_modules) && job.source_modules.length > 0)
                && subscriptions.some((subscription) => subscription.event === job.event && subscription.scope === job.subscription_scope
                  && subscription.workflow_id === workflowId
                  && (job.subscription_scope !== "global" || JSON.stringify(subscription.source_modules ?? []) === JSON.stringify(job.source_modules ?? [])))
                : false;
    const instanceScopeValid = job.subscription_scope !== "instance" || job.scope === "instance";
    const valid = workflowIds.includes(workflowId) && typeof job.scope === "string" && scheduleValid && instanceScopeValid;
    checks.push(valid
      ? check("SEMANTIC_JOB_WORKFLOW_BOUND", "pass", `${jobId} fully materializes ${schedule} for ${workflowId}.`, `jobs.${jobId}`)
      : check("SEMANTIC_JOB_TRIGGER_INCOMPLETE", "fail", `${jobId} must bind a declared Workflow and provide the complete ${schedule || "unknown"} Trigger contract.`, `jobs.${jobId}`));
  }
}

export interface BlueprintScaffoldOptions { modulesRoot?: string; }

export async function scaffoldModuleFromBlueprint(engineRoot: string, blueprintPath: string, options: BlueprintScaffoldOptions = {}): Promise<JsonObject> {
  const resolved = await validateModuleBlueprint(engineRoot, blueprintPath);
  if (resolved.report.overall === "FAIL") throw new PkbError("BLUEPRINT_INVALID", "Module Blueprint failed validation.", resolved.report);
  const moduleInfo = object(resolved.blueprint.module)!;
  const moduleId = String(moduleInfo.id);
  const displayName = String(moduleInfo.display_name);
  const result = await createModuleScaffold(engineRoot, moduleId, resolved.scaffoldTemplate, displayName, options);
  const moduleRoot = result.module_root;
  const manifestPath = path.join(moduleRoot, "module.yaml");
  const manifest = parseYaml(moduleRoot, manifestPath);
  const privacy = object(resolved.blueprint.privacy)!;
  const inbox = object(resolved.blueprint.inbox)!;
  const events = object(resolved.blueprint.events)!;
  manifest.description = String(moduleInfo.description);
  manifest.module_type = String(object(resolved.blueprint.module_class)?.type ?? manifest.module_type);
  const capabilities = [...resolved.report.resolved_capabilities];
  addUnique(capabilities, ["dashboard-items"]);
  manifest.capabilities = capabilities;
  manifest.accepted_inputs = resolved.blueprint.inputs ?? [];
  manifest.dependencies = { components: resolved.report.required_components };
  manifest.inbox = {
    module_level: { enabled: inbox.module_level === true, path: `20-Workspace/${displayName}/Inbox` },
    instance_level: { enabled: inbox.instance_level === true, path_pattern: "{content_root}/Inbox" },
    allow_global_routing: inbox.global_routing === true,
    asset_access_policy: { sensitivity_class: Number(privacy.default_sensitivity_class), max_representation: String(privacy.default_max_representation) },
  };
  const roleContracts = object(inbox.roles);
  if (roleContracts) {
    (manifest.inbox as JsonObject).default_asset_role = inbox.default_asset_role ?? null;
    (manifest.inbox as JsonObject).asset_roles = Object.fromEntries(Object.entries(roleContracts).map(([roleId, rawRole]) => {
      const role = object(rawRole) ?? {};
      return [roleId, {
        inbox_subpath: role.inbox_subpath ?? null,
        asset_access_policy: object(role.access_policy) ?? {},
        ...(typeof role.entrypoint === "string" ? { entrypoint: role.entrypoint } : {}),
        ...(typeof role.required_user_action === "string" ? { required_user_action: role.required_user_action } : {}),
        allow_codex: role.allow_codex !== false,
      } as JsonObject];
    })) as JsonObject;
  }
  manifest.permissions = {
    ...(object(manifest.permissions) ?? {}),
    max_sensitivity_class: Number(privacy.default_sensitivity_class),
    network: privacy.network_allowed === true,
    allow_external_network: privacy.network_allowed === true,
  };
  manifest.events = { publishes: blueprintEventNames(events.publishes), subscribes: materializedSubscriptions(events.subscribes) };
  if (strings(resolved.blueprint.inputs).includes("pdf")) manifest.pdf_policy = { accepted_statuses: ["completed"], partial_policy: "review" };
  writeYaml(moduleRoot, manifestPath, manifest);
  if (isSemanticBlueprint(resolved.blueprint)) await materializeSemanticEntities(moduleRoot, resolved.blueprint, manifest);
  await ensureCapabilityPackRules(moduleRoot, resolved.blueprint, resolved.report.required_rule_files);
  await materializeDeclaredWorkflows(moduleRoot, resolved.blueprint, manifest);
  await materializeBlueprintTestContract(moduleRoot, resolved.blueprint);
  writeYaml(moduleRoot, manifestPath, manifest);
  writeYaml(moduleRoot, path.join(moduleRoot, "module.blueprint.yaml"), resolved.blueprint);
  await fs.writeFile(path.join(moduleRoot, "docs", "blueprint-boundary.md"), renderBoundaryDocument(resolved.blueprint), "utf8");
  await fs.writeFile(path.join(moduleRoot, "blueprint-validation-report.json"), `${JSON.stringify(resolved.report, null, 2)}\n`, "utf8");
  return { ...result, module_id: moduleId, blueprint: path.join(moduleRoot, "module.blueprint.yaml"), validation: resolved.report.overall };
}

async function ensureCapabilityPackRules(moduleRoot: string, blueprint: JsonObject, requiredRules: string[]): Promise<void> {
  for (const rule of requiredRules) {
    const target = path.join(moduleRoot, "rules", `${rule}.yaml`);
    if (await exists(target)) continue;
    if (rule === "ownership") {
      writeYaml(moduleRoot, target, {
        user_original_content_mutable: object(blueprint.privacy)?.user_original_content_mutable === true,
        generated_entities: [],
        forbidden_operations: ["update-user-original", "overwrite-source"],
      });
      continue;
    }
    if (rule === "permissions") {
      writeYaml(moduleRoot, target, object(blueprint.privacy) ?? {});
      continue;
    }
    throw new PkbError("CAPABILITY_PACK_RULE_UNSUPPORTED", `Capability Pack requires unknown rule ${rule}.`);
  }
}

function blueprintOutputObjects(blueprint: JsonObject): JsonObject[] {
  return Array.isArray(blueprint.outputs) ? blueprint.outputs.map((item) => object(item)).filter((item): item is JsonObject => Boolean(item)) : [];
}

function schemaProperty(field: JsonObject): JsonObject {
  const type = String(field.type);
  if (type === "datetime") return { type: "string", format: "date-time" };
  if (type === "date") return { type: "string", format: "date" };
  if (type === "enum") return { type: "string", enum: strings(field.values) };
  if (type === "array") return { type: "array", items: { type: String(field.items ?? "string") } };
  if (type === "object") return { type: "object" };
  if (type === "reference") return { type: "string" };
  return { type };
}

async function materializeSemanticEntities(moduleRoot: string, blueprint: JsonObject, manifest: JsonObject): Promise<void> {
  const moduleId = String(object(blueprint.module)?.id);
  const entities = entityObjects(blueprint);
  const outputs = blueprintOutputObjects(blueprint);
  const schemaRegistry = parseYaml(moduleRoot, path.join(moduleRoot, "schemas", "index.yaml"));
  const registeredSchemas = object(schemaRegistry.schemas) ?? {};
  const manifestSchemas = object(manifest.schemas) ?? {};
  const promptRegistry = parseYaml(moduleRoot, path.join(moduleRoot, "prompts", "index.yaml"));
  const prompts = object(promptRegistry.prompts) ?? {};
  const workflows = workflowObjects(blueprint);
  const workflowPrompts = workflows.map((workflow) => String(object(workflow.prompt)?.id ?? "")).filter(Boolean);
  const summarySourceEntities = new Set(workflows
    .filter((workflow) => String(object(workflow.read)?.representation) === "summary")
    .flatMap((workflow) => sourceObjects(workflow).map((source) => String(source.entity))));
  const baseRequired = ["id", "type", "schema_id", "schema_version", "module_version", "instance_id", "title", "source_refs", "created", "updated"];
  for (const entity of entities) {
    const entityId = String(entity.id);
    const declaredFields = object(object(entity.schema)?.fields) ?? {};
    const properties: JsonObject = {
      id: { type: "string" }, type: { const: `${moduleId}-${entityId}` }, schema_id: { const: entityId }, schema_version: { const: 1 }, module_version: { type: "string" },
      instance_id: { type: "string" }, title: { type: "string", minLength: 1 }, source_refs: { type: "array", items: { type: "string" } }, generation: { type: ["object", "null"] },
      created: { type: "string", format: "date-time" }, updated: { type: "string", format: "date-time" },
      // Summary access is opt-in and must not be derived from a document's first paragraph.
      safe_summary: { type: ["string", "null"] },
    };
    const required = [...baseRequired, ...(summarySourceEntities.has(entityId) ? ["safe_summary"] : [])];
    for (const [fieldId, raw] of Object.entries(declaredFields)) {
      const field = object(raw)!;
      properties[fieldId] = schemaProperty(field);
      if (field.required === true && !required.includes(fieldId)) required.push(fieldId);
    }
    // `_field_meta` is Core-owned. It is optional because a record can contain
    // no quality-governed values, but each declared field contract has a stable
    // schema for the evidence / generation / review / freshness lifecycle.
    const fieldMetaProperties: JsonObject = {};
    for (const [fieldId, raw] of Object.entries(declaredFields)) {
      const field = object(raw) ?? {};
      if (field.provenance_required !== true && typeof field.freshness_days !== "number") continue;
      fieldMetaProperties[fieldId] = {
        type: "object",
        additionalProperties: false,
        required: ["authorship", "evidence_refs", "generation", "review", "verification"],
        properties: {
          authorship: { enum: ["user", "ai", "system", "official-source", "external-research"] },
          evidence_refs: { type: "array", items: { type: "string" } },
          generation: { type: ["object", "null"] },
          review: { type: ["object", "null"] },
          verification: {
            type: "object", additionalProperties: false,
            required: ["last_verified", "verification_interval_days", "stale_after", "stale", "verification_status"],
            properties: {
              last_verified: { type: ["string", "null"], format: "date-time" },
              verification_interval_days: { type: ["number", "null"] },
              stale_after: { type: ["string", "null"], format: "date-time" },
              stale: { type: "boolean" },
              verification_status: { enum: ["verified", "due-soon", "stale", "unverifiable", "historical", "unknown"] },
            },
          },
        },
      };
    }
    if (Object.keys(fieldMetaProperties).length) properties._field_meta = { type: "object", additionalProperties: false, properties: fieldMetaProperties };
    const schema = { $schema: "https://json-schema.org/draft/2020-12/schema", $id: `https://pkb.local/schemas/${moduleId}/${entityId}.schema.json`, type: "object", additionalProperties: false, required, properties };
    await fs.writeFile(path.join(moduleRoot, "schemas", `${entityId}.schema.json`), `${JSON.stringify(schema, null, 2)}\n`, "utf8");
    registeredSchemas[entityId] = { version: 1, path: `${entityId}.schema.json`, entity_type: `${moduleId}-${entityId}` };
    manifestSchemas[entityId] = `schemas/${entityId}.schema.json`;
  }
  schemaRegistry.schemas = registeredSchemas;
  manifest.schemas = manifestSchemas;
  writeYaml(moduleRoot, path.join(moduleRoot, "schemas", "index.yaml"), schemaRegistry);

  for (const promptId of workflowPrompts) {
    if (prompts[promptId]) continue;
    const workflow = workflows.find((item) => object(item.prompt)?.id === promptId)!;
    const entityId = String(workflow.output_entity);
    const relative = `generated/${promptId}/v1.0.0.md`;
    prompts[promptId] = { active_version: "1.0.0", path: relative, versions: { "1.0.0": relative }, status: "active" };
    await fs.mkdir(path.dirname(path.join(moduleRoot, "prompts", relative)), { recursive: true });
    const safeSummaryInstruction = summarySourceEntities.has(entityId)
      ? " Include safe_summary: an explicit concise representation safe for later periodic summaries; never derive it from hidden or sensitive text."
      : "";
    await fs.writeFile(path.join(moduleRoot, "prompts", relative), `---\nprompt_id: ${promptId}\nprompt_version: 1.0.0\nmodule: ${moduleId}\ntask_type: normalization\noutput_schema: https://pkb.local/schemas/${moduleId}/${entityId}.schema.json\nstatus: active\n---\n\nReturn only a valid ${entityId} result. Preserve facts, references, and uncertainty.${safeSummaryInstruction}\n`, "utf8");
  }
  promptRegistry.prompts = prompts;
  writeYaml(moduleRoot, path.join(moduleRoot, "prompts", "index.yaml"), promptRegistry);

  for (const output of outputs) {
    const template = String(output.template);
    const target = path.join(moduleRoot, ...template.split("/"));
    if (!(await exists(target))) await fs.writeFile(target, `---\ntype: ${moduleId}-${String(output.entity)}\nschema_id: ${String(output.schema)}\nschema_version: 1\n---\n\n# {{title}}\n`, "utf8");
  }
  const reviewPolicy = parseYaml(moduleRoot, path.join(moduleRoot, "rules", "review-policy.yaml"));
  reviewPolicy.critical_fields = strings(object(blueprint.review_policy)?.critical_fields);
  reviewPolicy.critical_field_action = "review-required";
  writeYaml(moduleRoot, path.join(moduleRoot, "rules", "review-policy.yaml"), reviewPolicy);
  const qualityFields: JsonObject = {};
  for (const entity of entities) {
    const entityId = String(entity.id);
    for (const [fieldId, raw] of Object.entries(object(object(entity.schema)?.fields) ?? {})) {
      const field = object(raw) ?? {};
      const contract: JsonObject = {};
      if (field.critical === true) contract.critical = true;
      if (field.provenance_required === true) contract.provenance = "required";
      if (typeof field.freshness_days === "number") contract.verification_interval_days = field.freshness_days;
      if (Object.keys(contract).length) qualityFields[`${entityId}.${fieldId}`] = contract;
    }
  }
  const qualityPolicy: JsonObject = {
    critical_fields: Object.entries(qualityFields).filter(([, field]) => object(field)?.critical === true).map(([field]) => field),
    provenance_required: Object.entries(qualityFields).filter(([, field]) => object(field)?.provenance === "required").map(([field]) => field),
    freshness: {}, field_policies: qualityFields,
    ownership: {}, audits: ["stale-fields", "missing-provenance", "schema-version", "instance-task"], orphan_exempt_entity_types: [],
    default_verification_interval_days: 30,
  };
  writeYaml(moduleRoot, path.join(moduleRoot, "rules", "quality-policy.yaml"), qualityPolicy);
  manifest.quality = { policy: "rules/quality-policy.yaml" };
  writeYaml(moduleRoot, path.join(moduleRoot, "rules", "ownership.yaml"), {
    user_original_content_mutable: object(blueprint.privacy)?.user_original_content_mutable === true,
    generated_entities: entityIdsForOwnership(entities),
    forbidden_operations: object(blueprint.privacy)?.user_original_content_mutable === true ? [] : ["update-user-original", "overwrite-source"],
  });
  const machines = Object.fromEntries(entities.flatMap((entity) => {
    const lifecycle = object(entity.lifecycle);
    return lifecycle ? [[String(entity.id), {
      status_field: "status",
      initial: typeof lifecycle.initial === "string" ? lifecycle.initial : "",
      transitions: object(lifecycle.transitions) ?? {},
    }]] : [];
  }));
  if (Object.keys(machines).length) writeYaml(moduleRoot, path.join(moduleRoot, "rules", "state-machines.yaml"), { machines });
  const dashboard = parseYaml(moduleRoot, path.join(moduleRoot, "dashboard", "provider.yaml"));
  dashboard.items = dashboardProviderItems(strings(object(blueprint.dashboard)?.sections), entities);
  dashboard.version = "2.0.0";
  writeYaml(moduleRoot, path.join(moduleRoot, "dashboard", "provider.yaml"), dashboard);
}

function entityIdsForOwnership(entities: JsonObject[]): string[] { return entities.map((entity) => String(entity.id)); }

function dashboardProviderItems(sections: string[], entities: JsonObject[]): JsonObject[] {
  const entityIds = new Set(entities.map((entity) => String(entity.id)));
  const recordEntity = entityIds.has("knowledge-record") ? "knowledge-record" : entityIds.has("record") ? "record" : null;
  const items: JsonObject[] = [];
  for (const section of sections) {
    if (section === "upcoming-deadlines" && entityIds.has("assignment")) {
      items.push({ id: section, kind: "due", entity: "assignment", due_field: "deadline", filters: { status: ["planned"] }, window_days: 14, category: "deadline", priority: { overdue: "critical", within_3_days: "high", default: "medium" }, title: "{title}", description: "截止日期：{deadline}", actions: ["open"] });
    } else if (section === "recent-lectures" && entityIds.has("lecture")) {
      items.push({ id: section, kind: "recent", entity: "lecture", date_field: "lecture_date", limit: 5, category: "summary", priority: "low", title: "{title}", description: "课程资料日期：{lecture_date}", actions: ["open"] });
    } else if (section === "recent-records" && recordEntity) {
      items.push({ id: section, kind: "recent", entity: recordEntity, date_field: "created", limit: 5, category: "summary", priority: "low", title: "{title}", description: "记录创建于：{created}", actions: ["open"] });
    } else if (section === "waiting-reviews") {
      items.push({ id: section, kind: "review-summary", category: "status", priority: "high", title: "{count} 项事项等待审核", description: "有 {count} 项等待你的决定。", actions: ["open"] });
    }
  }
  return items;
}

function sourceQuerySteps(workflow: JsonObject, outputs: JsonObject[], representation: string): JsonObject[] {
  return sourceObjects(workflow).map((source, index) => {
    const entity = String(source.entity);
    const output = outputs.find((candidate) => candidate.entity === entity);
    const root = typeof source.root === "string" ? source.root : path.posix.dirname(String(output?.target ?? ""));
    const window = String(source.window);
    const timeWindow = window === "all" ? null
      : window === "current-day" ? { field: String(source.date_field), unit: "day", reference: "{schedule.date}" }
        : window === "current-week" ? { field: String(source.date_field), unit: "week", reference: "{schedule.iso_week}" }
          : { field: String(source.date_field), unit: "on-or-after", reference: "{schedule.date}" };
    return {
      id: `query-${entity}-${index + 1}`,
      uses: "core.query-documents",
      with: {
        root,
        filters: { ...(object(source.filters) ?? {}), instance_id: { equals: "{instance.instance_id}" } },
        time_window: timeWindow,
        schema: entity,
        read: { representation },
      },
    };
  });
}

async function materializeDeclaredWorkflows(moduleRoot: string, blueprint: JsonObject, manifest: JsonObject): Promise<void> {
  const declared = Array.isArray(blueprint.workflows) ? blueprint.workflows.map((item) => object(item)).filter((item): item is JsonObject => Boolean(item)) : [];
  const semantic = isSemanticBlueprint(blueprint);
  const outputs = blueprintOutputObjects(blueprint);
  const inputRoles = blueprintInputRoles(blueprint);
  const inboxRoles = object(object(blueprint.inbox)?.roles) ?? {};
  const requestedRepresentation = String(object(blueprint.privacy)?.default_max_representation ?? "metadata");
  const registryPath = path.join(moduleRoot, "workflows", "index.yaml");
  const registry = parseYaml(moduleRoot, registryPath);
  const current = object(registry.workflows) ?? {};
  const classify = current.classify;
  const nextRegistry: JsonObject = classify ? { classify } : {};
  const captureEntrypoints: JsonObject = {};
  const normalizeTemplate = parseYaml(moduleRoot, path.join(moduleRoot, "workflows", "normalize", "v1.0.0.yaml"));
  const weeklyPath = path.join(moduleRoot, "workflows", "weekly-summary", "v1.0.0.yaml");
  const weeklyTemplate = await exists(weeklyPath) ? parseYaml(moduleRoot, weeklyPath) : normalizeTemplate;
  for (const workflow of declared) {
    const id = String(workflow.id);
    const outputEntity = String(workflow.output_entity ?? "record");
    const output = outputs.find((item) => item.entity === outputEntity);
    const lifecycle = object(entityObjects(blueprint).find((entity) => entity.id === outputEntity)?.lifecycle);
    const operation = object(workflow.operation) ?? {};
    const operationType = String(operation.type ?? "create-record");
    const representation = String(object(workflow.read)?.representation ?? requestedRepresentation);
    const promptId = String(object(workflow.prompt)?.id ?? (workflow.trigger === "schedule" ? "weekly-summary" : "normalize-record"));
    const publications = Array.isArray(workflow.publishes) ? workflow.publishes.map((item) => object(item)).filter((item): item is JsonObject => Boolean(item)) : [];
    const source = workflow.trigger === "schedule" ? weeklyTemplate : normalizeTemplate;
    const generated: JsonObject = JSON.parse(JSON.stringify(source)) as JsonObject;
    generated.workflow_id = id;
    generated.resources = {
      ...(object(generated.resources) ?? {}),
      network: workflow.requires_network === true ? "required" : "not-required",
      codex: workflow.requires_ai === true ? "required" : "not-required",
    };
    if (semantic) {
      const blueprintContract: JsonObject = {
      trigger: String(workflow.trigger ?? ""),
        input_entities: strings(workflow.input_entities), input_roles: strings(workflow.input_roles),
        role_policies: Object.fromEntries(strings(workflow.input_roles).map((role) => [role, { allow_codex: object(inputRoles[role])?.allow_codex !== false }])),
        sources: sourceObjects(workflow), output_entity: outputEntity,
      read: { representation }, prompt_id: promptId,
      operation: object(workflow.operation) ?? {}, publishes: publications.map((publication) => ({ event: String(publication.event), payload: object(publication.payload) ?? {} })),
      };
      generated.blueprint_contract = blueprintContract;
    }
    generated.steps = (Array.isArray(generated.steps) ? generated.steps : []).flatMap((raw) => {
      const step = object(raw);
      if (!step) return [raw];
      if (step.uses === "core.publish-event") return [];
      if (step.uses === "codex.prompt") {
        if (workflow.requires_ai !== true) return [];
        return [{ ...step, with: { ...(object(step.with) ?? {}), prompt_id: promptId, output_schema: semantic ? `https://pkb.local/schemas/${String(object(blueprint.module)?.id)}/${outputEntity}.schema.json` : String(object(step.with)?.output_schema ?? "record") } }];
      }
      if (step.uses === "core.validate-capture" || step.uses === "core.parse-structured-document") return [{ ...step, with: { ...(object(step.with) ?? {}), read: { representation } } }];
      if (step.uses === "core.build-operation-plan" && semantic && output) return [{
        ...step,
        with: {
          output: workflow.trigger === "schedule" ? "summarize" : "normalize",
          output_schema: String(output.schema), target: String(output.target), template: String(output.template),
          operation_type: operationType,
          ...(typeof operation.section === "string" ? { section: operation.section } : {}),
          idempotency_key: workflow.trigger === "schedule"
            ? `${String(object(blueprint.module)?.id)}:{instance.instance_id}:${id}:{schedule.iso_week}`
            : `${String(object(blueprint.module)?.id)}:{instance.instance_id}:${id}:{task.payload.item_id}`,
          summary: `${operationType === "append-record" ? "Append to" : operationType === "update-record" ? "Update" : "Create"} ${outputEntity} from ${id}`,
        },
      }];
      return [step];
    });
    if (semantic && workflow.trigger !== "capture") {
      const queries = sourceQuerySteps(workflow, outputs, representation);
      if (queries.length) {
        const steps = Array.isArray(generated.steps) ? generated.steps.map((item) => object(item)).filter((item): item is JsonObject => Boolean(item)) : [];
        const promptIndex = steps.findIndex((step) => step.uses === "codex.prompt");
        generated.steps = promptIndex < 0 ? [...queries, ...steps] : [...steps.slice(0, promptIndex), ...queries, ...steps.slice(promptIndex)];
      }
    }
    if (semantic && lifecycle && output) {
      const steps = Array.isArray(generated.steps) ? generated.steps.map((item) => object(item)).filter((item): item is JsonObject => Boolean(item)) : [];
      const planIndex = steps.findIndex((step) => step.uses === "core.build-operation-plan");
      const validation = {
        id: `validate-${outputEntity}-transition`, uses: "component.state-transition-validation",
        with: {
          target: String(output.target), proposed_from: workflow.trigger === "schedule" ? "summarize" : "normalize", status_field: "status",
          lifecycle: { initial: typeof lifecycle.initial === "string" ? lifecycle.initial : "", transitions: object(lifecycle.transitions) ?? {} },
        },
      };
      generated.steps = planIndex < 0 ? [...steps, validation] : [...steps.slice(0, planIndex), validation, ...steps.slice(planIndex)];
    }
    const reviewWhen = Array.isArray(workflow.review_when) ? workflow.review_when.map((item) => object(item)).filter((item): item is JsonObject => Boolean(item)) : [];
    if (semantic && reviewWhen.length && output) {
      const steps = Array.isArray(generated.steps) ? generated.steps.map((item) => object(item)).filter((item): item is JsonObject => Boolean(item)) : [];
      const planIndex = steps.findIndex((step) => step.uses === "core.build-operation-plan");
      const ruleStep = {
        id: `require-${outputEntity}-review`, uses: "core.require-review-if",
        with: { target: String(output.target), proposed_from: workflow.trigger === "schedule" ? "summarize" : "normalize", rules: reviewWhen.map((rule) => ({ field: String(rule.field), condition: String(rule.condition) })) },
      };
      generated.steps = planIndex < 0 ? [...steps, ruleStep] : [...steps.slice(0, planIndex), ruleStep, ...steps.slice(planIndex)];
    }
    if (workflow.trigger === "schedule" && !semantic) {
      const steps = Array.isArray(generated.steps) ? generated.steps.map((item) => object(item)).filter((item): item is JsonObject => item !== null) : [];
      generated.steps = steps.map((step) => step.uses === "core.build-operation-plan" ? {
        ...step,
        with: {
          output: "summarize", output_schema: "record", target: "{instance.content_root}/Summaries/{schedule.iso_week}.md",
          template: "templates/record.md", idempotency_key: `${String(object(blueprint.module)?.id)}:{instance.instance_id}:${id}:{schedule.iso_week}`, summary: `Create ${id}`,
        },
      } : step);
    }
    if (semantic && publications.length) {
      const steps = Array.isArray(generated.steps) ? generated.steps.map((item) => object(item)).filter((item): item is JsonObject => Boolean(item)) : [];
      for (const publication of publications) {
        const payload = object(publication.payload);
        const source = workflow.trigger === "schedule" ? "summarize" : "normalize";
        // Blueprint payloads describe an output contract with {output.field}.
        // The generic Event step already supports payload_from/payload_fields;
        // materialize that form instead of leaving an interpolation token that
        // the runtime deliberately does not expose as a global variable.
        const fields = payload && Object.values(payload).every((value) => typeof value === "string" && /^\{output\.[A-Za-z0-9_.-]+\}$/.test(value))
          ? Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, String(value).slice("{output.".length, -1)]))
          : null;
        steps.push({ id: `publish-${String(publication.event).replace(/[^a-z0-9]+/g, "-")}`, uses: "core.publish-event", with: {
          event_type: String(publication.event),
          ...(fields ? { payload_from: source, payload_fields: fields } : payload ? { payload } : { payload_from: source }),
        } });
      }
      generated.steps = steps;
      generated.outputs = [...strings(generated.outputs).filter((item) => item !== "events"), "events"];
    } else generated.outputs = strings(generated.outputs).filter((item) => item !== "events");
    const relative = `${id}/v1.0.0.yaml`;
    writeYaml(moduleRoot, path.join(moduleRoot, "workflows", id, "v1.0.0.yaml"), generated);
    nextRegistry[id] = { active_version: "1.0.0", path: relative, versions: { "1.0.0": relative } };
    if (workflow.trigger === "capture" && Object.keys(captureEntrypoints).length === 0) captureEntrypoints.capture = `workflows/${relative}`;
    for (const role of strings(workflow.input_roles)) {
      if (object(inboxRoles[role])?.entrypoint === id) captureEntrypoints[id] = `workflows/${relative}`;
    }
  }
  registry.workflows = nextRegistry;
  writeYaml(moduleRoot, registryPath, registry);
  manifest.entry_workflows = { ...(object(manifest.entry_workflows) ?? {}), ...captureEntrypoints };
  const reviewConditions = Object.fromEntries(declared.flatMap((workflow) => {
    const rules = Array.isArray(workflow.review_when) ? workflow.review_when.map((item) => object(item)).filter((item): item is JsonObject => Boolean(item)) : [];
    return rules.length ? [[String(workflow.id), rules.map((rule) => ({ field: String(rule.field), condition: String(rule.condition) }))]] : [];
  }));
  if (Object.keys(reviewConditions).length) writeYaml(moduleRoot, path.join(moduleRoot, "rules", "review-conditions.yaml"), { workflows: reviewConditions });

  const jobs = Array.isArray(blueprint.jobs) ? blueprint.jobs.map((item) => object(item)).filter((item): item is JsonObject => Boolean(item)) : [];
  const scheduledWorkflow = declared.find((workflow) => workflow.trigger === "schedule");
  const jobEntries: JsonObject[] = jobs.map((job) => {
    const id = String(job.id);
    const workflowId = semantic ? String(job.workflow_id) : declared.some((workflow) => workflow.id === id) ? id : String(scheduledWorkflow?.id ?? id);
    const workflow = declared.find((item) => item.id === workflowId) ?? scheduledWorkflow;
    const schedule = String(job.schedule);
    const trigger: JsonObject = schedule === "weekly"
      ? { type: "weekly", weekday: String(job.weekday ?? "Sun"), at: String(job.at), timezone: String(job.timezone) }
      : schedule === "daily" ? { type: "daily", at: String(job.at), timezone: String(job.timezone) }
        : schedule === "monthly" ? { type: "monthly", day: Number(job.day ?? 1), at: String(job.at), timezone: String(job.timezone) }
          : schedule === "startup" ? { type: "startup", ...(job.dedupe === "daily" ? { dedupe: "daily", timezone: String(job.timezone) } : {}) }
            : schedule === "field-due" ? { type: "field-due", source_root: String(job.source_root), field: String(job.field), id_field: String(job.id_field) }
              : schedule === "event" ? {
                type: "event", event: String(job.event), subscription_scope: String(job.subscription_scope),
                ...(Array.isArray(job.source_modules) ? { source_modules: job.source_modules } : {}),
              }
                : (() => { throw new PkbError("BLUEPRINT_TRIGGER_UNSUPPORTED", `Unsupported Blueprint Job schedule ${schedule}.`); })();
    return {
      id, scope: String(job.scope ?? "instance"), enabled: true, task_type: "workflow", workflow: `${String(object(blueprint.module)?.id)}:${workflowId}`,
      workflow_id: workflowId, workflow_version: "1.0.0", trigger,
      resources: { filesystem: "required", network: workflow?.requires_network === true ? "required" : "not-required", codex: workflow?.requires_ai === true ? "required" : "not-required", user: "not-required" },
      catch_up: { policy: String(job.catch_up), max_age_days: Number(job.max_age_days ?? 21) }, retry: object(job.retry) ?? { max_attempts: 3 },
      concurrency: object(job.concurrency) ?? { policy: "forbid", key: `${String(object(blueprint.module)?.id)}:{instance}:${id}` }, priority: "normal",
    };
  });
  writeYaml(moduleRoot, path.join(moduleRoot, "jobs", "jobs.yaml"), { jobs: jobEntries });
}

async function materializeBlueprintTestContract(moduleRoot: string, blueprint: JsonObject): Promise<void> {
  const moduleInfo = object(blueprint.module)!;
  const moduleId = String(moduleInfo.id);
  const displayName = String(moduleInfo.display_name);
  const workflows = Array.isArray(blueprint.workflows) ? blueprint.workflows.map((item) => object(item)).filter((item): item is JsonObject => item !== null) : [];
  const jobs = Array.isArray(blueprint.jobs) ? blueprint.jobs.map((item) => object(item)).filter((item): item is JsonObject => item !== null) : [];
  const events = object(blueprint.events)!;
  const firstJob = jobs[0];
  const firstScheduled = workflows.find((workflow) => workflow.trigger === "schedule");
  const weeklyOutput = `20-Workspace/${displayName}/sample-instance/Summaries/2026-W32.md`;
  const record = (id: string, title: string): JsonObject => ({ id, type: `${moduleId}-record`, schema_id: "record", schema_version: 1, module_version: "0.1.0", instance_id: "sample-instance", title, source_refs: [], created: "2026-08-09T18:00:00Z", updated: "2026-08-09T18:00:00Z" });
  const contractPath = path.join(moduleRoot, "fixtures", "sample-instance", "module-test.yaml");
  const contract = parseYaml(moduleRoot, contractPath);
  const scenarios = object(contract.scenarios)!;
  scenarios.periodic_job = firstJob && firstScheduled ? { enabled: true, job_id: `${moduleId}.${String(firstJob.id)}.sample-instance`, scheduled_at: "2026-08-09T10:00:00Z", expected_output: weeklyOutput, codex_output: record(`${moduleId}-weekly-2026-W32`, "2026-W32 Weekly Summary") } : { enabled: false };
  const publishes = strings(events.publishes);
  scenarios.event_publication = publishes.length ? { enabled: true, event_type: publishes[0]! } : { enabled: false };
  scenarios.event_consumption = strings(events.subscribes).length ? (scenarios.event_consumption ?? { enabled: false }) : { enabled: false };
  scenarios.pdf_policy = strings(blueprint.inputs).includes("pdf") ? { enabled: true, partial_expected: "review" } : { enabled: false };
  scenarios.partial_pdf_execution = { enabled: false };
  writeYaml(moduleRoot, contractPath, contract);
}

function renderBoundaryDocument(blueprint: JsonObject): string {
  const moduleInfo = object(blueprint.module)!;
  const useCases = object(blueprint.use_cases)!;
  const privacy = object(blueprint.privacy)!;
  const bullet = (items: string[]): string => items.map((item) => `- ${item}`).join("\n");
  return `# ${String(moduleInfo.display_name)} Blueprint Boundary\n\n## Primary use cases\n\n${bullet(strings(useCases.primary))}\n\n## Explicitly excluded\n\n${bullet(strings(useCases.excluded))}\n\n## Privacy contract\n\n- Default sensitivity class: ${String(privacy.default_sensitivity_class)}\n- Maximum representation: ${String(privacy.default_max_representation)}\n- Network allowed: ${String(privacy.network_allowed)}\n- User original content mutable: ${String(privacy.user_original_content_mutable)}\n\nThis document is generated from module.blueprint.yaml. Change the Blueprint and regenerate instead of editing this file as the design source.\n`;
}
