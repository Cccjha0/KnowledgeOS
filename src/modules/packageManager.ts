import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseYaml } from "../core/bridge.js";
import { createGitSnapshot } from "../core/git.js";
import { ensureDir, exists, readJson, writeJsonAtomic } from "../core/files.js";
import { PkbError } from "../core/errors.js";
import type { JsonObject } from "../core/types.js";
import type { ModuleLockEntry, ModuleValidationReport } from "./types.js";
import { validateModule } from "./validator.js";

interface BridgeResult { ok: boolean; sha256?: string; files?: number; message?: string; }
interface ModuleLock { schema_version: 1; modules: Record<string, ModuleLockEntry>; }
interface PackageMetadata { package_format: number; module_id: string; version: string; content_checksum: string; }

function bridge(engineRoot: string, command: "pack" | "unpack", source: string, destination: string): BridgeResult {
  const result = spawnSync("python", ["-X", "utf8", path.join(engineRoot, "tools", "module_bridge.py"), command, source, destination], { encoding: "utf8", windowsHide: true });
  let parsed: BridgeResult | null = null; try { parsed = JSON.parse(result.stdout || result.stderr) as BridgeResult; } catch { parsed = null; }
  if (result.error || result.status !== 0 || !parsed?.ok) throw new PkbError("MODULE_PACKAGE_FAILED", parsed?.message ?? result.error?.message ?? result.stderr);
  return parsed;
}

async function checksumDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name); const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
      if (entry.isDirectory()) await visit(absolute); else if (entry.name !== "package-metadata.json") { hash.update(relative); hash.update(await fs.readFile(absolute)); }
    }
  };
  await visit(root); return hash.digest("hex");
}

