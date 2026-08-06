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
  report_version: 1;
  blueprint_version: 1;
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
  const workflows = Array.isArray(blueprint.workflows) ? blueprint.workflows.map((item) => object(item)).filter((item): item is JsonObject => Boolean(item)) : [];
  if (workflows.some((workflow) => workflow.requires_network === true) && privacy?.network_allowed !== true) checks.push(check("WORKFLOW_NETWORK_UNDECLARED", "fail", "A Workflow requires network but privacy.network_allowed is false.", "workflows"));
  const events = object(blueprint.events);
  if (strings(events?.publishes).length && !resolvedCapabilities.includes("event-publishing")) checks.push(check("EVENT_CAPABILITY_MISSING", "fail", "Published Events require the event-publishing Capability Pack.", "events.publishes"));
  if (strings(events?.subscribes).length && !resolvedCapabilities.includes("event-subscription")) checks.push(check("EVENT_SUBSCRIPTION_CAPABILITY_MISSING", "fail", "Event subscriptions require the event-subscription Capability Pack.", "events.subscribes"));
  const testing = object(blueprint.testing);
  if (workflows.some((workflow) => workflow.trigger === "schedule") && testing?.periodic_job !== "required") checks.push(check("PERIODIC_TEST_REQUIRED", "fail", "Scheduled Workflows require testing.periodic_job: required.", "testing.periodic_job"));
  if (strings(events?.publishes).length && testing?.event_publication !== "required") checks.push(check("EVENT_PUBLICATION_TEST_REQUIRED", "fail", "Published Events require an Event publication test.", "testing.event_publication"));
  if (strings(events?.subscribes).length && testing?.event_consumption !== "required") checks.push(check("EVENT_CONSUMPTION_TEST_REQUIRED", "fail", "Event subscriptions require an Event consumption test.", "testing.event_consumption"));
  if (strings(blueprint.inputs).some((format) => ["pdf", "pptx", "image"].includes(format)) && testing?.attachment_policy !== "required") checks.push(check("ATTACHMENT_POLICY_TEST_REQUIRED", "fail", "Attachment inputs require testing.attachment_policy: required.", "testing.attachment_policy"));

  const failed = checks.filter((item) => item.status === "fail").length;
  const warnings = checks.filter((item) => item.status === "warning").length;
  const moduleInfo = object(blueprint.module);
  const report: BlueprintValidationReport = {
    report_version: 1,
    blueprint_version: 1,
    module_id: String(moduleInfo?.id ?? "unknown"),
    checks,
    resolved_capability_packs: resolved,
    resolved_capabilities: resolvedCapabilities,
    required_components: requiredComponents,
    overall: failed ? "FAIL" : warnings ? "PASS WITH WARNINGS" : "PASS",
  };
  return { blueprint, report, scaffoldTemplate: String(template?.scaffold_template ?? "minimal-config") as ModuleTemplate };
}

export async function scaffoldModuleFromBlueprint(engineRoot: string, blueprintPath: string): Promise<JsonObject> {
  const resolved = await validateModuleBlueprint(engineRoot, blueprintPath);
  if (resolved.report.overall === "FAIL") throw new PkbError("BLUEPRINT_INVALID", "Module Blueprint failed validation.", resolved.report);
  const moduleInfo = object(resolved.blueprint.module)!;
  const moduleId = String(moduleInfo.id);
  const displayName = String(moduleInfo.display_name);
  const result = await createModuleScaffold(engineRoot, moduleId, resolved.scaffoldTemplate, displayName);
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
  manifest.events = { publishes: strings(events.publishes), subscribes: strings(events.subscribes) };
  writeYaml(moduleRoot, manifestPath, manifest);
  await materializeDeclaredWorkflows(moduleRoot, resolved.blueprint, manifest);
  await alignScaffoldEvents(moduleRoot, strings(events.publishes));
  writeYaml(moduleRoot, manifestPath, manifest);
  writeYaml(moduleRoot, path.join(moduleRoot, "module.blueprint.yaml"), resolved.blueprint);
  await fs.writeFile(path.join(moduleRoot, "docs", "blueprint-boundary.md"), renderBoundaryDocument(resolved.blueprint), "utf8");
  await fs.writeFile(path.join(moduleRoot, "blueprint-validation-report.json"), `${JSON.stringify(resolved.report, null, 2)}\n`, "utf8");
  return { ...result, module_id: moduleId, blueprint: path.join(moduleRoot, "module.blueprint.yaml"), validation: resolved.report.overall };
}

