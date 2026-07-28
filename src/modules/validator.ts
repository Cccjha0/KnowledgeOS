import { promises as fs } from "node:fs";
import path from "node:path";
import { parseYaml, validateSchema } from "../core/bridge.js";
import { exists, listFilesRecursive, writeJsonAtomic } from "../core/files.js";
import type { JsonObject, JsonValue } from "../core/types.js";
import type { ModuleMaturity, ModuleValidationCheck, ModuleValidationReport } from "./types.js";

const MANIFEST_SCHEMA = "https://pkb.local/schemas/core/module-manifest.schema.json";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SAFE_WORKFLOW_USES = /^(core|codex|component)\.[a-z][a-z0-9-]*$/;

function object(value: JsonValue | undefined): JsonObject | null { return value && typeof value === "object" && !Array.isArray(value) ? value : null; }

function check(category: ModuleValidationCheck["category"], code: string, status: ModuleValidationCheck["status"], message: string, file: string | null = null, critical = false): ModuleValidationCheck {
  return { category, code, status, message, critical, path: file };
}

function compatible(version: string, minimum: string, maximum: string): boolean {
  const parse = (value: string) => value.split(".").slice(0, 3).map((part) => Number(part.replace(/\D.*$/, "")) || 0);
  const compare = (left: number[], right: number[]) => left[0]! - right[0]! || left[1]! - right[1]! || left[2]! - right[2]!;
  const current = parse(version);
  if (compare(current, parse(minimum)) < 0) return false;
  if (/^\d+\.x$/.test(maximum)) return current[0] === Number(maximum.split(".")[0]);
  return !SEMVER.test(maximum) || compare(current, parse(maximum)) <= 0;
}

function rangeSatisfied(version: string, range: string): boolean {
  const [major, minor, patchValue] = version.split(".").map(Number);
  const target = range.replace(/^[\^~]/, "").split(".").map(Number);
  if (range.startsWith("^")) return major === target[0] && (minor! > target[1]! || (minor === target[1] && patchValue! >= target[2]!));
  if (range.startsWith("~")) return major === target[0] && minor === target[1] && patchValue! >= target[2]!;
  return version === range;
}

async function validateRegistry(moduleRoot: string, manifest: JsonObject, section: "schemas" | "prompts" | "workflows", checks: ModuleValidationCheck[]): Promise<void> {
  const descriptor = object(manifest[section]);
  const registryRelative = typeof descriptor?.registry === "string" ? descriptor.registry : null;
  if (!registryRelative) { checks.push(check("references", `MODULE_${section.toUpperCase()}_REGISTRY_MISSING`, "fail", `${section} registry is required.`, "module.yaml", true)); return; }
  const registryFile = path.join(moduleRoot, ...registryRelative.split("/"));
  if (!(await exists(registryFile))) { checks.push(check("references", "MODULE_REGISTRY_NOT_FOUND", "fail", `${registryRelative} does not exist.`, registryRelative, true)); return; }
  const registry = parseYaml(moduleRoot, registryFile);
  const entries = object(registry[section]);
  if (!entries || !Object.keys(entries).length) { checks.push(check("references", "MODULE_REGISTRY_EMPTY", "fail", `${section} registry is empty.`, registryRelative)); return; }
  for (const [id, raw] of Object.entries(entries)) {
    const entry = object(raw);
    const versionValue = section === "schemas" ? entry?.version : entry?.active_version;
    const version = typeof versionValue === "number" ? String(versionValue) : String(versionValue ?? "");
    if (section !== "schemas" && !SEMVER.test(version)) checks.push(check(section === "prompts" ? "prompt-regression" : "contracts", "MODULE_VERSION_INVALID", "fail", `${section}.${id} must use semantic versioning.`, registryRelative));
    const relative = typeof entry?.path === "string" ? entry.path : null;
    if (!relative) { checks.push(check("references", "MODULE_REGISTRY_PATH_MISSING", "fail", `${section}.${id} has no active path.`, registryRelative)); continue; }
    const target = path.join(path.dirname(registryFile), ...relative.split("/"));
    if (!(await exists(target))) { checks.push(check("references", "MODULE_REFERENCE_NOT_FOUND", "fail", `${section}.${id} points to missing ${relative}.`, registryRelative, true)); continue; }
    if (section === "schemas") {
      try {
        const schema = JSON.parse(await fs.readFile(target, "utf8")) as JsonObject;
        if (typeof schema.$id !== "string") throw new Error("$id is required");
        checks.push(check("schema", "MODULE_SCHEMA_VALID", "pass", `${id} schema is parseable and has a stable $id.`, path.relative(moduleRoot, target).replaceAll(path.sep, "/")));
      } catch (error) { checks.push(check("schema", "MODULE_SCHEMA_INVALID", "fail", `${id}: ${error instanceof Error ? error.message : String(error)}`, relative, true)); }
    }
    if (section === "prompts") {
      const text = await fs.readFile(target, "utf8");
      const hasMetadata = text.startsWith("---") && text.includes(`prompt_id: ${id}`) && text.includes(`prompt_version: ${version}`) && /output_schema:/.test(text);
      checks.push(check("prompt-regression", hasMetadata ? "PROMPT_METADATA_VALID" : "PROMPT_METADATA_LEGACY", hasMetadata ? "pass" : "warning", hasMetadata ? `${id}@${version} has versioned metadata.` : `${id} should move to an immutable versioned file with frontmatter.`, path.relative(moduleRoot, target).replaceAll(path.sep, "/")));
    }
    if (section === "workflows") {
      const workflow = parseYaml(moduleRoot, target);
      const workflowId = workflow.workflow_id ?? workflow.id;
      const workflowVersion = workflow.workflow_version ?? workflow.version;
      if (workflowId !== id || String(workflowVersion) !== version) checks.push(check("contracts", "WORKFLOW_METADATA_LEGACY", "warning", `${id} registry and file metadata should use workflow_id/workflow_version ${version}.`, relative));
      for (const step of (workflow.steps as JsonObject[] | undefined) ?? []) if (typeof step.uses !== "string" || !SAFE_WORKFLOW_USES.test(step.uses)) checks.push(check("permissions", "WORKFLOW_UNSAFE_STEP", "fail", `${id} uses undeclared executor ${String(step.uses)}.`, relative, true));
    }
  }
  checks.push(check("references", `MODULE_${section.toUpperCase()}_REGISTRY_VALID`, "pass", `${section} registry references resolve.`, registryRelative));
}

