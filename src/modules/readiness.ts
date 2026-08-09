import path from "node:path";
import { parseYaml } from "../core/bridge.js";
import { exists, readJson, toVaultPath, writeJsonAtomic } from "../core/files.js";
import { PkbError } from "../core/errors.js";
import type { JsonObject, JsonValue } from "../core/types.js";
import { installModulePackage, packModuleDirectory } from "./packageManager.js";
import { runModuleSandbox } from "./sandbox.js";
import { testModule } from "./testRunner.js";
import type { ModuleTestReport, ModuleValidationReport } from "./types.js";
import { validateModule } from "./validator.js";
import { validateModuleBlueprint } from "./blueprint.js";
import { implementModuleWorkspace, moduleImplementationReportPath, type ModuleImplementationReport } from "./implementation.js";

export type ModuleReadinessAction = "implement" | "validate" | "test" | "sandbox" | "pack" | "install";
type ReadinessStatus = "complete" | "pending" | "failed";

interface ReadinessStep extends JsonObject {
  id: "blueprint" | "scaffold" | "implementation" | "validation" | "test" | "sandbox" | "package" | "installation";
  status: ReadinessStatus;
  message: string;
  report_path: string | null;
}

function workspaceRoot(vaultRoot: string, moduleId: string): string {
  return path.join(vaultRoot, "90-System", "Module Development", moduleId);
}

function stateFor(steps: ReadinessStep[]): string {
  const step = (id: ReadinessStep["id"]) => steps.find((candidate) => candidate.id === id)!;
  if (step("installation").status === "complete") return "installed";
  if (step("scaffold").status === "failed") return "draft";
  if (step("implementation").status === "failed") return "implementation-failed";
  if (step("validation").status === "failed" || step("test").status === "failed" || step("sandbox").status === "failed") return "test-failed";
  if (step("validation").status === "complete" && step("test").status === "complete" && step("sandbox").status === "complete") return "ready-to-package";
  if (step("blueprint").status === "complete" && step("scaffold").status === "complete" && step("implementation").status === "complete") return "implementation-complete";
  if (step("blueprint").status === "complete" && step("scaffold").status === "complete") return "implementation-required";
  return "draft";
}

function availableActions(steps: ReadinessStep[]): ModuleReadinessAction[] {
  const byId = Object.fromEntries(steps.map((step) => [step.id, step])) as Record<ReadinessStep["id"], ReadinessStep>;
  if (byId.scaffold.status !== "complete") return [];
  if (byId.implementation.status !== "complete") return ["implement"];
  const actions: ModuleReadinessAction[] = ["validate"];
  if (byId.validation.status === "complete") actions.push("test");
  if (byId.test.status === "complete") actions.push("sandbox");
  if (byId.validation.status === "complete" && byId.test.status === "complete" && byId.sandbox.status === "complete") actions.push("pack");
  if (byId.package.status === "complete") actions.push("install");
  return actions;
}

function reportStatus(report: { overall?: string } | null): ReadinessStatus {
  if (!report) return "pending";
  return report.overall === "PASS" ? "complete" : "failed";
}

