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
import type { TaskResources } from "../runtime/domain.js";
import { evaluateResourceGate } from "../runtime/resourceGate.js";
import { executeTask } from "../runtime/worker.js";
import { registerDeclaredJobs } from "../runtime/jobRegistry.js";
import { evaluateScheduler } from "../runtime/scheduler.js";
import { publishRuntimeEvent } from "../runtime/triggers.js";
import { applyMigration, planMigrations, rollbackMigration } from "../core/migrations.js";
import { ModuleSdk } from "./sdk.js";
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
  const contractFile = path.join(fixtureRoot, "module-test.yaml");
  const instanceFile = path.join(fixtureRoot, "instance.yaml");
  const captureFile = path.join(fixtureRoot, "capture-test.yaml");
  const maturity = String(manifest.maturity ?? "experimental");
  if (staticValidation.overall === "FAIL") {
    checks.push(check("capture", "fail", "Static validation failed; behavior tests were not started."));
    return finalize(moduleRoot, moduleId, manifest, staticValidation, checks, options);
  }
  if (!(await exists(instanceFile)) || !(await exists(captureFile)) || !(await exists(contractFile))) {
    checks.push(check("capture", "fail", "A Beta module requires instance.yaml, capture-test.yaml, and module-test.yaml."));
    return finalize(moduleRoot, moduleId, manifest, staticValidation, checks, options);
  }

  const fixtureInstance = parseYaml(moduleRoot, instanceFile);
  const fixtureCapture = parseYaml(moduleRoot, captureFile);
  const contract = object(parseYaml(moduleRoot, contractFile), "MODULE_TEST_CONTRACT_INVALID");
  const scenarios = object(contract.scenarios, "MODULE_TEST_CONTRACT_INVALID");
  const requiredScenarios = ["normal_capture", "ambiguous_capture", "permission_denied", "repeat_execution", "paused_instance", "archived_instance"];
  const missingScenarios = requiredScenarios.filter((name) => !scenarios[name] || typeof scenarios[name] !== "object" || Array.isArray(scenarios[name]));
  if (missingScenarios.length) {
    checks.push(check("capture", "fail", `Module test contract is missing required scenarios: ${missingScenarios.join(", ")}.`));
    return finalize(moduleRoot, moduleId, manifest, staticValidation, checks, options);
  }
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
    for (const raw of Array.isArray(capture.seed_documents) ? capture.seed_documents : []) {
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
      checks.push(check("capture", "fail", "Capture fixture did not produce its declared output.", { task_status: first.status, expected_output: expectedOutput, error: first.last_error }));
    } else {
      checks.push(check("capture", "pass", "Capture fixture produced the declared output.", { expected_output: expectedOutput }));
      if (capture.restore_source_for_repeat === true && !(await exists(sourceAbsolute))) {
        await fs.mkdir(path.dirname(sourceAbsolute), { recursive: true });
        await fs.copyFile(path.join(vault, ...expectedOutput.split("/")), sourceAbsolute);
      }
      const repeat = await executeFixtureTask(vault, moduleId, instanceId, sourceFile, itemId, "repeat", runner);
      checks.push(check("idempotency", repeat.status === "completed" ? "pass" : "fail", repeat.status === "completed" ? "Repeated Capture recovered without a duplicate write." : "Repeated Capture did not complete safely.", { task_status: repeat.status }));
    }
    const ambiguous = object(scenarios.ambiguous_capture, "MODULE_TEST_CONTRACT_INVALID");
    const ambiguousExpected = requiredString(ambiguous.expected, "ambiguous_capture.expected");
    checks.push(check("ambiguous", ["review", "rejected", "failed"].includes(ambiguousExpected) ? "pass" : "fail", ["review", "rejected", "failed"].includes(ambiguousExpected)
      ? `Ambiguous Capture declares the required safe outcome: ${ambiguousExpected}.`
      : "Ambiguous Capture must declare review, rejected, or failed as its safe outcome."));

    const permission = object(scenarios.permission_denied, "MODULE_TEST_CONTRACT_INVALID");
    const deniedTarget = requiredString(permission.target, "permission_denied.target");
    const instance = await instanceLocation(vault, instanceId);
    const sdk = new ModuleSdk({ vaultRoot: vault, moduleId, moduleVersion: String(manifest.version), instanceId, allowedReadRoots: [requiredString(instance.content_root, "instance.content_root")], ownedWriteRoots: [requiredString(instance.content_root, "instance.content_root")], maxReadLevel: 0 });
    let denied = false;
    try { sdk.buildOperationPlan({ planId: "PLAN-TEST-DENIED", taskId: "TASK-TEST-DENIED", summary: "permission fixture", operations: [{ operation_id: "OP-001", type: "create-file", target: deniedTarget, risk: "green", confidence: 1, idempotency_key: "test-denied", requires_review_id: null, payload: { format: "text", text: "must not write" } }] }); }
    catch { denied = true; }
    checks.push(check("permission", denied ? "pass" : "fail", denied ? "Cross-boundary write was rejected." : "Permission fixture unexpectedly built a cross-boundary plan."));

    const resourceRepository = await RuntimeRepository.open(vault);
    let resourceGate;
    try {
      const resourceTask = resourceRepository.createTask({ job_id: `${moduleId}.fixture-resource`, module: moduleId, instance_id: instanceId, task_type: "workflow", workflow: `module:${moduleId}:capture`, priority: "high", resources: { filesystem: "required", network: "not-required", codex: "required", user: "not-required" }, trigger: { type: "manual" }, catch_up_policy: "none", idempotency_key: `module-test:${moduleId}:${instanceId}:codex-unavailable`, payload: { source_file: sourceFile, item_id: itemId } }).task;
      resourceRepository.setResourceStatus({ resource: "codex", status: "unavailable", reason: "fixture", checked_at: new Date().toISOString(), details: {} });
      resourceGate = await evaluateResourceGate(vault, resourceRepository, resourceTask);
    } finally { resourceRepository.close(); }
    checks.push(check("resource", resourceGate?.waiting_status === "waiting-for-ai" ? "pass" : "fail", resourceGate?.waiting_status === "waiting-for-ai" ? "Codex-unavailable Capture is held by the Resource Gate." : "Codex-unavailable Capture did not enter waiting-for-ai."));

    const prompt = object(scenarios.prompt_regression, "MODULE_TEST_CONTRACT_INVALID");
    const invariantFile = path.join(moduleRoot, ...requiredString(prompt.fixture, "prompt_regression.fixture").split("/"));
    const promptFixture = parseYaml(moduleRoot, invariantFile);
    const invariants = Array.isArray(promptFixture.invariants) ? promptFixture.invariants.filter((item): item is string => typeof item === "string") : [];
    const requiredInvariants = ["preserve-facts", "uncertainty-preserved", "schema-valid"];
    const missingInvariants = requiredInvariants.filter((name) => !invariants.includes(name));
    if (!invariants.includes("no-invented-values") && !invariants.includes("no-invented-completion")) missingInvariants.push("no-invented-values or no-invented-completion");
    checks.push(check("prompt-regression", missingInvariants.length ? "fail" : "pass", missingInvariants.length ? `Prompt invariants are missing: ${missingInvariants.join(", ")}.` : "Prompt fixture declares fact preservation, uncertainty, and schema invariants."));

    const periodic = object(scenarios.periodic_job, "MODULE_TEST_CONTRACT_INVALID");
    if (periodic.enabled === true) {
      await registerDeclaredJobs(vault);
      const scheduledAt = new Date(requiredString(periodic.scheduled_at, "periodic_job.scheduled_at"));
      const scheduled = await evaluateScheduler(vault, scheduledAt);
      checks.push(check("periodic", scheduled.created.length > 0 ? "pass" : "fail", scheduled.created.length > 0 ? "Periodic Job materialized a durable Task." : "Periodic Job did not materialize a Task.", { created: scheduled.created }));
    } else checks.push(check("periodic", "not-applicable", "Module has no periodic Job scenario."));

    const event = object(scenarios.event_consumption, "MODULE_TEST_CONTRACT_INVALID");
    if (event.enabled === true) {
      const repository = await RuntimeRepository.open(vault);
      try {
        repository.registerJob({ job_id: `${moduleId}.fixture-event.${instanceId}`, source: "module", module: moduleId, scope: "instance", enabled: true, task_type: "workflow", workflow: `module:${moduleId}:capture`, resources: { filesystem: "required", network: "not-required", codex: "required", user: "not-required" }, trigger: { type: "event", event: requiredString(event.event_type, "event_consumption.event_type"), instance_id: instanceId }, catch_up: { policy: "none" }, retry: { max_attempts: 1 }, concurrency: { policy: "forbid", key: `${moduleId}:${instanceId}:fixture-event` }, idempotency: {}, priority: "normal", updated_at: new Date().toISOString() });
      } finally { repository.close(); }
      const published = await publishRuntimeEvent(vault, { type: requiredString(event.event_type, "event_consumption.event_type"), module: moduleId, instance_id: instanceId, payload: { fixture: true } });
      checks.push(check("event", published.created.length === 1 ? "pass" : "fail", published.created.length === 1 ? "Event was persisted and produced one downstream Task." : "Event fixture did not produce the expected downstream Task.", { created: published.created }));
    } else checks.push(check("event", "not-applicable", "Module has no event-consumption scenario."));

    const migration = object(scenarios.migration_apply, "MODULE_TEST_CONTRACT_INVALID");
    if (migration.enabled === true) {
      const planned = (await planMigrations(vault, engineRoot)).filter((candidate) => candidate.module_id === moduleId);
      const run = planned[0];
      if (!run) checks.push(check("migration", "fail", "Migration fixture did not produce a migration plan."));
      else {
        const applied = await applyMigration(vault, run.migration_run_id);
        const repeated = await applyMigration(vault, run.migration_run_id);
        const rolledBack = applied.status === "completed" && migration.rollback === true ? await rollbackMigration(vault, run.migration_run_id) : null;
        checks.push(check("migration", applied.status === "completed" && repeated.status === "completed" && (!migration.rollback || rolledBack?.status === "rolled-back") ? "pass" : "fail", "Migration apply, repeat, and rollback completed.", { status: applied.status, repeat_status: repeated.status, rollback_status: rolledBack?.status ?? null }));
      }
    } else checks.push(check("migration", "not-applicable", "Module declares no schema migration."));
    try {
      await manageInstance(vault, { instance_id: instanceId, action: "pause" });
      await registerDeclaredJobs(vault);
      const pausedRepository = await RuntimeRepository.open(vault);
      let pausedJobs;
      try { pausedJobs = pausedRepository.listJobs().filter((job) => job.module === moduleId && job.scope === "instance" && !job.job_id.includes(".fixture-event.")); }
      finally { pausedRepository.close(); }
      checks.push(check("lifecycle", pausedJobs.every((job) => !job.enabled) ? "pass" : "fail", pausedJobs.every((job) => !job.enabled) ? "Paused instance disabled its periodic Jobs." : "Paused instance left periodic Jobs enabled."));
      await manageInstance(vault, { instance_id: instanceId, action: "resume" });
      await manageInstance(vault, { instance_id: instanceId, action: "archive", confirm: true });
      checks.push(check("lifecycle", "pass", "Fixture instance paused, resumed, and archived."));
    } catch (error) {
      checks.push(check("lifecycle", "fail", error instanceof Error ? error.message : String(error)));
    }
  } catch (error) {
    checks.push(check("capture", "fail", error instanceof Error ? error.message : String(error)));
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
  return finalize(moduleRoot, moduleId, manifest, staticValidation, checks, options);
}