export async function validateModule(engineRoot: string, moduleRoot: string, options: { writeReport?: boolean; reportPath?: string } = {}): Promise<ModuleValidationReport> {
  const checks: ModuleValidationCheck[] = [];
  const manifestFile = path.join(moduleRoot, "module.yaml");
  let manifest: JsonObject = {};
  try { manifest = parseYaml(moduleRoot, manifestFile); validateSchema(moduleRoot, MANIFEST_SCHEMA, manifest); checks.push(check("manifest", "MANIFEST_V1_VALID", "pass", "Manifest v1 schema passed.", "module.yaml")); }
  catch (error) { checks.push(check("manifest", "MANIFEST_V1_INVALID", "fail", error instanceof Error ? error.message : String(error), "module.yaml", true)); }
  const id = typeof manifest.id === "string" ? manifest.id : path.basename(moduleRoot);
  const version = typeof manifest.version === "string" ? manifest.version : "0.0.0";
  const maturity = (["experimental", "beta", "stable", "deprecated"].includes(String(manifest.maturity)) ? manifest.maturity : "experimental") as ModuleMaturity;
  try {
    const engine = JSON.parse(await fs.readFile(path.join(engineRoot, "package.json"), "utf8")) as { version: string };
    const compatibility = object(manifest.engine);
    const apiOk = compatibility?.api_version === 1;
    const versionOk = compatible(engine.version, String(compatibility?.min_version ?? "0.0.0"), String(compatibility?.max_version ?? "999.0.0"));
    checks.push(check("compatibility", "ENGINE_COMPATIBILITY", apiOk && versionOk ? "pass" : "fail", apiOk && versionOk ? `Compatible with Core ${engine.version} API v1.` : `Incompatible with Core ${engine.version}.`, "module.yaml", !apiOk));
  } catch (error) { checks.push(check("compatibility", "ENGINE_COMPATIBILITY_FAILED", "fail", String(error), "module.yaml", true)); }
  await validateRegistry(moduleRoot, manifest, "schemas", checks);
  await validateRegistry(moduleRoot, manifest, "prompts", checks);
  await validateRegistry(moduleRoot, manifest, "workflows", checks);

  const permissions = object(manifest.permissions);
  if (permissions?.cross_module_write === true) checks.push(check("permissions", "CROSS_MODULE_WRITE_REQUESTED", "fail", "Business modules cannot request cross-module writes.", "module.yaml", true));
  if (manifest.module_type !== "integration" && permissions?.network === true) checks.push(check("permissions", "NETWORK_PERMISSION_INVALID", "fail", "Only integration modules may request network access.", "module.yaml", true));
  const prohibited = (await listFilesRecursive(moduleRoot)).filter((file) => [".js", ".cjs", ".mjs", ".ts", ".py", ".ps1", ".exe", ".dll"].includes(path.extname(file).toLowerCase()));
  checks.push(check("permissions", prohibited.length ? "CUSTOM_EXECUTABLE_FOUND" : "NO_CUSTOM_EXECUTABLES", prohibited.length ? "fail" : "pass", prohibited.length ? `Custom executables are not allowed: ${prohibited.map((file) => path.relative(moduleRoot, file)).join(", ")}` : "No module-owned execution scripts found.", prohibited[0] ? path.relative(moduleRoot, prohibited[0]).replaceAll(path.sep, "/") : null, prohibited.length > 0));

  const capabilities = new Set(Array.isArray(manifest.capabilities) ? manifest.capabilities.filter((item): item is string => typeof item === "string") : []);
  const jobs = object(manifest.jobs);
  if (capabilities.has("periodic-summary") && (!jobs || typeof jobs.registry !== "string" || !(await exists(path.join(moduleRoot, ...String(jobs.registry).split("/")))))) checks.push(check("contracts", "PERIODIC_SUMMARY_INCOMPLETE", "fail", "periodic-summary requires a Job registry.", "module.yaml"));
  else checks.push(check("contracts", "CAPABILITY_CONSISTENCY", "pass", "Declared capabilities have required registries.", "module.yaml"));
  if (jobs && typeof jobs.registry === "string" && await exists(path.join(moduleRoot, ...jobs.registry.split("/")))) {
    const jobsFile = path.join(moduleRoot, ...jobs.registry.split("/")); const jobRegistry = parseYaml(moduleRoot, jobsFile);
    const workflows = object(loadRegistrySafe(moduleRoot, manifest, "workflows")?.workflows);
    for (const job of (jobRegistry.jobs as JsonObject[] | undefined) ?? []) {
      const workflowId = String(job.workflow_id ?? ""); const workflowVersion = String(job.workflow_version ?? ""); const registered = object(workflows?.[workflowId]);
      if (!registered || registered.active_version !== workflowVersion) checks.push(check("contracts", "JOB_WORKFLOW_UNREGISTERED", "fail", `Job ${String(job.id)} references unregistered ${workflowId}@${workflowVersion}.`, String(jobs.registry), true));
    }
  }
  const dependencies = object(manifest.dependencies); const components = object(dependencies?.components);
  for (const [componentId, range] of Object.entries(components ?? {})) {
    const componentFile = path.join(engineRoot, "components", componentId, "component.yaml");
    if (!(await exists(componentFile))) checks.push(check("compatibility", "COMPONENT_MISSING", "fail", `Required component ${componentId} is not installed.`, "module.yaml", true));
    else {
      const component = parseYaml(engineRoot, componentFile); const ok = typeof range === "string" && rangeSatisfied(String(component.version), range);
      checks.push(check("compatibility", ok ? "COMPONENT_COMPATIBLE" : "COMPONENT_VERSION_MISMATCH", ok ? "pass" : "fail", `${componentId} ${String(component.version)} ${ok ? "satisfies" : "does not satisfy"} ${String(range)}.`, "module.yaml"));
      if (maturity === "stable" && component.maturity === "experimental") checks.push(check("compatibility", "EXPERIMENTAL_COMPONENT_FOR_STABLE_MODULE", "fail", `Stable module cannot depend on experimental ${componentId}.`, "module.yaml"));
    }
  }

  for (const file of ["README.md", "CHANGELOG.md", "docs/use-case.md"]) checks.push(check("documentation", `DOC_${file.replace(/\W/g, "_").toUpperCase()}`, await exists(path.join(moduleRoot, ...file.split("/"))) ? "pass" : "warning", `${file} ${await exists(path.join(moduleRoot, ...file.split("/"))) ? "exists" : "is missing"}.`, file));
  const fixtureFiles = await listFilesRecursive(path.join(moduleRoot, "fixtures"));
  checks.push(check("behavior", "FIXTURES_PRESENT", fixtureFiles.length ? "pass" : "fail", fixtureFiles.length ? `${fixtureFiles.length} fixture file(s) found.` : "At least one isolated fixture is required.", "fixtures"));
  for (const folder of ["contract", "behavior", "permission", "prompt-regression", "lifecycle", "migration"]) checks.push(check(folder === "prompt-regression" ? "prompt-regression" : folder === "migration" ? "migration" : folder === "lifecycle" ? "lifecycle" : folder === "permission" ? "permissions" : folder === "behavior" ? "behavior" : "contracts", `TEST_${folder.toUpperCase().replace("-", "_")}`, (await listFilesRecursive(path.join(moduleRoot, "tests", folder))).length ? "pass" : maturity === "experimental" ? "warning" : "fail", `${folder} test fixture ${((await listFilesRecursive(path.join(moduleRoot, "tests", folder))).length ? "exists" : "is missing")}.`, `tests/${folder}`));

  const failed = checks.filter((item) => item.status === "fail").length;
  const warnings = checks.filter((item) => item.status === "warning").length;
  const critical = checks.filter((item) => item.critical && item.status === "fail").length;
  const report: ModuleValidationReport = {
    report_version: 1, module_id: id, module_version: version, maturity, generated_at: new Date().toISOString(), checks,
    counts: { pass: checks.length - failed - warnings, warning: warnings, fail: failed, critical },
    overall: failed ? "FAIL" : warnings ? "PASS WITH WARNINGS" : "PASS",
    beta_eligible: failed === 0 && critical === 0,
    stable_eligible: failed === 0 && warnings === 0 && maturity === "stable",
  };
  if (options.writeReport) await writeJsonAtomic(options.reportPath ?? path.join(moduleRoot, "validation-report.json"), report);
  return report;
}

function loadRegistrySafe(moduleRoot: string, manifest: JsonObject, section: "workflows"): JsonObject | null {
  try { const descriptor = manifest[section] as JsonObject; return parseYaml(moduleRoot, path.join(moduleRoot, ...String(descriptor.registry).split("/"))); }
  catch { return null; }
}