/** Build the persisted delivery state for a Vault-owned module workspace. */
export async function getModuleReadiness(engineRoot: string, vaultRoot: string, moduleId: string): Promise<JsonObject> {
  const root = workspaceRoot(vaultRoot, moduleId);
  const blueprintPath = path.join(root, "module.blueprint.yaml");
  const manifestPath = path.join(root, "module.yaml");
  const validationPath = path.join(root, "validation-report.json");
  const testPath = path.join(root, "module-test-report.json");
  const sandboxPath = path.join(root, "sandbox-report.json");
  const implementationPath = moduleImplementationReportPath(vaultRoot, moduleId);
  const steps: ReadinessStep[] = [];
  if (!(await exists(root))) {
    return { module_id: moduleId, workspace_path: toVaultPath(vaultRoot, root), state: "draft", steps: [{ id: "blueprint", status: "pending", message: "Create or import a Blueprint to begin.", report_path: null }], available_actions: [] };
  }
  if (await exists(blueprintPath)) {
    try {
      const blueprint = await validateModuleBlueprint(engineRoot, blueprintPath);
      steps.push({ id: "blueprint", status: blueprint.report.overall === "FAIL" ? "failed" : "complete", message: blueprint.report.overall === "FAIL" ? "Blueprint validation failed." : "Blueprint is valid.", report_path: toVaultPath(vaultRoot, blueprintPath) });
    } catch {
      steps.push({ id: "blueprint", status: "failed", message: "Blueprint could not be read or validated.", report_path: toVaultPath(vaultRoot, blueprintPath) });
    }
  } else steps.push({ id: "blueprint", status: "pending", message: "No Blueprint copy exists in this workspace.", report_path: null });
  const manifest = await exists(manifestPath) ? parseYaml(root, manifestPath) : null;
  steps.push(manifest
    ? { id: "scaffold", status: "complete", message: "Scaffold files exist in the development workspace.", report_path: toVaultPath(vaultRoot, manifestPath) }
    : { id: "scaffold", status: "failed", message: "module.yaml is missing; scaffold the Blueprint first.", report_path: null });
  const implementation = await readJson<ModuleImplementationReport | null>(implementationPath, null);
  const implementationStatus = reportStatus(implementation);
  steps.push({ id: "implementation", status: implementationStatus, message: implementationStatus === "pending" ? "Use bounded AI implementation to complete declarative Schema, Prompt, Workflow, Rule, Template, and Fixture files." : implementationStatus === "complete" ? "Bounded AI implementation passed validation and Module Test." : "Implementation did not pass validation or Module Test; run it again to make another bounded attempt.", report_path: implementation ? toVaultPath(vaultRoot, implementationPath) : null });
  const validation = await readJson<ModuleValidationReport | null>(validationPath, null);
  const validationStatus = reportStatus(validation);
  steps.push({ id: "validation", status: validationStatus, message: validationStatus === "pending" ? "Validation has not run." : validationStatus === "complete" ? "Static validation passed." : "Static validation failed.", report_path: validation ? toVaultPath(vaultRoot, validationPath) : null });
  const test = await readJson<ModuleTestReport | null>(testPath, null);
  const testStatus = reportStatus(test);
  steps.push({ id: "test", status: testStatus, message: testStatus === "pending" ? "Module Test has not run." : testStatus === "complete" ? "Fixture contract passed." : "Fixture contract failed.", report_path: test ? toVaultPath(vaultRoot, testPath) : null });
  const sandbox = await readJson<{ overall?: string } | null>(sandboxPath, null);
  const sandboxStatus = reportStatus(sandbox);
  steps.push({ id: "sandbox", status: sandboxStatus, message: sandboxStatus === "pending" ? "Sandbox has not run." : sandboxStatus === "complete" ? "Disposable Vault run passed." : "Sandbox failed.", report_path: sandbox ? toVaultPath(vaultRoot, sandboxPath) : null });
  const version = manifest ? String(manifest.version) : null;
  const packagePath = version ? path.join(vaultRoot, "90-System", "Modules", "Packages", moduleId, `${version}.pkb-module`) : null;
  const packaged = packagePath !== null && await exists(packagePath);
  steps.push({ id: "package", status: packaged ? "complete" : "pending", message: packaged ? "A versioned local package is available." : "Package after validation, test, and sandbox pass.", report_path: packaged ? toVaultPath(vaultRoot, packagePath!) : null });
  const lock = await readJson<{ modules?: Record<string, { version?: string; installed_path?: string }> }>(path.join(vaultRoot, "90-System", "Modules", "module-lock.json"), { modules: {} });
  const installed = version !== null && lock.modules?.[moduleId]?.version === version;
  steps.push({ id: "installation", status: installed ? "complete" : "pending", message: installed ? "This package version is installed in the Vault." : "Install the packaged module explicitly to enable it.", report_path: installed && typeof lock.modules?.[moduleId]?.installed_path === "string" ? lock.modules![moduleId]!.installed_path! : null });
  const state = stateFor(steps);
  return { module_id: moduleId, workspace_path: toVaultPath(vaultRoot, root), version, state, maturity: manifest?.maturity ?? null, steps, available_actions: availableActions(steps) };
}

function requireReadyStep(readiness: JsonObject, action: ModuleReadinessAction): void {
  const actions = Array.isArray(readiness.available_actions) ? readiness.available_actions : [];
  if (!actions.includes(action)) throw new PkbError("MODULE_READINESS_GATE_BLOCKED", `${action} is not available for this workspace state. Complete the preceding gates first.`, readiness);
}

/** Execute exactly one user-initiated delivery gate, then return refreshed readiness. */
export async function runModuleReadinessAction(engineRoot: string, vaultRoot: string, moduleId: string, action: ModuleReadinessAction, options: { confirmBreaking?: boolean; codexModel?: string; codexReasoningEffort?: string } = {}): Promise<JsonObject> {
  let readiness = await getModuleReadiness(engineRoot, vaultRoot, moduleId);
  requireReadyStep(readiness, action);
  const root = workspaceRoot(vaultRoot, moduleId);
  let result: JsonValue;
  if (action === "implement") result = await implementModuleWorkspace(engineRoot, vaultRoot, moduleId, { codexModel: options.codexModel, codexReasoningEffort: options.codexReasoningEffort });
  else if (action === "validate") result = await validateModule(engineRoot, root, { writeReport: true });
  else if (action === "test") result = await testModule(engineRoot, moduleId, { writeReport: true, moduleRoot: root });
  else if (action === "sandbox") {
    result = await runModuleSandbox(engineRoot, moduleId, { moduleRoot: root });
    await writeJsonAtomic(path.join(root, "sandbox-report.json"), result);
  } else {
    const manifest = parseYaml(root, path.join(root, "module.yaml"));
    const packagePath = path.join(vaultRoot, "90-System", "Modules", "Packages", moduleId, `${String(manifest.version)}.pkb-module`);
    if (action === "pack") result = await packModuleDirectory(engineRoot, root, packagePath);
    else {
      if (!(await exists(packagePath))) throw new PkbError("MODULE_PACKAGE_NOT_FOUND", "Package the module before installation.");
      result = await installModulePackage(engineRoot, vaultRoot, packagePath, { enable: true, upgrade: true, confirmBreaking: options.confirmBreaking === true });
    }
  }
  readiness = await getModuleReadiness(engineRoot, vaultRoot, moduleId);
  return { action, result, readiness };
}
