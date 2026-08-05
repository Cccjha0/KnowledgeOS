import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseYaml, writeMarkdown } from "../core/bridge.js";
import { exists, writeJsonAtomic } from "../core/files.js";
import { PkbError } from "../core/errors.js";
import type { JsonObject, JsonValue } from "../core/types.js";
import { initializeVault } from "../core/vault.js";
import { createInstance, manageInstance } from "../platform/lifecycleWorkflow.js";
import { RuntimeRepository } from "../runtime/repository.js";
import { executeTask } from "../runtime/worker.js";
import { createModuleWorkflowRunner } from "./workflowRunner.js";
import type { ModuleTestCheck, ModuleTestReport } from "./types.js";
import { validateModule } from "./validator.js";

function object(value: JsonValue | undefined, code: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PkbError(code, "Expected an object.");
  return value;
}

function requiredString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new PkbError("MODULE_TEST_FIXTURE_INVALID", `${label} is required.`);
  return value;
}

function lookup(data: JsonObject, dotted: string): JsonValue | undefined {
  let current: JsonValue | undefined = data;
  for (const part of dotted.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as JsonObject)[part];
  }
  return current;
}

function fixtureFields(manifest: JsonObject, fixture: JsonObject): JsonObject {
  const form = object(manifest.instance_form, "MODULE_TEST_MANIFEST_INVALID");
  const fields = Array.isArray(form.fields) ? form.fields : [];
  const output: JsonObject = {};
  for (const raw of fields) {
    const field = object(raw as JsonValue, "MODULE_TEST_MANIFEST_INVALID");
    const key = requiredString(field.key, "instance_form.fields[].key");
    const value = lookup(fixture, key);
    if (value !== undefined) output[key] = value;
  }
  return output;
}

function check(category: ModuleTestCheck["category"], status: ModuleTestCheck["status"], message: string, details?: JsonObject): ModuleTestCheck {
  return { category, status, message, details: details ?? null };
}

/**
 * Executes a declarative module fixture in an isolated, disposable Vault.
 * Codex is intentionally replaced with the fixture's schema-valid output: this
 * tests Core routing, plans, idempotency and lifecycle without needing a model.
 */
export async function testModule(engineRoot: string, moduleId: string, options: { writeReport?: boolean } = {}): Promise<ModuleTestReport> {
  const moduleRoot = path.join(engineRoot, "modules", moduleId);
  const staticValidation = await validateModule(engineRoot, moduleRoot);
  const checks: ModuleTestCheck[] = [];
  const manifest = parseYaml(engineRoot, path.join(moduleRoot, "module.yaml"));
  const fixtureRoot = path.join(moduleRoot, "fixtures", "sample-instance");
  const instanceFile = path.join(fixtureRoot, "instance.yaml");
  const captureFile = path.join(fixtureRoot, "capture-test.yaml");
  const maturity = String(manifest.maturity ?? "experimental");
  if (staticValidation.overall === "FAIL") {
    checks.push(check("capture", "fail", "Static validation failed; behavior tests were not started."));
    return finalize(moduleRoot, moduleId, manifest, staticValidation, checks, options);
  }
  if (!(await exists(instanceFile)) || !(await exists(captureFile))) {
    checks.push(check("capture", "fail", "A Beta module requires fixtures/sample-instance/instance.yaml and capture-test.yaml."));
    return finalize(moduleRoot, moduleId, manifest, staticValidation, checks, options);
  }

  const fixtureInstance = parseYaml(moduleRoot, instanceFile);
  const fixtureCapture = parseYaml(moduleRoot, captureFile);
  const capture = object(fixtureCapture.capture, "MODULE_TEST_FIXTURE_INVALID");
  const captureRelative = requiredString(capture.path, "capture.path");
  const captureContent = requiredString(capture.content, "capture.content");
  const expectedOutput = requiredString(capture.expected_output, "capture.expected_output");
  const codexOutput = object(capture.codex_output, "MODULE_TEST_FIXTURE_INVALID");
  const itemId = typeof capture.item_id === "string" ? capture.item_id : "module-test-capture";
  const instanceId = requiredString(fixtureInstance.instance_id, "fixture instance_id");
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), `knowledgeos-module-test-${moduleId}-`));
  try {
    await initializeVault(vault, "disabled");
    await writeJsonAtomic(path.join(vault, "90-System", "Modules", "installed.json"), { schema_version: 1, modules: [{ id: moduleId, version: String(manifest.version), status: "enabled" }] });
    await createInstance(vault, {
      module_id: moduleId, instance_id: instanceId, display_name: requiredString(fixtureInstance.display_name, "fixture display_name"),
      fields: fixtureFields(manifest, fixtureInstance),
    });
    for (const raw of Array.isArray(fixtureCapture.seed_documents) ? fixtureCapture.seed_documents : []) {
      const seed = object(raw as JsonValue, "MODULE_TEST_FIXTURE_INVALID");
      const target = requiredString(seed.path, "seed_documents[].path");
      if (target.split("/").includes("..") || path.isAbsolute(target)) throw new PkbError("MODULE_TEST_FIXTURE_INVALID", "Seed document paths must be Vault-relative.");
      const absolute = path.join(vault, ...target.split("/"));
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      writeMarkdown(vault, absolute, { data: object(seed.data, "MODULE_TEST_FIXTURE_INVALID"), content: typeof seed.content === "string" ? seed.content : "" });
    }
    const sourceFile = `${String((await instanceLocation(vault, instanceId)).inbox_path)}/${captureRelative}`;
    const sourceAbsolute = path.join(vault, ...sourceFile.split("/"));
    await fs.mkdir(path.dirname(sourceAbsolute), { recursive: true });
    await fs.writeFile(sourceAbsolute, captureContent, "utf8");

    const runner = createModuleWorkflowRunner(async () => ({ output: codexOutput, stderr: "" }));
    const first = await executeFixtureTask(vault, moduleId, instanceId, sourceFile, itemId, "first", runner);
    if (first.status !== "completed" || !(await exists(path.join(vault, ...expectedOutput.split("/"))))) {
      checks.push(check("capture", "fail", "Capture fixture did not produce its declared output.", { task_status: first.status, expected_output: expectedOutput }));
    } else {
      checks.push(check("capture", "pass", "Capture fixture produced the declared output.", { expected_output: expectedOutput }));
      if (capture.restore_source_for_repeat === true && !(await exists(sourceAbsolute))) {
        await fs.mkdir(path.dirname(sourceAbsolute), { recursive: true });
        await fs.copyFile(path.join(vault, ...expectedOutput.split("/")), sourceAbsolute);
      }
      const repeat = await executeFixtureTask(vault, moduleId, instanceId, sourceFile, itemId, "repeat", runner);
      checks.push(check("idempotency", repeat.status === "completed" ? "pass" : "fail", repeat.status === "completed" ? "Repeated Capture recovered without a duplicate write." : "Repeated Capture did not complete safely.", { task_status: repeat.status }));
    }
    try {
      await manageInstance(vault, { instance_id: instanceId, action: "pause" });
      await manageInstance(vault, { instance_id: instanceId, action: "resume" });
      await manageInstance(vault, { instance_id: instanceId, action: "archive", confirm: true });
      checks.push(check("lifecycle", "pass", "Fixture instance paused, resumed, and archived."));
    } catch (error) {
      checks.push(check("lifecycle", "fail", error instanceof Error ? error.message : String(error)));
    }
    checks.push(check("periodic", "not-applicable", "No declarative periodic fixture is configured."));
    checks.push(check("migration", "not-applicable", "No declarative migration fixture is configured."));
  } catch (error) {
    checks.push(check("capture", "fail", error instanceof Error ? error.message : String(error)));
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
  return finalize(moduleRoot, moduleId, manifest, staticValidation, checks, options);
}

