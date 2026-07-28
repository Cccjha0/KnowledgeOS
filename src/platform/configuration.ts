import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
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

async function checksumDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of (await listFilesRecursive(root)).sort()) {
    hash.update(path.relative(root, file).replaceAll(path.sep, "/"));
    hash.update(await fs.readFile(file));
  }
  return `sha256:${hash.digest("hex")}`;
}

export async function syncInstalledConfiguration(vaultRoot: string): Promise<ConfigurationSyncResult> {
  const packageJson = JSON.parse(await fs.readFile(path.join(ENGINE_ROOT, "package.json"), "utf8")) as { version: string };
  const moduleRoot = path.join(ENGINE_ROOT, "modules");
  const previous = JSON.parse(await fs.readFile(path.join(vaultRoot, "90-System", "Modules", "installed.json"), "utf8").catch(() => "{\"modules\":[]}")) as { modules?: Array<{ id?: string; status?: string }> };
  const previousStatus = new Map((previous.modules ?? []).filter((item) => typeof item.id === "string").map((item) => [item.id!, item.status]));
  const previousLock = JSON.parse(await fs.readFile(path.join(vaultRoot, "90-System", "Modules", "module-lock.json"), "utf8").catch(() => "{\"modules\":{}}")) as { modules?: Record<string, { installed_at?: string; version?: string }> };
  const moduleLock: Record<string, object> = {};
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
    const oldLock = previousLock.modules?.[id];
    moduleLock[id] = {
      version, checksum: await checksumDirectory(destination), installed_at: oldLock?.installed_at ?? new Date().toISOString(),
      source: "engine-sync", installed_path: toVaultPath(vaultRoot, destination),
      previous_version: oldLock?.version && oldLock.version !== version ? oldLock.version : null,
      validation_report: `${toVaultPath(vaultRoot, destination)}/validation-report.json`,
    };
    const dependencies = manifest.dependencies;
    if (dependencies && typeof dependencies === "object" && !Array.isArray(dependencies)) {
      const declared = (dependencies as Record<string, unknown>).components;
      if (Array.isArray(declared)) {
        for (const item of declared) if (typeof item === "string") components.add(item);
      } else if (declared && typeof declared === "object") {
        for (const item of Object.keys(declared)) components.add(item);
      }
    }
  }
  modules.sort((a, b) => a.id.localeCompare(b.id));
  const result: ConfigurationSyncResult = { engineVersion: packageJson.version, modules, components: [...components].sort() };
  for (const componentId of result.components) {
    const componentSource = path.join(ENGINE_ROOT, "components", componentId);
    const componentManifest = parseYaml(ENGINE_ROOT, path.join(componentSource, "component.yaml"));
    const componentDestination = path.join(vaultRoot, "90-System", "Components", componentId, String(componentManifest.version));
    await ensureDir(componentDestination);
    await fs.cp(componentSource, componentDestination, { recursive: true, force: true });
  }
  await writeJsonAtomic(path.join(vaultRoot, "90-System", "Core", "engine.json"), {
    schema_version: 1,
    engine: "knowledgeos-engine",
    version: packageJson.version,
    repository: "https://github.com/Cccjha0/KnowledgeOS.git",
    synced_at: new Date().toISOString(),
  });
  await writeJsonAtomic(path.join(vaultRoot, "90-System", "Modules", "installed.json"), { schema_version: 1, modules });
  await writeJsonAtomic(path.join(vaultRoot, "90-System", "Modules", "module-lock.json"), { schema_version: 1, modules: moduleLock });
  await writeJsonAtomic(path.join(vaultRoot, "90-System", "Components", "installed.json"), { schema_version: 1, components: result.components });
  return result;
}