async function alignScaffoldEvents(moduleRoot: string, publishedEvents: string[]): Promise<void> {
  const registry = parseYaml(moduleRoot, path.join(moduleRoot, "workflows", "index.yaml"));
  const entries = object(registry.workflows) ?? {};
  const workflowFiles = Object.values(entries)
    .map((entry) => object(entry))
    .filter((entry): entry is JsonObject => entry !== null)
    .filter((entry) => typeof entry.path === "string")
    .map((entry) => path.join(moduleRoot, "workflows", ...String(entry.path).split("/")));
  let eventIndex = 0;
  for (const workflowFile of workflowFiles) {
    if (!(await exists(workflowFile))) continue;
    const workflow = parseYaml(moduleRoot, workflowFile);
    const steps = Array.isArray(workflow.steps) ? workflow.steps.map((item) => object(item)).filter((item): item is JsonObject => Boolean(item)) : [];
    const rewritten: JsonObject[] = [];
    for (const step of steps) {
      if (step.uses !== "core.publish-event") { rewritten.push(step); continue; }
      const eventType = publishedEvents[eventIndex++];
      if (!eventType) continue;
      rewritten.push({ ...step, with: { ...(object(step.with) ?? {}), event_type: eventType } });
    }
    workflow.steps = rewritten;
    const hasPublisher = rewritten.some((step) => step.uses === "core.publish-event");
    workflow.outputs = strings(workflow.outputs).filter((output) => output !== "events" || hasPublisher);
    writeYaml(moduleRoot, workflowFile, workflow);
  }
}

async function materializeDeclaredWorkflows(moduleRoot: string, blueprint: JsonObject, manifest: JsonObject): Promise<void> {
  const declared = Array.isArray(blueprint.workflows) ? blueprint.workflows.map((item) => object(item)).filter((item): item is JsonObject => Boolean(item)) : [];
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
    const source = workflow.trigger === "schedule" ? weeklyTemplate : normalizeTemplate;
    const generated: JsonObject = JSON.parse(JSON.stringify(source)) as JsonObject;
    generated.workflow_id = id;
    generated.resources = {
      ...(object(generated.resources) ?? {}),
      network: workflow.requires_network === true ? "required" : "not-required",
      codex: workflow.requires_ai === true ? "required" : "not-required",
    };
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
    const workflowId = declared.some((workflow) => workflow.id === id) ? id : String(scheduledWorkflow?.id ?? id);
    const schedule = String(job.schedule);
    const trigger: JsonObject = schedule === "weekly"
      ? { type: "weekly", weekday: "Sun", at: "18:00", timezone: "instance" }
      : schedule === "daily" ? { type: "cron", expression: "0 8 * * *", timezone: "instance" }
        : { type: schedule };
    return {
      id, scope: "instance", enabled: true, task_type: "workflow", workflow: `${String(object(blueprint.module)?.id)}:${workflowId}`,
      workflow_id: workflowId, workflow_version: "1.0.0", trigger,
      resources: { filesystem: "required", network: "not-required", codex: scheduledWorkflow?.requires_ai === true ? "required" : "not-required", user: "not-required" },
      catch_up: { policy: String(job.catch_up), max_age_days: 21 }, retry: { max_attempts: 3 },
      concurrency: { policy: "forbid", key: `${String(object(blueprint.module)?.id)}:{instance}:${id}` }, priority: "normal",
    };
  });
  writeYaml(moduleRoot, path.join(moduleRoot, "jobs", "jobs.yaml"), { jobs: jobEntries });
}

function renderBoundaryDocument(blueprint: JsonObject): string {
  const moduleInfo = object(blueprint.module)!;
  const useCases = object(blueprint.use_cases)!;
  const privacy = object(blueprint.privacy)!;
  const bullet = (items: string[]): string => items.map((item) => `- ${item}`).join("\n");
  return `# ${String(moduleInfo.display_name)} Blueprint Boundary\n\n## Primary use cases\n\n${bullet(strings(useCases.primary))}\n\n## Explicitly excluded\n\n${bullet(strings(useCases.excluded))}\n\n## Privacy contract\n\n- Default sensitivity class: ${String(privacy.default_sensitivity_class)}\n- Maximum representation: ${String(privacy.default_max_representation)}\n- Network allowed: ${String(privacy.network_allowed)}\n- User original content mutable: ${String(privacy.user_original_content_mutable)}\n\nThis document is generated from module.blueprint.yaml. Change the Blueprint and regenerate instead of editing this file as the design source.\n`;
}