async function instanceLocation(vaultRoot: string, instanceId: string): Promise<JsonObject> {
  return parseYaml(vaultRoot, path.join(vaultRoot, "90-System", "Instances", instanceId, "instance.yaml"));
}

async function executeFixtureTask(vaultRoot: string, moduleId: string, instanceId: string, sourceFile: string, itemId: string, attempt: string, runner: ReturnType<typeof createModuleWorkflowRunner>) {
  const repository = await RuntimeRepository.open(vaultRoot);
  try {
    const task = repository.createTask({
      job_id: `${moduleId}.fixture-capture`, module: moduleId, instance_id: instanceId, task_type: "workflow", workflow: `module:${moduleId}:capture`, priority: "high",
      resources: { filesystem: "required", network: "not-required", codex: "required", user: "not-required" },
      trigger: { type: "manual", entrypoint: "capture" }, catch_up_policy: "none", idempotency_key: `module-test:${moduleId}:${instanceId}:${itemId}:${attempt}`,
      payload: { source_file: sourceFile, item_id: itemId },
    }).task;
    return await executeTask(vaultRoot, repository, task, "module-test-runner", { filesystem: "available", network: "not-required", codex: "available", user: "available" }, {}, runner);
  } finally { repository.close(); }
}

async function finalize(moduleRoot: string, moduleId: string, manifest: JsonObject, staticValidation: Awaited<ReturnType<typeof validateModule>>, checks: ModuleTestCheck[], options: { writeReport?: boolean }): Promise<ModuleTestReport> {
  const capturePassed = checks.some((item) => item.category === "capture" && item.status === "pass");
  const failed = staticValidation.overall === "FAIL" || checks.some((item) => item.status === "fail");
  const report: ModuleTestReport = {
    report_version: 1, module_id: moduleId, module_version: String(manifest.version), generated_at: new Date().toISOString(), static_validation: staticValidation,
    checks, overall: failed ? "FAIL" : "PASS", beta_eligible: !failed && (String(manifest.maturity) !== "beta" || capturePassed),
  };
  if (options.writeReport) await writeJsonAtomic(path.join(moduleRoot, "module-test-report.json"), report);
  return report;
}
