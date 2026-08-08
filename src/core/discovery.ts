import { promises as fs } from "node:fs";
import path from "node:path";
import { parseYaml, validateSchema } from "./bridge.js";
import { exists, readJson } from "./files.js";
import type { JsonObject } from "./types.js";

const MODULE_SCHEMA = "https://pkb.local/schemas/core/module-manifest.schema.json";
const INSTANCE_SCHEMA = "https://pkb.local/schemas/core/instance.schema.json";

export interface DiscoveredDocument {
  path: string;
  data: JsonObject;
}

export interface RoutingDiscoveryContext {
  modules: DiscoveredDocument[];
  instances: DiscoveredDocument[];
}

async function childDirectories(root: string): Promise<string[]> {
  if (!(await exists(root))) return [];
  return (await fs.readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .sort();
}

export async function discoverModules(engineRoot: string): Promise<DiscoveredDocument[]> {
  const result: DiscoveredDocument[] = [];
  for (const directory of await childDirectories(path.join(engineRoot, "modules"))) {
    const manifest = path.join(directory, "module.yaml");
    if (!(await exists(manifest))) continue;
    const data = parseYaml(engineRoot, manifest);
    validateSchema(engineRoot, MODULE_SCHEMA, data);
    result.push({ path: manifest, data });
  }
  return result;
}

export async function discoverModulesForVault(engineRoot: string, vaultRoot: string): Promise<DiscoveredDocument[]> {
  const official = await discoverModules(engineRoot);
  const installed = await readJson<{ modules?: Array<{ id?: string; status?: string; installed_path?: string }> }>(
    path.join(vaultRoot, "90-System", "Modules", "installed.json"), { modules: [] },
  );
  const result = new Map<string, DiscoveredDocument>();
  const officialById = new Map(official.map((module) => [String(module.data.id), module]));
  for (const entry of installed.modules ?? []) {
    if (typeof entry.id !== "string" || !["enabled", "disabled"].includes(entry.status ?? "")) continue;
    const officialModule = officialById.get(entry.id);
    // A lifecycle decision is stored before the next configuration sync has
    // materialized the official module package in the Vault. Preserve that
    // decision by applying it to the Engine's official manifest meanwhile.
    // Otherwise a just-disabled module appears enabled until the next sync.
    if (typeof entry.installed_path !== "string") {
      if (officialModule) result.set(entry.id, { path: officialModule.path, data: { ...officialModule.data, status: String(entry.status) } });
      continue;
    }
    const relative = entry.installed_path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!relative || relative.split("/").includes("..")) {
      if (officialModule) result.set(entry.id, { path: officialModule.path, data: { ...officialModule.data, status: String(entry.status) } });
      continue;
    }
    const manifest = path.join(vaultRoot, ...relative.split("/"), "module.yaml");
    if (!(await exists(manifest))) {
      if (officialModule) result.set(entry.id, { path: officialModule.path, data: { ...officialModule.data, status: String(entry.status) } });
      continue;
    }
    const data = parseYaml(vaultRoot, manifest);
    validateSchema(engineRoot, MODULE_SCHEMA, data);
    result.set(entry.id, { path: manifest, data: { ...data, status: String(entry.status) } });
  }
  for (const module of official) {
    const id = String(module.data.id);
    if (result.has(id)) continue;
    result.set(id, { path: module.path, data: { ...module.data, status: module.data.status === "disabled" ? "disabled" : "enabled" } });
  }
  return [...result.values()].sort((left, right) => String(left.data.id).localeCompare(String(right.data.id)));
}

export async function discoverInstances(vaultRoot: string): Promise<DiscoveredDocument[]> {
  const result: DiscoveredDocument[] = [];
  const root = path.join(vaultRoot, "90-System", "Instances");
  for (const directory of await childDirectories(root)) {
    const instance = path.join(directory, "instance.yaml");
    if (!(await exists(instance))) continue;
    const data = parseYaml(vaultRoot, instance);
    validateSchema(vaultRoot, INSTANCE_SCHEMA, data);
    result.push({ path: instance, data });
  }
  return result;
}

export async function discoverRoutingContext(engineRoot: string, vaultRoot: string): Promise<RoutingDiscoveryContext> {
  const modules = await discoverModulesForVault(engineRoot, vaultRoot);
  const instances = await discoverInstances(vaultRoot);
  return { modules, instances };
}
