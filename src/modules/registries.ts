import { promises as fs } from "node:fs";
import path from "node:path";
import { parseYaml } from "../core/bridge.js";
import { PkbError } from "../core/errors.js";
import type { JsonObject } from "../core/types.js";

function object(value: unknown): JsonObject | null { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null; }

export interface VersionSelection { id: string; version: string; path: string; source: "module-default" | "instance-pinned" | "testing"; }

function registryPath(moduleRoot: string, manifest: JsonObject, section: "prompts" | "workflows" | "schemas"): string {
  const descriptor = object(manifest[section]);
  if (!descriptor || typeof descriptor.registry !== "string") throw new PkbError("MODULE_REGISTRY_MISSING", `${section} registry is not declared.`);
  return path.join(moduleRoot, ...descriptor.registry.split("/"));
}

export function loadRegistry(moduleRoot: string, manifest: JsonObject, section: "prompts" | "workflows" | "schemas"): JsonObject {
  const file = registryPath(moduleRoot, manifest, section);
  return parseYaml(moduleRoot, file);
}

export async function resolveVersionedEntry(options: {
  moduleRoot: string; manifest: JsonObject; section: "prompts" | "workflows";
  id: string; instancePins?: JsonObject; testingVersions?: JsonObject;
}): Promise<VersionSelection> {
  const registry = loadRegistry(options.moduleRoot, options.manifest, options.section);
  const entries = object(registry[options.section]);
  const entry = object(entries?.[options.id]);
  if (!entry) throw new PkbError("MODULE_REGISTRY_ENTRY_NOT_FOUND", `${options.section} entry ${options.id} was not found.`);
  const testing = options.testingVersions?.[options.id];
  const pinned = options.instancePins?.[options.id];
  const version = typeof testing === "string" ? testing : typeof pinned === "string" ? pinned : String(entry.active_version ?? "");
  const source = typeof testing === "string" ? "testing" : typeof pinned === "string" ? "instance-pinned" : "module-default";
  let relative: string | null = null;
  const versions = object(entry.versions);
  if (versions && typeof versions[version] === "string") relative = String(versions[version]);
  if (!relative && version === entry.active_version && typeof entry.path === "string") relative = entry.path;
  if (!relative) throw new PkbError("MODULE_VERSION_NOT_REGISTERED", `${options.section} ${options.id}@${version} has no registered path.`);
  const absolute = path.join(path.dirname(registryPath(options.moduleRoot, options.manifest, options.section)), ...relative.split("/"));
  await fs.access(absolute);
  return { id: options.id, version, path: absolute, source };
}

export function generationTrace(options: { moduleId: string; moduleVersion: string; workflow: VersionSelection; prompt: VersionSelection; adapter: string; model?: string | null; runId: string; generatedAt?: string }): JsonObject {
  return {
    module_id: options.moduleId, module_version: options.moduleVersion,
    workflow_id: options.workflow.id, workflow_version: options.workflow.version,
    prompt_id: options.prompt.id, prompt_version: options.prompt.version,
    adapter: options.adapter, model: options.model ?? null, run_id: options.runId,
    generated_at: options.generatedAt ?? new Date().toISOString(),
  };
}