async function instanceLocation(vaultRoot: string, instanceId: string): Promise<JsonObject> {
  return parseYaml(vaultRoot, path.join(vaultRoot, "90-System", "Instances", instanceId, "instance.yaml"));
}

async function executeFixtureTask(vaultRoot: string, moduleId: string, instanceId: string, sourceFile: string, itemId: string, attempt: string, runner: ReturnType<typeof createModuleWorkflowRunner>, resources: Record<keyof TaskResources, "available" | "unavailable" | "not-required"> = { filesystem: "available", network: "not-required", codex: "available", user: "available" }) {
  const repository = await RuntimeRepository.open(vaultRoot);
  try {
    const task = repository.createTask({
      job_id: `${moduleId}.fixture-capture`, module: moduleId, instance_id: instanceId, task_type: "workflow", workflow: `module:${moduleId}:capture`, priority: "high",
      resources: { filesystem: "required", network: "not-required", codex: "required", user: "not-required" },
      trigger: { type: "manual", entrypoint: "capture" }, catch_up_policy: "none", idempotency_key: `module-test:${moduleId}:${instanceId}:${itemId}:${attempt}`,
      payload: { source_file: sourceFile, item_id: itemId },
    }).task;
    return await executeTask(vaultRoot, repository, task, "module-test-runner", resources, {}, runner);
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
