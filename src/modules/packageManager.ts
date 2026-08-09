import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { discoverModules } from "../core/discovery.js";
import { engineProvenance, fileChecksum, fixtureChecksum, moduleContentChecksum } from "./readinessEvidence.js";
import { diffPermissionRisk, type PermissionRiskChange } from "./permissionRiskDiff.js";

interface BridgeResult { ok: boolean; sha256?: string; files?: number; message?: string; }
interface ModuleLock { schema_version: 1; modules: Record<string, ModuleLockEntry>; }
interface PackageMetadata extends JsonObject {
  package_format: 2;
  module_id: string;
  version: string;
  content_checksum: string;
  readiness: {
    module_checksum: string;
    validation_report_checksum: string | null;
    module_test_report_checksum: string | null;
    sandbox_report_checksum: string | null;
    fixture_checksum: string | null;
    engine_version: string | null;
    engine_commit: string | null;
    developer_unsafe: boolean;
  };
}

function bridge(engineRoot: string, command: "pack" | "unpack", source: string, destination: string): BridgeResult {
  const result = spawnSync("python", ["-X", "utf8", path.join(engineRoot, "tools", "module_bridge.py"), command, source, destination], { encoding: "utf8", windowsHide: true });
  let parsed: BridgeResult | null = null; try { parsed = JSON.parse(result.stdout || result.stderr) as BridgeResult; } catch { parsed = null; }
  if (result.error || result.status !== 0 || !parsed?.ok) throw new PkbError("MODULE_PACKAGE_FAILED", parsed?.message ?? result.error?.message ?? result.stderr);
  return parsed;
}

async function checksumDirectory(root: string): Promise<string> { return moduleContentChecksum(root); }

interface ReadinessEvidence extends JsonObject {
  module_checksum: string;
  validation_report_checksum: string;
  module_test_report_checksum: string;
  sandbox_report_checksum: string;
  fixture_checksum: string;
  engine_version: string;
  engine_commit: string | null;
}

function evidenceFailure(message: string, details: JsonObject): never {
  throw new PkbError("MODULE_READINESS_STALE", message, details);
}

async function requireReadinessEvidence(engineRoot: string, source: string, moduleId: string, version: string): Promise<ReadinessEvidence> {
  const validationPath = path.join(source, "validation-report.json");
  const testPath = path.join(source, "module-test-report.json");
  const sandboxPath = path.join(source, "sandbox-report.json");
  if (!(await exists(validationPath)) || !(await exists(testPath)) || !(await exists(sandboxPath))) {
    evidenceFailure("Module requires current validation, Module Test, and Sandbox reports before packaging.", { module_id: moduleId, version, required_reports: ["validation-report.json", "module-test-report.json", "sandbox-report.json"] });
  }
  const validation = await readJson<ModuleValidationReport | null>(validationPath, null);
  const test = await readJson<{ module_id?: string; module_version?: string; overall?: string; beta_eligible?: boolean; environment?: JsonObject } | null>(testPath, null);
  const sandbox = await readJson<{ module_id?: string; overall?: string; environment?: JsonObject } | null>(sandboxPath, null);
  const currentModuleChecksum = await moduleContentChecksum(source);
  const currentFixtureChecksum = await fixtureChecksum(source);
  const provenance = await engineProvenance(engineRoot);
  const testEnvironment = test?.environment ?? {};
  const sandboxEnvironment = sandbox?.environment ?? {};
  if (!validation || validation.module_id !== moduleId || validation.module_version !== version || validation.beta_eligible !== true) {
    evidenceFailure("Validation evidence is missing, belongs to another module version, or is not Beta eligible.", { module_id: moduleId, version, validation });
  }
  if (!test || test.module_id !== moduleId || test.module_version !== version || test.overall !== "PASS") {
    evidenceFailure("Module Test evidence must be a passing report for this module version.", { module_id: moduleId, version, test });
  }
  if (!sandbox || sandbox.module_id !== moduleId || sandbox.overall !== "PASS") {
    evidenceFailure("Sandbox evidence must be a passing report for this module.", { module_id: moduleId, version, sandbox });
  }
  const expected = { module_checksum: currentModuleChecksum, fixture_checksum: currentFixtureChecksum, engine_version: provenance.engine_version, git_commit: provenance.engine_commit };
  for (const [label, environment] of [["module-test", testEnvironment], ["sandbox", sandboxEnvironment]] as const) {
    if (environment.module_checksum !== expected.module_checksum || environment.fixture_checksum !== expected.fixture_checksum || environment.engine_version !== expected.engine_version || environment.git_commit !== expected.git_commit) {
      evidenceFailure(`${label} evidence no longer matches current module, fixtures, or Engine provenance.`, { module_id: moduleId, version, expected, actual: environment, report: label });
    }
  }
  return {
    module_checksum: currentModuleChecksum,
    validation_report_checksum: await fileChecksum(validationPath),
    module_test_report_checksum: await fileChecksum(testPath),
    sandbox_report_checksum: await fileChecksum(sandboxPath),
    fixture_checksum: currentFixtureChecksum,
    engine_version: provenance.engine_version,
    engine_commit: provenance.engine_commit,
  };
}

