import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseYaml } from "../core/bridge.js";
import { ensureDir, listFilesRecursive, toVaultPath, writeJsonAtomic } from "../core/files.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface ConfigurationSyncResult {
  engineVersion: string;
  modules: Array<{ id: string; version: string; installed_path: string; status: "enabled" | "disabled" }>;
  components: string[];
}

export async function syncInstalledConfiguration(vaultRoot: string): Promise<ConfigurationSyncResult> {
  const packageJson = JSON.parse(await fs.readFile(path.join(ENGINE_ROOT, "package.json"), "utf8")) as { version: string };
  const moduleRoot = path.join(ENGINE_ROOT, "modules");
  const previous = JSON.parse(await fs.readFile(path.join(vaultRoot, "90-System", "Modules", "installed.json"), "utf8").catch(() => "{\"modules\":[]}")) as { modules?: Array<{ id?: string; status?: string }> };
  const previousStatus = new Map((previous.modules ?? []).filter((item) => typeof item.id === "string").map((item) => [item.id!, item.status]));
  const modules: ConfigurationSyncResult["modules"] = [];
  const components = new Set<string>();
  for (const manifestPath of (await listFilesRecursive(moduleRoot, "module.yaml")).filter((file) => path.basename(path.dirname(file)) !== "")) {
    if (path.basename(manifestPath) !== "module.yaml") continue;
    const manifest = parseYaml(ENGINE_ROOT, manifestPath);
    const id = String(manifest.id);
    const version = String(manifest.version);
    const source = path.dirname(manifestPath);
    const destination = path.join(vaultRoot, "90-System", "Modules", id, version);
    await ensureDir(destination);
    await fs.cp(source, destination, { recursive: true, force: true });
    const prior = previousStatus.get(id);
    const status = prior === "enabled" || prior === "disabled" ? prior : manifest.status === "disabled" ? "disabled" : "enabled";
    modules.push({ id, version, installed_path: toVaultPath(vaultRoot, destination), status });
    const dependencies = manifest.dependencies;
    if (dependencies && typeof dependencies === "object" && !Array.isArray(dependencies)) {
      const declared = (dependencies as Record<string, unknown>).components;
      if (Array.isArray(declared)) for (const item of declared) if (typeof item === "string") components.add(item);
    }
  }
  modules.sort((a, b) => a.id.localeCompare(b.id));
  const result: ConfigurationSyncResult = { engineVersion: packageJson.version, modules, components: [...components].sort() };
  await writeJsonAtomic(path.join(vaultRoot, "90-System", "Core", "engine.json"), {
    schema_version: 1,
    engine: "knowledgeos-engine",
    version: packageJson.version,
    repository: "https://github.com/Cccjha0/KnowledgeOS.git",
    synced_at: new Date().toISOString(),
  });
  await writeJsonAtomic(path.join(vaultRoot, "90-System", "Modules", "installed.json"), { schema_version: 1, modules });
  await writeJsonAtomic(path.join(vaultRoot, "90-System", "Components", "installed.json"), { schema_version: 1, components: result.components });
  return result;
}
