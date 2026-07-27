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
