import path from "node:path";
import { parseYaml } from "../core/bridge.js";
import { PkbError } from "../core/errors.js";
import type { DiscoveredDocument } from "../core/discovery.js";
import type { JsonObject, JsonValue } from "../core/types.js";
import type { ResourceRequirement, TaskResources } from "../runtime/domain.js";

const DEFAULT_RESOURCES: TaskResources = {
  filesystem: "required",
  network: "not-required",
  codex: "not-required",
  user: "not-required",
};

type PartialResources = Partial<Record<keyof TaskResources, ResourceRequirement>>;

function object(value: JsonValue | undefined): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function resourcePatch(value: JsonValue | undefined, source: string): PartialResources {
  const resources = object(value);
  if (!resources) return {};
  const result: PartialResources = {};
  for (const key of ["filesystem", "network", "codex", "user"] as const) {
    const requirement = resources[key];
    if (requirement === undefined) continue;
    if (requirement !== "required" && requirement !== "not-required") {
      throw new PkbError("WORKFLOW_RESOURCE_INVALID", `${source}.${key} must be required or not-required.`);
    }
    result[key] = requirement;
  }
  return result;
}

function moduleDefaults(module: JsonObject): PartialResources {
  const direct = resourcePatch(module.resources, "module.resources");
  const runtime = object(module.runtime);
  const defaults = object(module.defaults);
  return { ...resourcePatch(defaults?.resources, "module.defaults.resources"), ...resourcePatch(runtime?.resources, "module.runtime.resources"), ...direct };
}

function inferredStepResources(workflow: JsonObject): PartialResources {
  const inferred: PartialResources = {};
  for (const rawStep of Array.isArray(workflow.steps) ? workflow.steps : []) {
    const step = object(rawStep as JsonValue);
    if (!step) continue;
    const uses = typeof step.uses === "string" ? step.uses : "";
    if (uses === "codex.prompt") inferred.codex = "required";
    if (uses.startsWith("integration.") || uses.startsWith("network.")) inferred.network = "required";
    if (uses === "core.await-user" || uses.startsWith("review.")) inferred.user = "required";
    Object.assign(inferred, resourcePatch(step.resources, `workflow step ${String(step.id ?? uses)}.resources`));
  }
  return inferred;
}

function workflowPath(module: DiscoveredDocument, workflowId: string | null, entrypoint: string | null): string {
  const moduleRoot = path.dirname(module.path);
  if (workflowId) {
    const descriptor = object(module.data.workflows);
    if (!descriptor || typeof descriptor.registry !== "string") throw new PkbError("MODULE_WORKFLOW_REGISTRY_MISSING", `Module ${String(module.data.id)} has no workflow registry.`);
    const registryFile = path.join(moduleRoot, ...descriptor.registry.split("/"));
    const registry = parseYaml(moduleRoot, registryFile);
    const entry = object(object(registry.workflows)?.[workflowId]);
    if (!entry || typeof entry.path !== "string") throw new PkbError("MODULE_WORKFLOW_UNREGISTERED", `Workflow ${workflowId} is not registered for ${String(module.data.id)}.`);
    return path.join(path.dirname(registryFile), ...entry.path.split("/"));
  }
  if (entrypoint) {
    const entryWorkflows = object(module.data.entry_workflows);
    const relative = entryWorkflows?.[entrypoint];
    if (typeof relative !== "string") throw new PkbError("MODULE_WORKFLOW_ENTRYPOINT_MISSING", `Entrypoint ${entrypoint} is not declared for ${String(module.data.id)}.`);
    return path.join(moduleRoot, ...relative.split("/"));
  }
  throw new PkbError("MODULE_WORKFLOW_REFERENCE_MISSING", "A workflow ID or entrypoint is required to resolve resources.");
}

/**
 * Resolves one module Workflow's resource requirements. Workflow declarations
 * override inferred step requirements, which override optional module defaults.
 * Jobs and Inbox tasks must both use this function instead of carrying their
 * own resource copies.
 */
export function resolveWorkflowResourceRequirements(module: DiscoveredDocument, workflowId: string | null = null, entrypoint: string | null = null): TaskResources {
  return resolveWorkflowResourceContract(module, workflowId, entrypoint).resources;
}

export interface WorkflowResourceContract {
  workflow_id: string;
  workflow_version: string;
  resources: TaskResources;
}

export function resolveWorkflowResourceContract(module: DiscoveredDocument, workflowId: string | null = null, entrypoint: string | null = null): WorkflowResourceContract {
  const file = workflowPath(module, workflowId, entrypoint);
  const workflow = parseYaml(path.dirname(module.path), file);
  const resolvedId = typeof workflow.workflow_id === "string" ? workflow.workflow_id : typeof workflow.id === "string" ? workflow.id : workflowId;
  const version = workflow.workflow_version ?? workflow.version;
  if (!resolvedId || (typeof version !== "string" && typeof version !== "number")) {
    throw new PkbError("MODULE_WORKFLOW_METADATA_MISSING", `Workflow ${workflowId ?? entrypoint ?? file} must declare workflow_id and workflow_version.`);
  }
  const defaults = moduleDefaults(module.data);
  const inferred = inferredStepResources(workflow);
  const declared = resourcePatch(workflow.resources, "workflow.resources");
  return {
    workflow_id: resolvedId,
    workflow_version: String(version),
    resources: {
      filesystem: declared.filesystem ?? inferred.filesystem ?? defaults.filesystem ?? DEFAULT_RESOURCES.filesystem,
      network: declared.network ?? inferred.network ?? defaults.network ?? DEFAULT_RESOURCES.network,
      codex: declared.codex ?? inferred.codex ?? defaults.codex ?? DEFAULT_RESOURCES.codex,
      user: declared.user ?? inferred.user ?? defaults.user ?? DEFAULT_RESOURCES.user,
    },
  };
}