export async function packModule(engineRoot: string, moduleId: string, outputPath?: string): Promise<JsonObject> {
  const source = path.join(engineRoot, "modules", moduleId);
  if (!(await exists(path.join(source, "module.yaml")))) throw new PkbError("MODULE_NOT_FOUND", `Module ${moduleId} was not found.`);
  const report = await validateModule(engineRoot, source);
  if (report.overall === "FAIL") throw new PkbError("MODULE_VALIDATION_FAILED", `${moduleId} cannot be packed because validation failed.`, report);
  const manifest = parseYaml(source, path.join(source, "module.yaml"));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), `knowledgeos-module-${moduleId}-`));
  try {
    const staging = path.join(temporary, moduleId); await fs.cp(source, staging, { recursive: true });
    await writeJsonAtomic(path.join(staging, "validation-report.json"), report);
    const contentChecksum = await checksumDirectory(staging);
    await writeJsonAtomic(path.join(staging, "package-metadata.json"), { package_format: 1, module_id: moduleId, version: manifest.version, content_checksum: `sha256:${contentChecksum}`, created_at: new Date().toISOString() });
    const destination = outputPath ?? path.join(engineRoot, "packages", `${moduleId}-${String(manifest.version)}.pkb-module`);
    const result = bridge(engineRoot, "pack", staging, destination);
    return { module_id: moduleId, version: String(manifest.version), package: destination, checksum: `sha256:${String(result.sha256)}`, files: result.files ?? 0, validation: report.overall };
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

async function loadLock(vaultRoot: string): Promise<ModuleLock> { return readJson(path.join(vaultRoot, "90-System", "Modules", "module-lock.json"), { schema_version: 1, modules: {} }); }

function enabledPermission(value: JsonObject, key: "network" | "delete" | "cross_module_write"): boolean { return value[key] === true; }

async function installedManifest(vaultRoot: string, entry: ModuleLockEntry | null): Promise<JsonObject | null> {
  if (!entry) return null;
  const root = path.join(vaultRoot, ...entry.installed_path.split("/"));
  return await exists(path.join(root, "module.yaml")) ? parseYaml(root, path.join(root, "module.yaml")) : null;
}

export async function installModulePackage(engineRoot: string, vaultRoot: string, packagePath: string, options: { enable?: boolean; upgrade?: boolean; confirmBreaking?: boolean } = {}): Promise<JsonObject> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-module-install-"));
  try {
    const unpacked = bridge(engineRoot, "unpack", packagePath, temporary);
    const manifest = parseYaml(temporary, path.join(temporary, "module.yaml"));
    const moduleId = String(manifest.id); const version = String(manifest.version);
    const metadata = await readJson<PackageMetadata | null>(path.join(temporary, "package-metadata.json"), null);
    if (!metadata || metadata.package_format !== 1 || metadata.module_id !== moduleId || metadata.version !== version) {
      throw new PkbError("MODULE_PACKAGE_METADATA_INVALID", "Package metadata does not match its manifest.");
    }
    const contentChecksum = `sha256:${await checksumDirectory(temporary)}`;
    if (metadata.content_checksum !== contentChecksum) throw new PkbError("MODULE_PACKAGE_CHECKSUM_MISMATCH", "Package content checksum is invalid.");
    const report = await validateModule(engineRoot, temporary);
    if (!report.beta_eligible) throw new PkbError("MODULE_QUALITY_GATE_FAILED", `${moduleId}@${version} is not Beta eligible.`, report);
    const lock = await loadLock(vaultRoot); const previous = lock.modules[moduleId] ?? null;
    if (previous && !options.upgrade && previous.version !== version) throw new PkbError("MODULE_ALREADY_INSTALLED", `${moduleId}@${previous.version} is already installed; use upgrade.`);
    const permissions = manifest.permissions as JsonObject;
    const oldPermissions = ((await installedManifest(vaultRoot, previous))?.permissions as JsonObject | undefined) ?? {};
    const expandedPermissions = (["network", "delete", "cross_module_write"] as const)
      .filter((key) => previous && enabledPermission(permissions, key) && !enabledPermission(oldPermissions, key));
    if (expandedPermissions.length && options.confirmBreaking !== true) {
      throw new PkbError("MODULE_UPGRADE_CONFIRMATION_REQUIRED", "Permission-expanding upgrades require explicit approval.", { module_id: moduleId, version, expanded_permissions: expandedPermissions });
    }
    const snapshot = await createGitSnapshot(vaultRoot, `module-install-${moduleId}-${version}`);
    const destination = path.join(vaultRoot, "90-System", "Modules", moduleId, version);
    if (await exists(destination)) await fs.rm(destination, { recursive: true, force: true });
    await ensureDir(path.dirname(destination)); await fs.cp(temporary, destination, { recursive: true });
    const packages = path.join(vaultRoot, "90-System", "Modules", "Packages", moduleId); await ensureDir(packages);
    await fs.copyFile(packagePath, path.join(packages, `${version}.pkb-module`));
    const reportPath = path.join(destination, "validation-report.json"); await writeJsonAtomic(reportPath, report);
    lock.modules[moduleId] = { version, checksum: `sha256:${unpacked.sha256}`, installed_at: new Date().toISOString(), source: "local-package", installed_path: path.relative(vaultRoot, destination).replaceAll(path.sep, "/"), previous_version: previous?.version ?? null, validation_report: path.relative(vaultRoot, reportPath).replaceAll(path.sep, "/") };
    await writeJsonAtomic(path.join(vaultRoot, "90-System", "Modules", "module-lock.json"), lock);
    const installedFile = path.join(vaultRoot, "90-System", "Modules", "installed.json");
    const installed = await readJson<{ schema_version?: number; modules?: JsonObject[] }>(installedFile, { schema_version: 1, modules: [] });
    const modules = (installed.modules ?? []).filter((entry) => entry.id !== moduleId);
    modules.push({ id: moduleId, version, installed_path: lock.modules[moduleId]!.installed_path, status: options.enable === false ? "disabled" : "enabled", checksum: lock.modules[moduleId]!.checksum });
    await writeJsonAtomic(installedFile, { schema_version: 1, modules: modules.sort((a, b) => String(a.id).localeCompare(String(b.id))) });
    return { status: previous ? "upgraded" : "installed", module_id: moduleId, version, previous_version: previous?.version ?? null, snapshot, checksum: lock.modules[moduleId]!.checksum, content_checksum: metadata.content_checksum, expanded_permissions: expandedPermissions, validation: report.overall };
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

export async function rollbackModulePackage(engineRoot: string, vaultRoot: string, moduleId: string): Promise<JsonObject> {
  const lock = await loadLock(vaultRoot); const current = lock.modules[moduleId];
  if (!current?.previous_version) throw new PkbError("MODULE_ROLLBACK_UNAVAILABLE", `Module ${moduleId} has no previous version.`);
  const previous = current.previous_version; const packagePath = path.join(vaultRoot, "90-System", "Modules", "Packages", moduleId, `${previous}.pkb-module`);
  if (!(await exists(packagePath))) throw new PkbError("MODULE_ROLLBACK_PACKAGE_MISSING", `Previous package ${previous} is missing.`);
  const result = await installModulePackage(engineRoot, vaultRoot, packagePath, { enable: true, upgrade: true, confirmBreaking: true });
  return { ...result, status: "rolled-back", rolled_back_from: current.version };
}

export async function moduleHealth(engineRoot: string, vaultRoot: string): Promise<JsonObject[]> {
  const lock = await loadLock(vaultRoot); const output: JsonObject[] = [];
  for (const [id, entry] of Object.entries(lock.modules)) {
    const root = path.join(vaultRoot, ...entry.installed_path.split("/"));
    const report = await readJson<ModuleValidationReport | null>(path.join(root, "validation-report.json"), null);
    const manifest = parseYaml(root, path.join(root, "module.yaml"));
    output.push({ id, version: entry.version, maturity: String(manifest.maturity), schema_version: (manifest.data as JsonObject)?.schema_version ?? null, compatibility: report?.checks.find((item) => item.category === "compatibility")?.status ?? "unknown", health: report?.overall ?? "UNKNOWN", prompt_versions: promptVersions(root, manifest), pending_migrations: 0, unmet_dependencies: [], last_test_at: report?.generated_at ?? null, previous_version: entry.previous_version, checksum: entry.checksum });
  }
  return output.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function promptVersions(root: string, manifest: JsonObject): JsonObject {
  try { const registry = parseYaml(root, path.join(root, ...String((manifest.prompts as JsonObject).registry).split("/"))); const prompts = registry.prompts as JsonObject; return Object.fromEntries(Object.entries(prompts).map(([id, value]) => [id, String((value as JsonObject).active_version)])) as JsonObject; }
  catch { return {}; }
}
