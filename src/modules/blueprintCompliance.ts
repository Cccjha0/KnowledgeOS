import path from "node:path";
import { parseYaml } from "../core/bridge.js";
import { exists } from "../core/files.js";
import type { JsonObject, JsonValue } from "../core/types.js";
import { validateModuleBlueprint, type BlueprintCheck } from "./blueprint.js";

function object(value: JsonValue | undefined): JsonObject | null { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null; }
function strings(value: JsonValue | undefined): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function sameSet(left: string[], right: string[]): boolean { return left.length === right.length && left.every((item) => right.includes(item)); }

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
  const runtimeEvents = object(manifest.events);
  add("BLUEPRINT_PUBLISHED_EVENTS_MATCH", sameSet(strings(runtimeEvents?.publishes), strings(events.publishes)), "Published Events match Blueprint.", "module.yaml");
  add("BLUEPRINT_SUBSCRIBED_EVENTS_MATCH", sameSet(strings(runtimeEvents?.subscribes), strings(events.subscribes)), "Subscribed Events match Blueprint.", "module.yaml");
  const workflowRegistry = parseYaml(moduleRoot, path.join(moduleRoot, "workflows", "index.yaml"));
  const runtimeWorkflows = object(workflowRegistry.workflows) ?? {};
  const declaredWorkflows = Array.isArray(blueprint.workflows) ? blueprint.workflows.map((item) => object(item)).filter((item): item is JsonObject => Boolean(item)).map((item) => String(item.id)) : [];
  add("BLUEPRINT_WORKFLOWS_PRESENT", declaredWorkflows.every((id) => Boolean(runtimeWorkflows[id])), "Every Blueprint Workflow is registered.", "workflows/index.yaml");
  const jobRegistry = parseYaml(moduleRoot, path.join(moduleRoot, "jobs", "jobs.yaml"));
  const runtimeJobs = Array.isArray(jobRegistry.jobs) ? jobRegistry.jobs.map((item) => object(item)).filter((item): item is JsonObject => Boolean(item)).map((item) => String(item.id)) : [];
  const declaredJobs = Array.isArray(blueprint.jobs) ? blueprint.jobs.map((item) => object(item)).filter((item): item is JsonObject => Boolean(item)).map((item) => String(item.id)) : [];
  add("BLUEPRINT_JOBS_PRESENT", declaredJobs.every((id) => runtimeJobs.includes(id)), "Every Blueprint Job is registered.", "jobs/jobs.yaml");
  const failed = checks.filter((item) => item.status === "fail").length;
  return { report_version: 1, module_id: String(moduleInfo.id), blueprint_validation: blueprintReport.overall, overall: failed ? "FAIL" : "PASS", checks };
}
