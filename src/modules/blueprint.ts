import { promises as fs } from "node:fs";
import path from "node:path";
import { availableIngestionAdapter } from "../core/adapterRegistry.js";
import { parseYaml, validateSchema, writeYaml } from "../core/bridge.js";
import { PkbError } from "../core/errors.js";
import { exists } from "../core/files.js";
import type { JsonObject, JsonValue } from "../core/types.js";
import { createModuleScaffold } from "./scaffold.js";
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
  overall: "PASS" | "PASS WITH WARNINGS" | "FAIL";
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

function representationRank(value: string): number {
  return ["metadata", "summary", "full", "sensitive-original"].indexOf(value);
}

function check(code: string, status: BlueprintCheck["status"], message: string, itemPath: string | null = null): BlueprintCheck {
  return { code, status, message, path: itemPath };
}

function addUnique(target: string[], values: string[]): void {
  for (const value of values) if (!target.includes(value)) target.push(value);
}

export async function validateModuleBlueprint(engineRoot: string, blueprintPath: string): Promise<ResolvedBlueprint> {
  const absolute = path.resolve(blueprintPath);
  if (!(await exists(absolute))) throw new PkbError("BLUEPRINT_NOT_FOUND", `Module Blueprint not found: ${absolute}`);
  const blueprint = parseYaml(path.dirname(absolute), absolute);
  validateSchema(engineRoot, BLUEPRINT_SCHEMA, blueprint);
  const registryPath = path.join(engineRoot, PACK_REGISTRY);
  if (!(await exists(registryPath))) throw new PkbError("CAPABILITY_PACK_REGISTRY_MISSING", `Capability Pack Registry not found: ${registryPath}`);
  const registry = parseYaml(engineRoot, registryPath);
  const packs = object(registry.packs) ?? {};
  const templates = object(registry.base_templates) ?? {};
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
  const inputRoles = object(privacy?.input_roles) ?? {};
  const workflows = workflowObjects(blueprint);
  const workflowIds = workflows.map((workflow) => String(workflow.id));
  const events = object(blueprint.events);
  const publishedEvents = blueprintEventNames(events?.publishes);

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
      checks.push(initial && Object.prototype.hasOwnProperty.call(transitions, initial)
        ? check("SEMANTIC_LIFECYCLE_VALID", "pass", `${entityId} lifecycle has an initial state and transitions.`, `entities.${entityId}.lifecycle`)
        : check("SEMANTIC_LIFECYCLE_INVALID", "fail", `${entityId} lifecycle initial state must be a transition key.`, `entities.${entityId}.lifecycle`));
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
    const valid = workflowIds.includes(workflowId) && typeof job.scope === "string" && (job.schedule === "event" || job.schedule === "startup" || (typeof job.timezone === "string" && typeof job.at === "string"));
    checks.push(valid
      ? check("SEMANTIC_JOB_WORKFLOW_BOUND", "pass", `${jobId} explicitly binds ${workflowId}.`, `jobs.${jobId}`)
      : check("SEMANTIC_JOB_WORKFLOW_REQUIRED", "fail", `${jobId} must bind a declared Workflow and provide scope and schedule details.`, `jobs.${jobId}`));
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
  manifest.permissions = {
    ...(object(manifest.permissions) ?? {}),
    max_sensitivity_class: Number(privacy.default_sensitivity_class),
    network: privacy.network_allowed === true,
    allow_external_network: privacy.network_allowed === true,
  };
  manifest.events = { publishes: blueprintEventNames(events.publishes), subscribes: blueprintEventNames(events.subscribes) };
  if (strings(resolved.blueprint.inputs).includes("pdf")) manifest.pdf_policy = { accepted_statuses: ["completed"], partial_policy: "review" };
  writeYaml(moduleRoot, manifestPath, manifest);
  if (isSemanticBlueprint(resolved.blueprint)) await materializeSemanticEntities(moduleRoot, resolved.blueprint, manifest);
  await materializeDeclaredWorkflows(moduleRoot, resolved.blueprint, manifest);
  await materializeBlueprintTestContract(moduleRoot, resolved.blueprint);
  writeYaml(moduleRoot, manifestPath, manifest);
  writeYaml(moduleRoot, path.join(moduleRoot, "module.blueprint.yaml"), resolved.blueprint);
  await fs.writeFile(path.join(moduleRoot, "docs", "blueprint-boundary.md"), renderBoundaryDocument(resolved.blueprint), "utf8");
  await fs.writeFile(path.join(moduleRoot, "blueprint-validation-report.json"), `${JSON.stringify(resolved.report, null, 2)}\n`, "utf8");
  return { ...result, module_id: moduleId, blueprint: path.join(moduleRoot, "module.blueprint.yaml"), validation: resolved.report.overall };
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
  writeYaml(moduleRoot, path.join(moduleRoot, "rules", "ownership.yaml"), {
    user_original_content_mutable: object(blueprint.privacy)?.user_original_content_mutable === true,
    generated_entities: entityIdsForOwnership(entities),
    forbidden_operations: object(blueprint.privacy)?.user_original_content_mutable === true ? [] : ["update-user-original", "overwrite-source"],
  });
  const dashboard = parseYaml(moduleRoot, path.join(moduleRoot, "dashboard", "provider.yaml"));
  dashboard.items = strings(object(blueprint.dashboard)?.sections);
  writeYaml(moduleRoot, path.join(moduleRoot, "dashboard", "provider.yaml"), dashboard);
}

function entityIdsForOwnership(entities: JsonObject[]): string[] { return entities.map((entity) => String(entity.id)); }

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
  const inputRoles = object(object(blueprint.privacy)?.input_roles) ?? {};
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
  }
  registry.workflows = nextRegistry;
  writeYaml(moduleRoot, registryPath, registry);
  manifest.entry_workflows = { ...(object(manifest.entry_workflows) ?? {}), ...captureEntrypoints };

  const jobs = Array.isArray(blueprint.jobs) ? blueprint.jobs.map((item) => object(item)).filter((item): item is JsonObject => Boolean(item)) : [];
  const scheduledWorkflow = declared.find((workflow) => workflow.trigger === "schedule");
  const jobEntries: JsonObject[] = jobs.map((job) => {
    const id = String(job.id);
    const workflowId = semantic ? String(job.workflow_id) : declared.some((workflow) => workflow.id === id) ? id : String(scheduledWorkflow?.id ?? id);
    const workflow = declared.find((item) => item.id === workflowId) ?? scheduledWorkflow;
    const schedule = String(job.schedule);
    const trigger: JsonObject = schedule === "weekly"
      ? { type: "weekly", weekday: "Sun", at: String(job.at ?? "18:00"), timezone: String(job.timezone ?? "instance") }
      : schedule === "daily" ? { type: "cron", expression: `0 ${String(job.at ?? "08:00").split(":")[0]} * * *`, timezone: String(job.timezone ?? "instance") }
        : { type: schedule };
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