export async function packModuleDirectory(engineRoot: string, source: string, outputPath?: string, options: { developerUnsafe?: boolean } = {}): Promise<JsonObject> {
  if (!(await exists(path.join(source, "module.yaml")))) throw new PkbError("MODULE_NOT_FOUND", `Module source was not found: ${source}.`);
  const report = await validateModule(engineRoot, source);
  if (report.overall === "FAIL") throw new PkbError("MODULE_VALIDATION_FAILED", "Module cannot be packed because validation failed.", report);
  const manifest = parseYaml(source, path.join(source, "module.yaml"));
  const moduleId = String(manifest.id); const version = String(manifest.version);
  const evidence = options.developerUnsafe ? null : await requireReadinessEvidence(engineRoot, source, moduleId, version);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), `knowledgeos-module-${moduleId}-`));
  try {
    const staging = path.join(temporary, moduleId); await fs.cp(source, staging, { recursive: true });
    const contentChecksum = await checksumDirectory(staging);
    const readiness = evidence ?? { module_checksum: contentChecksum, validation_report_checksum: null, module_test_report_checksum: null, sandbox_report_checksum: null, fixture_checksum: null, engine_version: null, engine_commit: null, developer_unsafe: true };
    await writeJsonAtomic(path.join(staging, "package-metadata.json"), { package_format: 2, module_id: moduleId, version, content_checksum: contentChecksum, readiness: { ...readiness, developer_unsafe: options.developerUnsafe === true }, created_at: new Date().toISOString() });
    const destination = outputPath ?? path.join(engineRoot, "packages", `${moduleId}-${version}.pkb-module`);
    const result = bridge(engineRoot, "pack", staging, destination);
    return { module_id: moduleId, version, package: destination, checksum: `sha256:${String(result.sha256)}`, files: result.files ?? 0, validation: report.overall, readiness: { ...readiness, developer_unsafe: options.developerUnsafe === true } };
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

export async function packModule(engineRoot: string, moduleId: string, outputPath?: string): Promise<JsonObject> {
  return packModuleDirectory(engineRoot, path.join(engineRoot, "modules", moduleId), outputPath);
}

async function loadLock(vaultRoot: string): Promise<ModuleLock> { return readJson(path.join(vaultRoot, "90-System", "Modules", "module-lock.json"), { schema_version: 1, modules: {} }); }

async function installedManifest(vaultRoot: string, entry: ModuleLockEntry | null): Promise<JsonObject | null> {
  if (!entry) return null;
  const root = path.join(vaultRoot, ...entry.installed_path.split("/"));
  return await exists(path.join(root, "module.yaml")) ? parseYaml(root, path.join(root, "module.yaml")) : null;
}

async function moduleReviewPolicy(root: string | null): Promise<JsonObject> {
  if (!root) return {};
  const reviewPath = path.join(root, "rules", "review-policy.yaml");
  return await exists(reviewPath) ? parseYaml(root, reviewPath) : {};
}

async function installedReviewPolicy(vaultRoot: string, entry: ModuleLockEntry | null): Promise<JsonObject> {
  if (!entry) return {};
  return moduleReviewPolicy(path.join(vaultRoot, ...entry.installed_path.split("/")));
}

export async function installModulePackage(engineRoot: string, vaultRoot: string, packagePath: string, options: { enable?: boolean; upgrade?: boolean; confirmBreaking?: boolean; developerUnsafe?: boolean } = {}): Promise<JsonObject> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-module-install-"));
  try {
    const unpacked = bridge(engineRoot, "unpack", packagePath, temporary);
    const manifest = parseYaml(temporary, path.join(temporary, "module.yaml"));
    const moduleId = String(manifest.id); const version = String(manifest.version);
    if ((await discoverModules(engineRoot)).some((module) => module.data.id === moduleId)) {
      throw new PkbError("MODULE_ID_RESERVED", `${moduleId} is an official Engine Module ID and cannot be installed as a user module.`);
    }
    const metadata = await readJson<PackageMetadata | null>(path.join(temporary, "package-metadata.json"), null);
    if (!metadata || metadata.package_format !== 2 || metadata.module_id !== moduleId || metadata.version !== version) {
      throw new PkbError("MODULE_PACKAGE_METADATA_INVALID", "Package metadata does not match its manifest.");
    }
    const contentChecksum = await checksumDirectory(temporary);
    if (metadata.content_checksum !== contentChecksum) throw new PkbError("MODULE_PACKAGE_CHECKSUM_MISMATCH", "Package content checksum is invalid.");
    if (metadata.readiness.developer_unsafe && options.developerUnsafe !== true) {
      throw new PkbError("MODULE_READINESS_UNSAFE_PACKAGE", "This package was created with --developer-unsafe and cannot be installed through the normal path.", { module_id: moduleId, version });
    }
    if (!metadata.readiness.developer_unsafe) {
      const reportChecksums = await Promise.all([
        fileChecksum(path.join(temporary, "validation-report.json")), fileChecksum(path.join(temporary, "module-test-report.json")), fileChecksum(path.join(temporary, "sandbox-report.json")),
      ]).catch(() => null);
      const test = await readJson<{ overall?: string; environment?: JsonObject } | null>(path.join(temporary, "module-test-report.json"), null);
      const sandbox = await readJson<{ overall?: string; environment?: JsonObject } | null>(path.join(temporary, "sandbox-report.json"), null);
      const packagedFixtureChecksum = await fixtureChecksum(temporary);
      if (!reportChecksums || metadata.readiness.module_checksum !== contentChecksum || metadata.readiness.validation_report_checksum !== reportChecksums[0] || metadata.readiness.module_test_report_checksum !== reportChecksums[1] || metadata.readiness.sandbox_report_checksum !== reportChecksums[2] || metadata.readiness.fixture_checksum !== packagedFixtureChecksum || test?.overall !== "PASS" || sandbox?.overall !== "PASS" || test.environment?.module_checksum !== contentChecksum || sandbox?.environment?.module_checksum !== contentChecksum || test.environment?.fixture_checksum !== packagedFixtureChecksum || sandbox?.environment?.fixture_checksum !== packagedFixtureChecksum) {
        throw new PkbError("MODULE_READINESS_STALE", "Package readiness evidence is missing or does not match packaged content.", { module_id: moduleId, version, readiness: metadata.readiness });
      }
    }
    const report = await validateModule(engineRoot, temporary);
    if (!report.beta_eligible) throw new PkbError("MODULE_QUALITY_GATE_FAILED", `${moduleId}@${version} is not Beta eligible.`, report);
    const lock = await loadLock(vaultRoot); const previous = lock.modules[moduleId] ?? null;
    if (previous && !options.upgrade && previous.version !== version) throw new PkbError("MODULE_ALREADY_INSTALLED", `${moduleId}@${previous.version} is already installed; use upgrade.`);
    const oldManifest = (await installedManifest(vaultRoot, previous)) ?? {};
    const riskChanges: PermissionRiskChange[] = previous
      ? diffPermissionRisk(oldManifest, manifest, await installedReviewPolicy(vaultRoot, previous), await moduleReviewPolicy(temporary))
      : [];
    const expandedPermissions = riskChanges.map((risk) => risk.id);
    if (riskChanges.length && options.confirmBreaking !== true) {
      throw new PkbError("MODULE_UPGRADE_CONFIRMATION_REQUIRED", "Permission- or risk-expanding upgrades require explicit approval.", { module_id: moduleId, version, expanded_permissions: expandedPermissions, risk_changes: riskChanges });
    }
    const snapshot = await createGitSnapshot(vaultRoot, `module-install-${moduleId}-${version}`);
    const destination = path.join(vaultRoot, "90-System", "Modules", "Installed", moduleId, version);
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
    return { status: previous ? "upgraded" : "installed", module_id: moduleId, version, previous_version: previous?.version ?? null, snapshot, checksum: lock.modules[moduleId]!.checksum, content_checksum: metadata.content_checksum, expanded_permissions: expandedPermissions, risk_changes: riskChanges, validation: report.overall };
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
