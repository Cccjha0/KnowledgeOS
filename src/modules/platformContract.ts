import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { listIngestionAdapters } from "../core/adapterRegistry.js";
import { parseYaml } from "../core/bridge.js";
import { exists } from "../core/files.js";
import type { JsonObject, JsonValue } from "../core/types.js";
import { listWorkflowStepDefinitions } from "./workflowStepRegistry.js";

const BLUEPRINT_SCHEMA_PATH = path.join("core", "schemas", "module-blueprint.schema.json");
const PACK_REGISTRY_PATH = path.join("core", "module-builder", "capability-packs.yaml");

/**
 * The single machine-readable description of what a Module Builder may use.
 * It is assembled from the same registries the Engine validates and executes,
 * not from names copied into a Skill or an Obsidian view.
 */
export const MODULE_BUILDER_PLATFORM_CONTRACT_VERSION = "1.0.0";

export interface ModuleBuilderPlatformContract extends JsonObject {
  contract_version: string;
  contract_fingerprint: string;
  generated_at: string;
  engine: JsonObject;
  blueprint_schema: JsonObject;
  base_templates: JsonObject;
  capability_packs: JsonObject[];
  adapters: JsonObject[];
  components: JsonObject[];
  workflow_steps: JsonObject[];
}

export interface ModuleBuilderRegistry {
  registry: JsonObject;
  packs: JsonObject;
  templates: JsonObject;
}

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
  return JSON.stringify(value);
}

function fingerprint(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** Shared Pack Registry loader for Blueprint validation and Builder guidance. */
export async function loadModuleBuilderRegistry(engineRoot: string): Promise<ModuleBuilderRegistry> {
  const registry = parseYaml(engineRoot, path.join(engineRoot, PACK_REGISTRY_PATH));
  return { registry, packs: object(registry.packs) ?? {}, templates: object(registry.base_templates) ?? {} };
}

async function componentContracts(engineRoot: string): Promise<JsonObject[]> {
  const root = path.join(engineRoot, "components");
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const components: JsonObject[] = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
    const file = path.join(root, entry.name, "component.yaml");
    if (!(await exists(file))) continue;
    const manifest = parseYaml(engineRoot, file);
    components.push({
      id: typeof manifest.id === "string" ? manifest.id : entry.name,
      version: typeof manifest.version === "string" ? manifest.version : "unknown",
      maturity: typeof manifest.maturity === "string" ? manifest.maturity : "unknown",
      capabilities: Array.isArray(manifest.capabilities) ? manifest.capabilities : [],
      owns_business_data: manifest.owns_business_data === true,
    });
  }
  return components;
}

/** Returns the current Contract plus a stable fingerprint for evaluation evidence. */
export async function getModuleBuilderPlatformContract(engineRoot: string): Promise<ModuleBuilderPlatformContract> {
  const [registry, packageText, blueprintText, components] = await Promise.all([
    loadModuleBuilderRegistry(engineRoot),
    fs.readFile(path.join(engineRoot, "package.json"), "utf8"),
    fs.readFile(path.join(engineRoot, BLUEPRINT_SCHEMA_PATH), "utf8"),
    componentContracts(engineRoot),
  ]);
  const packageData = object(JSON.parse(packageText)) ?? {};
  const blueprintSchema = object(JSON.parse(blueprintText)) ?? {};
  const body: JsonObject = {
    contract_version: MODULE_BUILDER_PLATFORM_CONTRACT_VERSION,
    engine: { api_version: 1, version: typeof packageData.version === "string" ? packageData.version : "unknown" },
    blueprint_schema: {
      id: typeof blueprintSchema.$id === "string" ? blueprintSchema.$id : "https://pkb.local/schemas/core/module-blueprint.schema.json",
      supported_blueprint_versions: [1, 1.1],
      checksum: createHash("sha256").update(blueprintText, "utf8").digest("hex"),
    },
    base_templates: registry.templates,
    capability_packs: Object.entries(registry.packs).sort(([left], [right]) => left.localeCompare(right)).map(([id, raw]) => {
      const pack = object(raw) ?? {};
      return { id, capabilities: pack.capabilities ?? [], requires: pack.requires ?? [], conflicts: pack.conflicts ?? [], adapters: pack.adapters ?? [], components: pack.components ?? {}, contract: pack.contract ?? null } as JsonObject;
    }),
    adapters: listIngestionAdapters().map((adapter) => ({
      format: adapter.format, adapter_id: adapter.adapter_id, adapter_version: adapter.adapter_version,
      available: adapter.available, available_on_current_platform: adapter.available && adapter.supported_platforms.includes(process.platform),
      supported_platforms: adapter.supported_platforms, extraction_modes: adapter.extraction_modes,
      locator_type: adapter.locator_type, max_file_size: adapter.max_file_size, extensions: adapter.extensions,
    }) as JsonObject),
    components,
    workflow_steps: listWorkflowStepDefinitions().map((step) => ({
      id: step.id, version: step.version, resources: step.resources, input_schema: step.inputSchema ?? null,
      output_schema: step.outputSchema ?? null, component_id: step.componentId ?? null,
    }) as JsonObject),
  };
  return { ...body, contract_fingerprint: fingerprint(body), generated_at: new Date().toISOString() } as ModuleBuilderPlatformContract;
}

export function moduleBuilderContractReference(contract: ModuleBuilderPlatformContract): JsonObject {
  return {
    contract_version: contract.contract_version,
    contract_fingerprint: contract.contract_fingerprint,
    engine_version: (contract.engine as JsonObject).version ?? null,
    engine_api_version: (contract.engine as JsonObject).api_version ?? null,
    blueprint_schema_checksum: (contract.blueprint_schema as JsonObject).checksum ?? null,
  };
}
