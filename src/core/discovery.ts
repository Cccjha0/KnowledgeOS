import { promises as fs } from "node:fs";
import path from "node:path";
import { parseValidateYamlBatch, parseYaml, validateSchema } from "./bridge.js";
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
  const modules = await discoverModules(engineRoot);
  const installed = await readJson<{ modules?: Array<{ id?: string; status?: string }> }>(
    path.join(vaultRoot, "90-System", "Modules", "installed.json"), { modules: [] },
  );
  const statuses = new Map(
    (installed.modules ?? [])
      .filter((entry) => typeof entry.id === "string" && ["enabled", "disabled"].includes(entry.status ?? ""))
      .map((entry) => [entry.id!, entry.status!]),
  );
  return modules.map((module) => ({
    path: module.path,
    data: { ...module.data, status: statuses.get(String(module.data.id)) ?? (module.data.status === "disabled" ? "disabled" : "enabled") },
  }));
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
  const modulePaths: string[] = [];
  for (const directory of await childDirectories(path.join(engineRoot, "modules"))) {
    const manifest = path.join(directory, "module.yaml");
    if (await exists(manifest)) modulePaths.push(manifest);
  }
  const instancePaths: string[] = [];
  for (const directory of await childDirectories(path.join(vaultRoot, "90-System", "Instances"))) {
    const instance = path.join(directory, "instance.yaml");
    if (await exists(instance)) instancePaths.push(instance);
  }
  const documents = parseValidateYamlBatch(vaultRoot, [
    ...modulePaths.map((manifest) => ({ path: manifest, schema_id: MODULE_SCHEMA })),
    ...instancePaths.map((instance) => ({ path: instance, schema_id: INSTANCE_SCHEMA })),
  ]);
  const installed = await readJson<{ modules?: Array<{ id?: string; status?: string }> }>(
    path.join(vaultRoot, "90-System", "Modules", "installed.json"), { modules: [] },
  );
  const statuses = new Map(
    (installed.modules ?? [])
      .filter((entry) => typeof entry.id === "string" && ["enabled", "disabled"].includes(entry.status ?? ""))
      .map((entry) => [entry.id!, entry.status!]),
  );
  const modules = modulePaths.map((manifest, index) => ({
    path: manifest,
    data: {
      ...documents[index]!,
      status: statuses.get(String(documents[index]!.id)) ?? (documents[index]!.status === "disabled" ? "disabled" : "enabled"),
    },
  }));
  const instances = instancePaths.map((instance, index) => ({
    path: instance,
    data: documents[modulePaths.length + index]!,
  }));
  return { modules, instances };
}
