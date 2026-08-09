import path from "node:path";
import { parseYaml } from "../core/bridge.js";
import { exists } from "../core/files.js";
import type { JsonObject, JsonValue } from "../core/types.js";
import { blueprintEventNames, isSemanticBlueprint, validateModuleBlueprint, type BlueprintCheck } from "./blueprint.js";

function object(value: JsonValue | undefined): JsonObject | null { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null; }
function strings(value: JsonValue | undefined): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function sameSet(left: string[], right: string[]): boolean { return left.length === right.length && left.every((item) => right.includes(item)); }

function subscriptionKeys(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [JSON.stringify({ event: item })];
    const subscription = object(item);
    return subscription ? [JSON.stringify({
      event: subscription.event,
      ...(typeof subscription.scope === "string" ? { scope: subscription.scope } : {}),
      ...(Array.isArray(subscription.source_modules) ? { source_modules: subscription.source_modules } : {}),
    })] : [];
  });
}

function entries(value: JsonValue | undefined): JsonObject[] { return Array.isArray(value) ? value.map((item) => object(item)).filter((item): item is JsonObject => Boolean(item)) : []; }
function blueprintInboxRoles(blueprint: JsonObject): JsonObject {
  return object(object(blueprint.inbox)?.roles) ?? {};
}
function runtimeInboxRoleContract(role: JsonObject | null): JsonObject {
  const access = object(role?.asset_access_policy) ?? {};
  return {
    inbox_subpath: role?.inbox_subpath ?? null,
    access_policy: { sensitivity_class: access.sensitivity_class ?? null, max_representation: access.max_representation ?? null },
    ...(typeof role?.entrypoint === "string" ? { entrypoint: role.entrypoint } : {}),
    ...(typeof role?.required_user_action === "string" ? { required_user_action: role.required_user_action } : {}),
    allow_codex: role?.allow_codex !== false,
  };
}
function dashboardSectionIds(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.map((item) => typeof item === "string" ? item : object(item)?.id).filter((item): item is string => typeof item === "string")
    : [];
}
function registryPath(moduleRoot: string, entry: JsonObject | null): string | null { return typeof entry?.path === "string" ? path.join(moduleRoot, "workflows", ...entry.path.replace(/^workflows\//, "").split("/")) : null; }

async function semanticRuntimeCompliance(moduleRoot: string, blueprint: JsonObject, manifest: JsonObject, checks: BlueprintCheck[]): Promise<void> {
  const add = (code: string, ok: boolean, message: string, itemPath: string): void => { checks.push({ code, status: ok ? "pass" : "fail", message, path: itemPath }); };
  const entities = entries(blueprint.entities);
  const outputs = entries(blueprint.outputs);
  const workflows = entries(blueprint.workflows);
  const schemas = object(parseYaml(moduleRoot, path.join(moduleRoot, "schemas", "index.yaml")).schemas) ?? {};
  const prompts = object(parseYaml(moduleRoot, path.join(moduleRoot, "prompts", "index.yaml")).prompts) ?? {};
  const workflowRegistry = object(parseYaml(moduleRoot, path.join(moduleRoot, "workflows", "index.yaml")).workflows) ?? {};
  const reviewPolicy = parseYaml(moduleRoot, path.join(moduleRoot, "rules", "review-policy.yaml"));
  const qualityDescriptor = object(manifest.quality);
  const qualityPath = typeof qualityDescriptor?.policy === "string" ? path.join(moduleRoot, ...qualityDescriptor.policy.split("/")) : null;
  const qualityPolicy = qualityPath && await exists(qualityPath) ? parseYaml(moduleRoot, qualityPath) : null;
  const ownershipPath = path.join(moduleRoot, "rules", "ownership.yaml");
  const ownership = await exists(ownershipPath) ? parseYaml(moduleRoot, ownershipPath) : {};
  const dashboard = parseYaml(moduleRoot, path.join(moduleRoot, "dashboard", "provider.yaml"));
  const entityIds = new Set(entities.map((entity) => String(entity.id)));
  const declaredInbox = object(blueprint.inbox) ?? {};
  const declaredRoles = blueprintInboxRoles(blueprint);
  const runtimeInbox = object(manifest.inbox) ?? {};
  const runtimeRoles = object(runtimeInbox.asset_roles) ?? {};
  if (Object.keys(declaredRoles).length) {
    const expected = Object.fromEntries(Object.entries(declaredRoles).map(([roleId, rawRole]) => {
      const role = object(rawRole) ?? {};
      return [roleId, {
        inbox_subpath: role.inbox_subpath,
        access_policy: object(role.access_policy) ?? {},
        ...(typeof role.entrypoint === "string" ? { entrypoint: role.entrypoint } : {}),
        ...(typeof role.required_user_action === "string" ? { required_user_action: role.required_user_action } : {}),
        allow_codex: role.allow_codex !== false,
      }];
    }));
    const actual = Object.fromEntries(Object.entries(runtimeRoles).map(([roleId, rawRole]) => [roleId, runtimeInboxRoleContract(object(rawRole))]));
    add("V2_INBOX_ROLE_CONTRACT_BOUND", runtimeInbox.default_asset_role === declaredInbox.default_asset_role
      && JSON.stringify(actual) === JSON.stringify(expected),
    "Runtime Inbox roles exactly materialize Blueprint routing, access, and user-action contracts.", "inbox.roles");
  }

  for (const entity of entities) {
    const id = String(entity.id);
    const schema = object(schemas[id]);
    const schemaPath = typeof schema?.path === "string" ? path.join(moduleRoot, "schemas", ...schema.path.split("/")) : null;
    add("V2_ENTITY_SCHEMA_BOUND", Boolean(schemaPath && await exists(schemaPath)), `${id} has a runtime Schema Registry entry.`, `schemas.${id}`);
  }
  for (const output of outputs) {
    const id = String(output.id);
    const schemaId = String(output.schema);
    const schema = object(schemas[schemaId]);
    const template = typeof output.template === "string" ? path.join(moduleRoot, ...String(output.template).split("/")) : null;
    add("V2_OUTPUT_SCHEMA_TEMPLATE_BOUND", Boolean(schema && template && await exists(template)), `${id} has its Schema and template materialized.`, `outputs.${id}`);
  }
  for (const workflow of workflows) {
    const id = String(workflow.id);
    const entry = object(workflowRegistry[id]);
    const file = registryPath(moduleRoot, entry);
    if (!file || !(await exists(file))) { add("V2_WORKFLOW_RUNTIME_MISSING", false, `${id} has no runtime Workflow file.`, `workflows.${id}`); continue; }
    const runtime = parseYaml(moduleRoot, file);
    const contract = object(runtime.blueprint_contract);
    const contractRead = object(contract?.read);
    add("V2_WORKFLOW_CONTRACT_BOUND", Boolean(contract)
      && contract?.trigger === workflow.trigger
      && contract?.output_entity === workflow.output_entity
      && contractRead?.representation === object(workflow.read)?.representation,
    `${id} runtime Workflow matches trigger, output entity, and read policy.`, `workflows.${id}`);
    const steps = entries(runtime.steps);
    const promptId = String(object(workflow.prompt)?.id ?? "");
    const promptStep = steps.find((step) => step.uses === "codex.prompt");
    add("V2_WORKFLOW_PROMPT_BOUND", workflow.requires_ai !== true || (Boolean(prompts[promptId]) && object(promptStep?.with)?.prompt_id === promptId), `${id} binds its declared Prompt.`, `workflows.${id}.prompt`);
    const output = outputs.find((item) => item.entity === workflow.output_entity);
    const plan = steps.find((step) => step.uses === "core.build-operation-plan");
    const planWith = object(plan?.with);
    add("V2_WORKFLOW_OUTPUT_BOUND", Boolean(output) && planWith?.output_schema === output?.schema && planWith?.target === output?.target && planWith?.template === output?.template, `${id} binds its declared output Schema, target, and template.`, `workflows.${id}.operation`);
    const declaredOperation = object(workflow.operation);
    add("V2_WORKFLOW_OPERATION_MODE_BOUND", Boolean(declaredOperation) && planWith?.operation_type === declaredOperation?.type,
      `${id} passes its declared ${String(declaredOperation?.type ?? "record")} mode into the runtime Operation Plan builder.`, `workflows.${id}.operation.type`);
    const lifecycle = object(entities.find((entity) => String(entity.id) === String(workflow.output_entity))?.lifecycle);
    if (lifecycle) {
      const transitionStep = steps.find((step) => step.uses === "component.state-transition-validation");
      const transitionWith = object(transitionStep?.with);
      const expectedProposedFrom = workflow.trigger === "schedule" ? "summarize" : "normalize";
      const lifecycleMatches = JSON.stringify(transitionWith?.lifecycle) === JSON.stringify({ initial: lifecycle.initial, transitions: lifecycle.transitions });
      add("V2_WORKFLOW_LIFECYCLE_BOUND", Boolean(transitionStep) && transitionWith?.target === output?.target
        && transitionWith?.status_field === "status" && transitionWith?.proposed_from === expectedProposedFrom && lifecycleMatches,
      `${id} binds its declared lifecycle to the state-transition validation Component.`, `workflows.${id}.lifecycle`);
    }
    const reviewWhen = entries(workflow.review_when);
    if (reviewWhen.length) {
      const ruleStep = steps.find((step) => step.uses === "core.require-review-if");
      const ruleWith = object(ruleStep?.with);
      const expectedRules = reviewWhen.map((rule) => ({ field: String(rule.field), condition: String(rule.condition) }));
      add("V2_WORKFLOW_REVIEW_RULES_BOUND", Boolean(ruleStep) && ruleWith?.target === output?.target
        && ruleWith?.proposed_from === (workflow.trigger === "schedule" ? "summarize" : "normalize")
        && JSON.stringify(ruleWith?.rules) === JSON.stringify(expectedRules),
      `${id} binds its declared review_when rules to Core's deterministic Review gate.`, `workflows.${id}.review_when`);
    }
    const blueprintRoles = Object.keys(declaredRoles).length
      ? Object.fromEntries(Object.entries(declaredRoles).map(([roleId, rawRole]) => [roleId, { allow_codex: object(rawRole)?.allow_codex !== false }]))
      : object(object(blueprint.privacy)?.input_roles) ?? {};
    const runtimeRolePolicies = object(contract?.role_policies) ?? {};
    const workflowRoles = strings(workflow.input_roles);
    add("V2_WORKFLOW_ROLE_CODEX_BOUND", workflowRoles.every((role) => object(runtimeRolePolicies[role])?.allow_codex === (object(blueprintRoles[role])?.allow_codex !== false)),
      `${id} materializes each input role's Codex permission into its runtime contract.`, `workflows.${id}.input_roles`);
    const publications = entries(workflow.publishes);
    const actualEvents = steps.filter((step) => step.uses === "core.publish-event").map((step) => String(object(step.with)?.event_type ?? ""));
    add("V2_WORKFLOW_EVENTS_BOUND", sameSet(actualEvents, publications.map((publication) => String(publication.event))), `${id} publishes only its explicitly declared Events.`, `workflows.${id}.publishes`);
  }
  const declaredCritical = Array.isArray(reviewPolicy.critical_fields) ? reviewPolicy.critical_fields.filter((field): field is string => typeof field === "string") : [];
  const expectedCritical = entities.flatMap((entity) => Object.entries(object(object(entity.schema)?.fields) ?? {}).flatMap(([field, raw]) => object(raw)?.critical === true ? [`${String(entity.id)}.${field}`] : []));
  add("V2_CRITICAL_REVIEW_BOUND", sameSet(declaredCritical, expectedCritical), "Critical Entity fields and runtime Review Policy agree.", "rules/review-policy.yaml");
  const expectedQuality = Object.fromEntries(entities.flatMap((entity) => Object.entries(object(object(entity.schema)?.fields) ?? {}).flatMap(([fieldId, raw]) => {
    const field = object(raw) ?? {}; const value: JsonObject = {};
    if (field.critical === true) value.critical = true;
    if (field.provenance_required === true) value.provenance = "required";
    if (typeof field.freshness_days === "number") value.verification_interval_days = field.freshness_days;
    return Object.keys(value).length ? [[`${String(entity.id)}.${fieldId}`, value]] : [];
  })));
  add("V2_QUALITY_POLICY_BOUND", Boolean(qualityPolicy) && JSON.stringify(object(qualityPolicy?.field_policies) ?? {}) === JSON.stringify(expectedQuality),
    "Blueprint field quality requirements are materialized into the runtime Quality Policy.", "rules/quality-policy.yaml");
  const expectedImmutable = object(blueprint.privacy)?.user_original_content_mutable === true;
  add("V2_IMMUTABLE_CONTENT_BOUND", ownership.user_original_content_mutable === expectedImmutable && (expectedImmutable || Array.isArray(ownership.forbidden_operations)), "Runtime ownership policy enforces the Blueprint original-content policy.", "rules/ownership.yaml");
  add("V2_DASHBOARD_BOUND", sameSet(dashboardSectionIds(dashboard.items), strings(object(blueprint.dashboard)?.sections)), "Runtime Dashboard materializes Blueprint sections as executable provider descriptors.", "dashboard/provider.yaml");

  const jobs = entries(blueprint.jobs);
  const jobRegistry = parseYaml(moduleRoot, path.join(moduleRoot, "jobs", "jobs.yaml"));
  const runtimeJobs = entries(jobRegistry.jobs);
  for (const job of jobs) {
    const runtime = runtimeJobs.find((item) => item.id === job.id);
    add("V2_JOB_WORKFLOW_BOUND", Boolean(runtime) && runtime?.workflow_id === job.workflow_id && runtime?.scope === job.scope, `${String(job.id)} binds its declared Workflow and scope.`, `jobs.${String(job.id)}`);
  }
  const events = object(blueprint.events);
  const mapped = workflows.flatMap((workflow) => entries(workflow.publishes).map((publication) => String(publication.event)));
  add("V2_EVENT_MAPPINGS_COMPLETE", sameSet(blueprintEventNames(events?.publishes), mapped), "Every published Event is explicitly mapped to a Workflow.", "events.publishes");
  for (const output of outputs) add("V2_OUTPUT_ENTITY_EXISTS", entityIds.has(String(output.entity)), `${String(output.id)} references a declared Entity.`, `outputs.${String(output.id)}`);
}

export async function validateBlueprintCompliance(engineRoot: string, moduleRoot: string): Promise<JsonObject> {
  const blueprintPath = path.join(moduleRoot, "module.blueprint.yaml");
  if (!(await exists(blueprintPath))) return { report_version: 1, module_id: path.basename(moduleRoot), overall: "NOT-APPLICABLE", checks: [] };
  const { blueprint, report: blueprintReport } = await validateModuleBlueprint(engineRoot, blueprintPath);
  const manifest = parseYaml(moduleRoot, path.join(moduleRoot, "module.yaml"));
  const checks: BlueprintCheck[] = [];
  const add = (code: string, ok: boolean, message: string, itemPath: string): void => { checks.push({ code, status: ok ? "pass" : "fail", message, path: itemPath }); };
  const moduleInfo = object(blueprint.module)!;
  const moduleClass = object(blueprint.module_class)!;
  const privacy = object(blueprint.privacy)!;
  const events = object(blueprint.events)!;
  add("BLUEPRINT_MODULE_ID_MATCH", manifest.id === moduleInfo.id, "Runtime module ID matches Blueprint.", "module.yaml");
  add("BLUEPRINT_MODULE_CLASS_MATCH", manifest.module_type === moduleClass.type, "Runtime module class matches Blueprint.", "module.yaml");
  add("BLUEPRINT_INPUTS_MATCH", sameSet(strings(manifest.accepted_inputs), strings(blueprint.inputs)), "Runtime input formats match Blueprint.", "module.yaml");
  const runtimeCapabilities = strings(manifest.capabilities);
  add("BLUEPRINT_CAPABILITIES_PRESENT", blueprintReport.resolved_capabilities.every((item) => runtimeCapabilities.includes(item)), "Resolved Capability Pack capabilities are present.", "module.yaml");
  const inbox = object(manifest.inbox); const policy = object(inbox?.asset_access_policy); const permissions = object(manifest.permissions);
  add("BLUEPRINT_SENSITIVITY_MATCH", policy?.sensitivity_class === privacy.default_sensitivity_class && permissions?.max_sensitivity_class === privacy.default_sensitivity_class, "Runtime sensitivity policy matches Blueprint.", "module.yaml");
  add("BLUEPRINT_REPRESENTATION_MATCH", policy?.max_representation === privacy.default_max_representation, "Runtime representation policy matches Blueprint.", "module.yaml");
  add("BLUEPRINT_NETWORK_MATCH", permissions?.network === privacy.network_allowed, "Runtime network permission matches Blueprint.", "module.yaml");
  for (const rule of blueprintReport.required_rule_files) {
    const rulePath = path.join(moduleRoot, "rules", `${rule}.yaml`);
    add("CAPABILITY_PACK_RUNTIME_RULE_BOUND", await exists(rulePath), `Capability Pack required rule ${rule}.yaml is materialized.`, `rules/${rule}.yaml`);
    if (rule === "ownership" && await exists(rulePath)) {
      const ownership = parseYaml(moduleRoot, rulePath);
      const expectedMutable = privacy.user_original_content_mutable === true;
      add("CAPABILITY_PACK_OWNERSHIP_ENFORCED", ownership.user_original_content_mutable === expectedMutable
        && (expectedMutable || Array.isArray(ownership.forbidden_operations)),
      "Capability Pack ownership policy is enforced by the generated runtime rule.", "rules/ownership.yaml");
    }
  }
  const runtimeEvents = object(manifest.events);
  add("BLUEPRINT_PUBLISHED_EVENTS_MATCH", sameSet(strings(runtimeEvents?.publishes), strings(events.publishes)), "Published Events match Blueprint.", "module.yaml");
  add("BLUEPRINT_SUBSCRIBED_EVENTS_MATCH", sameSet(subscriptionKeys(runtimeEvents?.subscribes), subscriptionKeys(events.subscribes)), "Subscribed Events match Blueprint.", "module.yaml");
  const workflowRegistry = parseYaml(moduleRoot, path.join(moduleRoot, "workflows", "index.yaml"));
  const runtimeWorkflows = object(workflowRegistry.workflows) ?? {};
  const declaredWorkflows = Array.isArray(blueprint.workflows) ? blueprint.workflows.map((item) => object(item)).filter((item): item is JsonObject => Boolean(item)).map((item) => String(item.id)) : [];
  add("BLUEPRINT_WORKFLOWS_PRESENT", declaredWorkflows.every((id) => Boolean(runtimeWorkflows[id])), "Every Blueprint Workflow is registered.", "workflows/index.yaml");
  const jobRegistry = parseYaml(moduleRoot, path.join(moduleRoot, "jobs", "jobs.yaml"));
  const runtimeJobs = Array.isArray(jobRegistry.jobs) ? jobRegistry.jobs.map((item) => object(item)).filter((item): item is JsonObject => Boolean(item)).map((item) => String(item.id)) : [];
  const declaredJobs = Array.isArray(blueprint.jobs) ? blueprint.jobs.map((item) => object(item)).filter((item): item is JsonObject => Boolean(item)).map((item) => String(item.id)) : [];
  add("BLUEPRINT_JOBS_PRESENT", declaredJobs.every((id) => runtimeJobs.includes(id)), "Every Blueprint Job is registered.", "jobs/jobs.yaml");
  if (isSemanticBlueprint(blueprint)) await semanticRuntimeCompliance(moduleRoot, blueprint, manifest, checks);
  const failed = checks.filter((item) => item.status === "fail").length;
  const semanticChecks = checks.filter((item) => item.code.startsWith("V2_"));
  return {
    report_version: 2, module_id: String(moduleInfo.id), blueprint_validation: blueprintReport.overall,
    structural_compliance: checks.some((item) => item.code.startsWith("BLUEPRINT_" ) && item.status === "fail") ? "FAIL" : "PASS",
    behavioral_compliance: semanticChecks.some((item) => ["V2_WORKFLOW_CONTRACT_BOUND", "V2_WORKFLOW_EVENTS_BOUND", "V2_JOB_WORKFLOW_BOUND"].includes(item.code) && item.status === "fail") ? "FAIL" : "PASS",
    privacy_compliance: semanticChecks.some((item) => ["V2_IMMUTABLE_CONTENT_BOUND", "V2_CRITICAL_REVIEW_BOUND"].includes(item.code) && item.status === "fail") ? "FAIL" : "PASS",
    business_semantic_compliance: isSemanticBlueprint(blueprint) ? semanticChecks.some((item) => item.status === "fail") ? "FAIL" : "PASS" : "NOT-APPLICABLE",
    overall: failed ? "FAIL" : "PASS", checks,
  };
}
