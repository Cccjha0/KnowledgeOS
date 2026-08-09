import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseYaml, writeYaml } from "../core/bridge.js";
import { readJson, writeJsonAtomic } from "../core/files.js";
import type { JsonObject, JsonValue, Operation } from "../core/types.js";
import { initializeVault } from "../core/vault.js";
import { invokeCommandApi } from "../platform/commandApi.js";
import { installModulePackage, packModuleDirectory, rollbackModulePackage } from "../modules/packageManager.js";
import { syncInstalledConfiguration } from "../platform/configuration.js";
import { generationTrace, resolveVersionedEntry } from "../modules/registries.js";
import { createModuleScaffold } from "../modules/scaffold.js";
import { deriveBlueprintApproval, scaffoldModuleFromBlueprint, validateModuleBlueprint } from "../modules/blueprint.js";
import { analyzeGuidedModuleRequirement, normalizeGuidedBuilderAnalysis } from "../modules/guidedBuilder.js";
import { ModuleSdk } from "../modules/sdk.js";
import { testModule } from "../modules/testRunner.js";
import { validateModule } from "../modules/validator.js";
import { runModuleSandbox } from "../modules/sandbox.js";
import { engineProvenance, fixtureChecksum, moduleContentChecksum } from "../modules/readinessEvidence.js";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { buildQuickBlueprint } = createRequire(import.meta.url)(path.join(SOURCE_ROOT, "plugins", "knowledgeos-obsidian", "views", "module-builder-modal.js")) as {
  buildQuickBlueprint: (form: Record<string, unknown>) => JsonObject;
};

async function writeReadinessEvidence(engineRoot: string, moduleId: string, moduleRoot: string): Promise<void> {
  const validation = await validateModule(engineRoot, moduleRoot, { writeReport: true });
  const provenance = await engineProvenance(engineRoot);
  const environment = { git_commit: provenance.engine_commit, engine_version: provenance.engine_version, module_checksum: await moduleContentChecksum(moduleRoot), fixture_checksum: await fixtureChecksum(moduleRoot), os: "test", node: process.version, python: null };
  // Package verification is tested here with the persisted evidence contract;
  // real fixture execution is covered by the dedicated Module Test cases.
  await writeJsonAtomic(path.join(moduleRoot, "module-test-report.json"), { report_version: 1, module_id: moduleId, module_version: validation.module_version, generated_at: new Date().toISOString(), static_validation: validation, environment, checks: [], overall: "PASS", beta_eligible: true });
  await writeJsonAtomic(path.join(moduleRoot, "sandbox-report.json"), { sandbox_version: 1, module_id: moduleId, isolation: "temporary-vault", lifecycle: "created-executed-cleaned", overall: "PASS", checks: [], environment });
}

function approveBlueprint(blueprint: JsonObject): JsonObject {
  const approval = deriveBlueprintApproval(blueprint);
  return { blueprint_hash: approval.blueprint_hash, approved_requirement_ids: approval.requirements.map((requirement) => requirement.id) };
}

async function temporaryEngine(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-module-engine-"));
  await fs.mkdir(path.join(root, "core"), { recursive: true });
  await fs.cp(path.join(SOURCE_ROOT, "core", "schemas"), path.join(root, "core", "schemas"), { recursive: true });
  await fs.mkdir(path.join(root, "core", "module-builder"), { recursive: true });
  await fs.cp(path.join(SOURCE_ROOT, "core", "module-builder", "capability-packs.yaml"), path.join(root, "core", "module-builder", "capability-packs.yaml"));
  await fs.cp(path.join(SOURCE_ROOT, "components"), path.join(root, "components"), { recursive: true });
  await fs.mkdir(path.join(root, "tools"), { recursive: true });
  await fs.cp(path.join(SOURCE_ROOT, "tools", "module_bridge.py"), path.join(root, "tools", "module_bridge.py"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "0.9.0-beta" }), "utf8");
  return root;
}

test("Module Blueprint resolves templates, Capability Packs, Adapters, and Components", async () => {
  const blueprint = path.join(SOURCE_ROOT, "examples", "module-blueprints", "course.blueprint.yaml");
  const { report, scaffoldTemplate } = await validateModuleBlueprint(SOURCE_ROOT, blueprint);
  assert.equal(report.overall, "PASS");
  assert.equal(scaffoldTemplate, "workflow");
  assert.equal(report.resolved_capability_packs.includes("capture-processing"), true, "transitive Pack dependencies should resolve");
  assert.equal(report.resolved_capabilities.includes("periodic-summary"), true);
  assert.equal(report.required_components["periodic-rollup"], "^1.0.0");
  assert.equal(report.checks.some((item) => item.code === "INPUT_ADAPTER_AVAILABLE" && item.message.includes("pptx")), true);
  assert.equal(report.checks.some((item) => item.code === "CAPABILITY_PACK_PRIVACY_BOUND" && item.status === "pass"), true, "high-privacy and immutable-user-content must enforce executable Pack contracts.");
});

test("Quick Builder emits a complete Blueprint v1.1 Record Module and a recent-records provider", async () => {
  const engine = await temporaryEngine();
  try {
    const blueprint = buildQuickBlueprint({
      id: "quick-records", name: "Quick records", description: "Capture concise records.",
      primary: "Capture a record", excluded: "Delete source files", inputs: "markdown,pdf",
      sensitivity: "1", representation: "full", critical: "source_url", weekly: true,
    });
    const blueprintPath = path.join(engine, "quick-records.blueprint.yaml");
    writeYaml(engine, blueprintPath, blueprint);

    const preview = await validateModuleBlueprint(engine, blueprintPath);
    assert.equal(preview.report.overall, "PASS", preview.report.checks.filter((item) => item.status === "fail").map((item) => item.message).join("\n"));
    assert.deepEqual((blueprint.entities as JsonObject[]).find((entity) => entity.id === "knowledge-record")?.schema, {
      fields: {
        created: { type: "datetime", required: true, description: "The time the record was created." },
        record_kind: { type: "string", description: "The record category, when it can be determined from the capture." },
        source_url: { type: "string", critical: true, description: "A user-designated critical source_url value." },
      },
    });
    const capture = (blueprint.workflows as JsonObject[]).find((workflow) => workflow.id === "normalize-record")!;
    assert.deepEqual(capture.input_roles, ["record-input"]);
    assert.deepEqual(capture.operation, { type: "create-record", target: "{instance.content_root}/Records/{task.payload.item_id}.md", template: "templates/knowledge-record.md" });
    assert.equal(((blueprint.review_policy as JsonObject).critical_fields as JsonValue[])[0], "knowledge-record.source_url");

    const generated = await scaffoldModuleFromBlueprint(engine, blueprintPath);
    const provider = parseYaml(String(generated.module_root), path.join(String(generated.module_root), "dashboard", "provider.yaml"));
    const recent = (provider.items as JsonObject[]).find((item) => item.id === "recent-records");
    assert.deepEqual(recent, {
      id: "recent-records", kind: "recent", entity: "knowledge-record", date_field: "created", limit: 5,
      category: "summary", priority: "low", title: "{title}", description: "记录创建于：{created}", actions: ["open"],
    });
  } finally {
    await fs.rm(engine, { recursive: true, force: true });
  }
});

test("Capability Pack contracts reject Blueprint privacy drift before scaffolding", async () => {
  const source = parseYaml(SOURCE_ROOT, path.join(SOURCE_ROOT, "examples", "module-blueprints", "course.blueprint.yaml"));
  (source.privacy as JsonObject).network_allowed = true;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-pack-contract-"));
  try {
    const blueprint = path.join(directory, "course.blueprint.yaml");
    writeYaml(directory, blueprint, source);
    const { report } = await validateModuleBlueprint(SOURCE_ROOT, blueprint);
    assert.equal(report.overall, "FAIL");
    assert.equal(report.checks.some((item) => item.code === "CAPABILITY_PACK_PRIVACY_DENIED" && item.status === "fail"), true);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("Module Blueprint rejects inputs without an installed Adapter", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-blueprint-invalid-"));
  try {
    const source = path.join(SOURCE_ROOT, "examples", "module-blueprints", "media-library.blueprint.yaml");
    const blueprint = parseYaml(SOURCE_ROOT, source);
    blueprint.inputs = ["markdown", "docx"];
    const target = path.join(root, "invalid.blueprint.yaml");
    writeYaml(root, target, blueprint);
    const { report } = await validateModuleBlueprint(SOURCE_ROOT, target);
    assert.equal(report.overall, "FAIL");
    assert.equal(report.checks.some((item) => item.code === "INPUT_ADAPTER_UNAVAILABLE" && item.status === "fail"), true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("Command API previews a Module Blueprint without creating source files", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-blueprint-preview-"));
  try {
    await initializeVault(vault, "disabled");
    const blueprint = parseYaml(SOURCE_ROOT, path.join(SOURCE_ROOT, "examples", "module-blueprints", "media-library.blueprint.yaml"));
    const response = await invokeCommandApi({ vaultRoot: vault, requestId: "BLUEPRINT-PREVIEW", method: "previewModuleBlueprint", params: { blueprint } });
    assert.equal(response.ok, true);
    assert.equal((response.data as JsonObject).scaffold_template, "minimal-config");
    assert.equal(((response.data as JsonObject).report as JsonObject).overall, "PASS");
    assert.equal(typeof ((response.data as JsonObject).approval as JsonObject).blueprint_hash, "string");
    assert.equal(await fs.stat(path.join(vault, "90-System", "Cache", "Module Builder", "BLUEPRINT-PREVIEW.blueprint.yaml")).then(() => true).catch(() => false), false, "temporary Blueprint must be cleaned");
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("Guided Module Builder preserves the extension boundary and never exposes an unvalidated proposal", async () => {
  const blueprint = parseYaml(SOURCE_ROOT, path.join(SOURCE_ROOT, "examples", "module-blueprints", "course.blueprint.yaml"));
  const result = await analyzeGuidedModuleRequirement({
    brief: "Organize course lectures and assignment briefs into a separate course workspace with weekly summaries.",
    execute: async () => ({
      stderr: "",
      output: {
        boundary: { kind: "module", rationale: "Course work has its own entities and lifecycle.", exclusions: ["Do not edit the original slides."] },
        summary: "A course module is appropriate.",
        questions: [{ id: "course-full-text", category: "content-access", question: "Allow full lecture text?", impact: "The selected content is provided to Codex." }],
        proposed_blueprint: blueprint,
        capability_gap: null,
      },
    }),
  });
  assert.equal(result.boundary.kind, "module");
  assert.equal(result.questions[0]?.id, "course-full-text");
  assert.equal((result.proposed_blueprint as JsonObject).blueprint_version, 1.1);
  assert.throws(() => normalizeGuidedBuilderAnalysis("A long enough requirement for a component.", {
    boundary: { kind: "component", rationale: "shared", exclusions: [] }, summary: "shared", questions: [], proposed_blueprint: blueprint, capability_gap: null,
  }), /Only a module decision/);
});

test("Command API creates a Blueprint module in the Vault development workspace, not Engine source", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-blueprint-workspace-"));
  try {
    await initializeVault(vault, "disabled");
    const blueprint = parseYaml(SOURCE_ROOT, path.join(SOURCE_ROOT, "examples", "module-blueprints", "media-library.blueprint.yaml"));
    const bypass = await invokeCommandApi({ vaultRoot: vault, requestId: "BLUEPRINT-WORKSPACE-BYPASS", method: "createModuleFromBlueprint", params: { blueprint, confirm: true } });
    assert.equal(bypass.ok, false, "A generic confirm flag must not bypass Core approval requirements.");
    assert.equal(bypass.error?.code, "BLUEPRINT_APPROVAL_STALE");
    const response = await invokeCommandApi({ vaultRoot: vault, requestId: "BLUEPRINT-WORKSPACE", method: "createModuleFromBlueprint", params: { blueprint, confirm: true, approval: approveBlueprint(blueprint) } });
    assert.equal(response.ok, true);
    assert.equal((response.data as JsonObject).workspace_path, "90-System/Module Development/media-library");
    assert.equal(await fs.stat(path.join(vault, "90-System", "Module Development", "media-library", "module.yaml")).then(() => true), true);
    assert.equal(await fs.stat(path.join(SOURCE_ROOT, "modules", "media-library", "module.yaml")).then(() => true).catch(() => false), false);
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("Core security gate derives, binds, and enforces Blueprint approvals", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-blueprint-approval-"));
  try {
    await initializeVault(vault, "disabled");
    const blueprint = parseYaml(SOURCE_ROOT, path.join(SOURCE_ROOT, "examples", "module-blueprints", "course.blueprint.yaml"));
    const approval = deriveBlueprintApproval(blueprint);
    assert.deepEqual(approval.requirements.map((requirement) => requirement.id), ["sensitive-full-read", "critical-fields"]);
    const missing = await invokeCommandApi({ vaultRoot: vault, requestId: "BLUEPRINT-APPROVAL-MISSING", method: "createModuleFromBlueprint", params: { blueprint, confirm: true, approval: { blueprint_hash: approval.blueprint_hash, approved_requirement_ids: [] } } });
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.code, "BLUEPRINT_APPROVAL_REQUIRED");
    const changed = structuredClone(blueprint);
    (changed.privacy as JsonObject).network_allowed = true;
    const stale = await invokeCommandApi({ vaultRoot: vault, requestId: "BLUEPRINT-APPROVAL-STALE", method: "createModuleFromBlueprint", params: { blueprint: changed, confirm: true, approval: approveBlueprint(blueprint) } });
    assert.equal(stale.ok, false);
    assert.equal(stale.error?.code, "BLUEPRINT_APPROVAL_STALE");
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("Module workspace readiness keeps a scaffold separate from validation and installation", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-module-readiness-"));
  try {
    await initializeVault(vault, "disabled");
    const blueprint = parseYaml(SOURCE_ROOT, path.join(SOURCE_ROOT, "examples", "module-blueprints", "media-library.blueprint.yaml"));
    const create = await invokeCommandApi({ vaultRoot: vault, requestId: "READINESS-CREATE", method: "createModuleFromBlueprint", params: { blueprint, confirm: true, approval: approveBlueprint(blueprint) } });
    assert.equal(create.ok, true);
    const before = await invokeCommandApi({ vaultRoot: vault, requestId: "READINESS-STATUS", method: "getModuleReadiness", params: { module_id: "media-library" } });
    assert.equal(before.ok, true);
    assert.equal((before.data as JsonObject).state, "implementation-required");
    assert.deepEqual((before.data as JsonObject).available_actions, ["validate"]);
    const validation = await invokeCommandApi({ vaultRoot: vault, requestId: "READINESS-VALIDATE", method: "runModuleReadinessAction", params: { module_id: "media-library", action: "validate" } });
    assert.equal(validation.ok, true);
    const refreshed = (validation.data as JsonObject).readiness as JsonObject;
    assert.equal(refreshed.state, "implementation-required");
    const steps = refreshed.steps as JsonObject[];
    assert.equal(steps.find((step) => step.id === "validation")?.status, "complete");
    assert.equal((refreshed.available_actions as string[]).includes("test"), true);
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("Blueprint scaffolding deterministically creates a runtime-valid module", async () => {
  const engine = await temporaryEngine();
  try {
    const blueprint = path.join(SOURCE_ROOT, "examples", "module-blueprints", "course.blueprint.yaml");
    const generated = await scaffoldModuleFromBlueprint(engine, blueprint);
    const moduleRoot = String(generated.module_root);
    assert.equal(await fs.stat(path.join(moduleRoot, "module.blueprint.yaml")).then(() => true), true);
    assert.equal(await fs.stat(path.join(moduleRoot, "docs", "blueprint-boundary.md")).then(() => true), true);
    const manifest = parseYaml(moduleRoot, path.join(moduleRoot, "module.yaml"));
    assert.deepEqual(manifest.accepted_inputs, ["markdown", "pdf", "pptx"]);
    assert.equal((manifest.inbox as JsonObject).asset_access_policy !== undefined, true);
    const roles = (manifest.inbox as JsonObject).asset_roles as JsonObject;
    assert.deepEqual(roles["lecture-material"], {
      inbox_subpath: "Lectures", asset_access_policy: { sensitivity_class: 1, max_representation: "full" }, entrypoint: "normalize-lecture", allow_codex: true,
    }, "The Blueprint Inbox role must materialize its route, access policy, and entrypoint.");
    assert.deepEqual(roles["private-document"], {
      inbox_subpath: "Private", asset_access_policy: { sensitivity_class: 3, max_representation: "metadata" }, required_user_action: "resolve-review", allow_codex: false,
    }, "A no-Codex Inbox role must materialize its explicit user continuation.");
    assert.equal(((manifest.entry_workflows as JsonObject)["normalize-assignment"]), "workflows/normalize-assignment/v1.0.0.yaml");
    const validation = await validateModule(engine, moduleRoot);
    assert.notEqual(validation.overall, "FAIL", validation.checks.filter((item) => item.status === "fail").map((item) => item.message).join("\n"));
    assert.equal(validation.checks.filter((item) => item.code.startsWith("BLUEPRINT_")).every((item) => item.status === "pass"), true);
    await assert.rejects(() => scaffoldModuleFromBlueprint(engine, blueprint), /already exists/);
  } finally { await fs.rm(engine, { recursive: true, force: true }); }
});

test("Blueprint compliance rejects runtime privacy drift", async () => {
  const engine = await temporaryEngine();
  try {
    const blueprint = path.join(SOURCE_ROOT, "examples", "module-blueprints", "media-library.blueprint.yaml");
    const generated = await scaffoldModuleFromBlueprint(engine, blueprint);
    const moduleRoot = String(generated.module_root);
    const manifest = parseYaml(moduleRoot, path.join(moduleRoot, "module.yaml"));
    (manifest.permissions as JsonObject).max_sensitivity_class = 3;
    writeYaml(moduleRoot, path.join(moduleRoot, "module.yaml"), manifest);
    const report = await validateModule(engine, moduleRoot);
    assert.equal(report.overall, "FAIL");
    assert.equal(report.checks.some((item) => item.code === "BLUEPRINT_SENSITIVITY_MATCH" && item.status === "fail"), true);
  } finally { await fs.rm(engine, { recursive: true, force: true }); }
});

test("Blueprint v1.1 materializes semantic entities and rejects a mismatched Workflow Event", async () => {
  const engine = await temporaryEngine();
  try {
    const blueprint = path.join(SOURCE_ROOT, "examples", "module-blueprints", "course.blueprint.yaml");
    const generated = await scaffoldModuleFromBlueprint(engine, blueprint);
    const moduleRoot = String(generated.module_root);
      const schemas = parseYaml(moduleRoot, path.join(moduleRoot, "schemas", "index.yaml"));
      assert.equal(Boolean((schemas.schemas as JsonObject).lecture), true);
      assert.equal(Boolean((schemas.schemas as JsonObject).assignment), true);
      const qualityPolicy = parseYaml(moduleRoot, path.join(moduleRoot, "rules", "quality-policy.yaml"));
      assert.deepEqual((qualityPolicy.field_policies as JsonObject)["assignment.deadline"], {
        critical: true, provenance: "required", verification_interval_days: 7,
      }, "Blueprint provenance_required and freshness_days must materialize into a Quality Policy.");
    const lectureWorkflowPath = path.join(moduleRoot, "workflows", "normalize-lecture", "v1.0.0.yaml");
    const lectureWorkflow = parseYaml(moduleRoot, lectureWorkflowPath);
    const eventStep = (lectureWorkflow.steps as JsonObject[]).find((step) => step.uses === "core.publish-event");
    assert.equal((eventStep?.with as JsonObject).event_type, "course.lecture-created", "Events must follow the declaring Workflow, never array order.");
    const summaryWorkflowPath = path.join(moduleRoot, "workflows", "generate-weekly-summary", "v1.0.0.yaml");
    const summaryWorkflow = parseYaml(moduleRoot, summaryWorkflowPath);
    const summarySteps = summaryWorkflow.steps as JsonObject[];
    const querySteps = summarySteps.filter((step) => step.uses === "core.query-documents");
    assert.equal(querySteps.length, 2, "Scheduled Blueprint sources must materialize into real document queries.");
    assert.deepEqual(querySteps.map((step) => (step.with as JsonObject).schema), ["lecture", "assignment"]);
    assert.deepEqual(querySteps.map((step) => ((step.with as JsonObject).time_window as JsonObject).unit), ["week", "on-or-after"]);
    assert.equal(summarySteps.findIndex((step) => step.uses === "core.query-documents") < summarySteps.findIndex((step) => step.uses === "codex.prompt"), true);
      const planStep = summarySteps.find((step) => step.uses === "core.build-operation-plan");
      assert.equal((planStep?.with as JsonObject).operation_type, "create-record", "The Blueprint operation mode must reach the runtime plan builder.");
      const assignmentWorkflowPath = path.join(moduleRoot, "workflows", "normalize-assignment", "v1.0.0.yaml");
      const assignmentWorkflow = parseYaml(moduleRoot, assignmentWorkflowPath);
      const transitionStep = (assignmentWorkflow.steps as JsonObject[]).find((step) => step.uses === "component.state-transition-validation");
      assert.deepEqual((transitionStep?.with as JsonObject).lifecycle, {
        initial: "planned",
        transitions: { planned: ["submitted"], submitted: ["graded"], graded: [] },
      }, "Lifecycle Blueprints must materialize a runtime state-transition guard.");
      assert.equal((transitionStep?.with as JsonObject).proposed_from, "normalize");
      assert.equal((assignmentWorkflow.steps as JsonObject[]).findIndex((step) => step.uses === "component.state-transition-validation")
        < (assignmentWorkflow.steps as JsonObject[]).findIndex((step) => step.uses === "core.build-operation-plan"), true);
      const reviewStep = (assignmentWorkflow.steps as JsonObject[]).find((step) => step.uses === "core.require-review-if");
      assert.deepEqual((reviewStep?.with as JsonObject).rules, [{ field: "assignment.deadline", condition: "missing-or-conflicting" }]);
      assert.equal((assignmentWorkflow.steps as JsonObject[]).findIndex((step) => step.uses === "core.require-review-if")
        < (assignmentWorkflow.steps as JsonObject[]).findIndex((step) => step.uses === "core.build-operation-plan"), true);
      const valid = await validateModule(engine, moduleRoot);
    assert.notEqual(valid.overall, "FAIL", valid.checks.filter((item) => item.status === "fail").map((item) => item.message).join("\n"));

    const manifest = parseYaml(moduleRoot, path.join(moduleRoot, "module.yaml"));
    (((manifest.inbox as JsonObject).asset_roles as JsonObject)["assignment-brief"] as JsonObject).entrypoint = "normalize-lecture";
    writeYaml(moduleRoot, path.join(moduleRoot, "module.yaml"), manifest);
    const routeMismatch = await validateModule(engine, moduleRoot);
    assert.equal(routeMismatch.overall, "FAIL");
    assert.equal(routeMismatch.checks.some((item) => item.code === "V2_INBOX_ROLE_CONTRACT_BOUND" && item.status === "fail"), true);

    (((manifest.inbox as JsonObject).asset_roles as JsonObject)["assignment-brief"] as JsonObject).entrypoint = "normalize-assignment";
    writeYaml(moduleRoot, path.join(moduleRoot, "module.yaml"), manifest);

    (eventStep!.with as JsonObject).event_type = "course.assignment-created";
    writeYaml(moduleRoot, lectureWorkflowPath, lectureWorkflow);
    const invalid = await validateModule(engine, moduleRoot);
    assert.equal(invalid.overall, "FAIL");
    assert.equal(invalid.checks.some((item) => item.code === "V2_WORKFLOW_EVENTS_BOUND" && item.status === "fail"), true);

    (eventStep!.with as JsonObject).event_type = "course.lecture-created";
    const contract = lectureWorkflow.blueprint_contract as JsonObject;
    ((contract.role_policies as JsonObject)["lecture-material"] as JsonObject).allow_codex = false;
    writeYaml(moduleRoot, lectureWorkflowPath, lectureWorkflow);
    const roleMismatch = await validateModule(engine, moduleRoot);
    assert.equal(roleMismatch.overall, "FAIL");
    assert.equal(roleMismatch.checks.some((item) => item.code === "V2_WORKFLOW_ROLE_CODEX_BOUND" && item.status === "fail"), true);
  } finally { await fs.rm(engine, { recursive: true, force: true }); }
});

test("Scheduled Blueprints require an explicit source query contract", async () => {
  const blueprintPath = path.join(SOURCE_ROOT, "examples", "module-blueprints", "course.blueprint.yaml");
  const source = parseYaml(SOURCE_ROOT, blueprintPath);
  const workflows = source.workflows as JsonObject[];
  delete workflows.find((workflow) => workflow.id === "generate-weekly-summary")!.sources;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-blueprint-contract-"));
  try {
    const invalidPath = path.join(directory, "course.blueprint.yaml");
    writeYaml(directory, invalidPath, source);
    const { report } = await validateModuleBlueprint(SOURCE_ROOT, invalidPath);
    assert.equal(report.overall, "FAIL");
    assert.equal(report.checks.some((item) => item.code === "SEMANTIC_SCHEDULE_SOURCES_REQUIRED" && item.status === "fail"), true);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("Blueprint roles that deny Codex cannot be bound to an AI Workflow", async () => {
  const blueprintPath = path.join(SOURCE_ROOT, "examples", "module-blueprints", "course.blueprint.yaml");
  const source = parseYaml(SOURCE_ROOT, blueprintPath);
  const inbox = source.inbox as JsonObject;
  const roles = inbox.roles as JsonObject;
  (roles["lecture-material"] as JsonObject).allow_codex = false;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-blueprint-codex-policy-"));
  try {
    const invalidPath = path.join(directory, "course.blueprint.yaml");
    writeYaml(directory, invalidPath, source);
    const { report } = await validateModuleBlueprint(SOURCE_ROOT, invalidPath);
    assert.equal(report.overall, "FAIL");
    assert.equal(report.checks.some((item) => item.code === "SEMANTIC_ROLE_CODEX_DENIED" && item.status === "fail"), true);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("Blueprint materializes complete advanced Job trigger contracts", async () => {
  const engine = await temporaryEngine();
  try {
    const source = parseYaml(SOURCE_ROOT, path.join(SOURCE_ROOT, "examples", "module-blueprints", "course.blueprint.yaml"));
    (source.capability_packs as string[]).push("event-subscription");
    (source.events as JsonObject).subscribes = [{ event: "course.lecture-created", scope: "instance", workflow_id: "normalize-lecture" }];
    (source.testing as JsonObject).event_consumption = "required";
    (source.jobs as JsonObject[]).push(
      { id: "monthly-summary", workflow_id: "generate-weekly-summary", schedule: "monthly", day: 1, at: "19:00", timezone: "instance", scope: "instance", catch_up: "latest" },
      { id: "startup-summary", workflow_id: "generate-weekly-summary", schedule: "startup", dedupe: "daily", timezone: "instance", scope: "instance", catch_up: "latest" },
      { id: "due-assignment", workflow_id: "normalize-assignment", schedule: "field-due", source_root: "20-Workspace/Course/Records", field: "deadline", id_field: "instance_id", scope: "module", catch_up: "latest" },
      { id: "lecture-followup", workflow_id: "normalize-lecture", schedule: "event", event: "course.lecture-created", subscription_scope: "instance", scope: "instance", catch_up: "latest" },
    );
    const blueprint = path.join(engine, "course.blueprint.yaml");
    writeYaml(engine, blueprint, source);
    const generated = await scaffoldModuleFromBlueprint(engine, blueprint);
    const jobs = parseYaml(String(generated.module_root), path.join(String(generated.module_root), "jobs", "jobs.yaml")).jobs as JsonObject[];
    assert.deepEqual(jobs.find((job) => job.id === "monthly-summary")?.trigger, { type: "monthly", day: 1, at: "19:00", timezone: "instance" });
    assert.deepEqual(jobs.find((job) => job.id === "startup-summary")?.trigger, { type: "startup", dedupe: "daily", timezone: "instance" });
    assert.deepEqual(jobs.find((job) => job.id === "due-assignment")?.trigger, { type: "field-due", source_root: "20-Workspace/Course/Records", field: "deadline", id_field: "instance_id" });
    assert.deepEqual(jobs.find((job) => job.id === "lecture-followup")?.trigger, { type: "event", event: "course.lecture-created", subscription_scope: "instance" });
    const manifest = parseYaml(String(generated.module_root), path.join(String(generated.module_root), "module.yaml"));
    assert.deepEqual((manifest.events as JsonObject).subscribes, [{ event: "course.lecture-created", scope: "instance" }]);

    delete (source.jobs as JsonObject[]).find((job) => job.id === "due-assignment")!.field;
    writeYaml(engine, blueprint, source);
    const invalid = await validateModuleBlueprint(engine, blueprint);
    assert.equal(invalid.report.overall, "FAIL");
    assert.equal(invalid.report.checks.some((item) => item.code === "SEMANTIC_JOB_TRIGGER_INCOMPLETE" && item.status === "fail"), true);
  } finally { await fs.rm(engine, { recursive: true, force: true }); }
});

test("Official Course Blueprint module passes its executable Module Test contract", async () => {
  const report = await testModule(SOURCE_ROOT, "course");
  assert.equal(report.overall, "PASS", report.checks.filter((item) => item.status === "fail").map((item) => item.message).join("\n"));
  assert.equal(report.checks.find((item) => item.category === "periodic")?.status, "pass");
  assert.equal(report.checks.some((item) => item.category === "event" && item.status === "pass"), true);
  assert.equal(report.checks.find((item) => item.category === "pdf")?.status, "pass");
});

test("Module Sandbox executes fixtures in a disposable Vault", async () => {
  const report = await runModuleSandbox(SOURCE_ROOT, "reading-log");
  assert.equal(report.isolation, "temporary-vault");
  assert.equal(report.lifecycle, "created-executed-cleaned");
  assert.equal(report.overall, "PASS");
});

test("all scaffold templates generate manifests that satisfy the base contract", async () => {
  const engine = await temporaryEngine();
  try {
    for (const [id, template] of [["sample-config", "minimal-config"], ["sample-workflow", "workflow"], ["sample-integration", "integration"]] as const) {
      await createModuleScaffold(engine, id, template, id);
      const report = await validateModule(engine, path.join(engine, "modules", id));
      assert.notEqual(report.overall, "FAIL", `${template} scaffold should validate`);
    }
  } finally { await fs.rm(engine, { recursive: true, force: true }); }
});

test("validation fails before enable when a registered prompt is missing", async () => {
  const engine = await temporaryEngine();
  try {
    await createModuleScaffold(engine, "broken-reference", "minimal-config");
    await fs.rm(path.join(engine, "modules", "broken-reference", "prompts", "normalize", "v1.0.0.md"));
    const report = await validateModule(engine, path.join(engine, "modules", "broken-reference"));
    assert.equal(report.overall, "FAIL");
    assert.equal(report.checks.some((item) => item.code === "MODULE_REFERENCE_NOT_FOUND" && item.status === "fail"), true);
  } finally { await fs.rm(engine, { recursive: true, force: true }); }
});

test("Beta and Stable modules cannot declare an unavailable Ingestion Adapter", async () => {
  const engine = await temporaryEngine();
  try {
    await createModuleScaffold(engine, "unavailable-adapter", "minimal-config");
    const root = path.join(engine, "modules", "unavailable-adapter");
    const manifest = parseYaml(root, path.join(root, "module.yaml"));
    manifest.maturity = "beta";
    manifest.accepted_inputs = [...(manifest.accepted_inputs as string[]), "docx"];
    writeYaml(root, path.join(root, "module.yaml"), manifest);
    const report = await validateModule(engine, root);
    assert.equal(report.checks.some((item) => item.code === "INGESTION_ADAPTER_UNAVAILABLE" && item.status === "fail"), true);
  } finally { await fs.rm(engine, { recursive: true, force: true }); }
});

test("validation requires every declared Event Job to state its subscription scope", async () => {
  const engine = await temporaryEngine();
  try {
    await createModuleScaffold(engine, "event-scope-check", "minimal-config");
    const root = path.join(engine, "modules", "event-scope-check");
    writeYaml(root, path.join(root, "jobs", "jobs.yaml"), {
      jobs: [{ id: "consume-capture", scope: "module", enabled: true, task_type: "workflow", workflow: "event-scope-check:normalize", workflow_id: "normalize", workflow_version: "1.0.0", trigger: { type: "event", event: "capture.created" } }],
    });
    const report = await validateModule(engine, root);
    assert.equal(report.overall, "FAIL");
    assert.equal(report.checks.some((item) => item.code === "EVENT_SUBSCRIPTION_SCOPE_INVALID" && item.status === "fail"), true);
  } finally { await fs.rm(engine, { recursive: true, force: true }); }
});

test("validation restricts global Event subscriptions to an authorized, source-scoped declaration", async () => {
  const engine = await temporaryEngine();
  try {
    await createModuleScaffold(engine, "global-event-check", "minimal-config");
    const root = path.join(engine, "modules", "global-event-check");
    const manifest = parseYaml(root, path.join(root, "module.yaml"));
    manifest.capabilities = [...(manifest.capabilities as string[]), "event-subscription"];
    manifest.events = { publishes: [], subscribes: [{ event: "application.updated", scope: "global", source_modules: ["application-tracker"] }] };
    manifest.permissions = { ...(manifest.permissions as JsonObject), global_event_subscription: true };
    writeYaml(root, path.join(root, "module.yaml"), manifest);
    writeYaml(root, path.join(root, "jobs", "jobs.yaml"), {
      jobs: [{ id: "consume-application", scope: "module", enabled: true, task_type: "workflow", workflow: "global-event-check:normalize", workflow_id: "normalize", workflow_version: "1.0.0", trigger: { type: "event", event: "application.updated", subscription_scope: "global", source_modules: ["application-tracker"] } }],
    });
    const authorized = await validateModule(engine, root);
    assert.equal(authorized.checks.some((item) => item.code === "GLOBAL_EVENT_SUBSCRIPTION_DENIED" && item.status === "fail"), false);
    manifest.permissions = { ...(manifest.permissions as JsonObject), global_event_subscription: false };
    writeYaml(root, path.join(root, "module.yaml"), manifest);
    const denied = await validateModule(engine, root);
    assert.equal(denied.checks.some((item) => item.code === "GLOBAL_EVENT_SUBSCRIPTION_DENIED" && item.status === "fail"), true);
  } finally { await fs.rm(engine, { recursive: true, force: true }); }
});

test("Module SDK allows structured plans but rejects cross-boundary and red operations", () => {
  const sdk = new ModuleSdk({ vaultRoot: "C:/vault", moduleId: "reading-log", moduleVersion: "0.1.0", instanceId: "reading-2026", allowedReadRoots: ["20-Workspace/Reading Log/reading-2026"], ownedWriteRoots: ["20-Workspace/Reading Log/reading-2026"], maxSensitivityClass: 0 });
  const operation: Operation = { operation_id: "OP-001", type: "create-file", target: "20-Workspace/Reading Log/reading-2026/Notes/a.md", risk: "green", confidence: 1, idempotency_key: "reading:a", payload: { format: "text", text: "A" }, requires_review_id: null };
  const plan = sdk.buildOperationPlan({ planId: "PLAN-001", taskId: "TASK-001", summary: "Create reading note", operations: [operation] });
  assert.equal(plan.source_module, "reading-log");
  assert.equal(sdk.canRead("20-Workspace/Reading Log/reading-2026/Notes/a.md", 0), true);
  assert.equal(sdk.canRead("20-Workspace/Reading Log/reading-2026/Notes/a.md", 1), false, "Module read policy must cap non-metadata access");
  assert.throws(() => sdk.assertReadable("20-Workspace/Reading Log/reading-2026/Notes/a.md", 4), /integer from 0 to 3/);
  assert.throws(() => sdk.buildOperationPlan({ planId: "PLAN-002", taskId: "TASK-002", summary: "bad", operations: [{ ...operation, target: "20-Workspace/Applications/secret.md" }] }), /cannot propose a write/);
  assert.throws(() => sdk.buildOperationPlan({ planId: "PLAN-003", taskId: "TASK-003", summary: "bad", operations: [{ ...operation, type: "delete-file" }] }), /delete operations/);
});

test("Prompt and Workflow registries support default, pin, testing and generation trace", async () => {
  const root = path.join(SOURCE_ROOT, "modules", "reading-log");
  const manifest = parseYaml(root, path.join(root, "module.yaml"));
  const prompt = await resolveVersionedEntry({ moduleRoot: root, manifest, section: "prompts", id: "normalize-record", instancePins: { "normalize-record": "1.0.0" } });
  const workflow = await resolveVersionedEntry({ moduleRoot: root, manifest, section: "workflows", id: "normalize", testingVersions: { normalize: "1.0.0" } });
  assert.equal(prompt.source, "instance-pinned");
  assert.equal(workflow.source, "testing");
  const trace = generationTrace({ moduleId: "reading-log", moduleVersion: "0.1.0", workflow, prompt, adapter: "codex-cli", runId: "RUN-001", generatedAt: "2026-07-28T00:00:00Z" });
  assert.equal(trace.prompt_version, "1.0.0");
  assert.equal(trace.workflow_version, "1.0.0");
});

test("module test executes a fixture Capture, duplicate recovery, and lifecycle in an isolated Vault", async () => {
  const report = await testModule(SOURCE_ROOT, "reading-log");
  assert.equal(report.overall, "PASS");
  assert.equal(report.checks.find((item) => item.category === "capture")?.status, "pass");
  assert.equal(report.checks.find((item) => item.category === "idempotency")?.status, "pass");
  assert.equal(report.checks.find((item) => item.category === "lifecycle")?.status, "pass");
});

test("reading-log test instance can be created, paused, resumed and archived without losing data", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-reading-life-"));
  try {
    await initializeVault(vault, "disabled");
    const create = await invokeCommandApi({ vaultRoot: vault, requestId: "READING-CREATE", method: "createInstance", params: { module_id: "reading-log", instance_id: "reading-2026", display_name: "Reading 2026", fields: { timezone: "Asia/Shanghai" } } });
    assert.equal(create.ok, true);
    const contentFile = path.join(vault, "20-Workspace", "Reading Log", "reading-2026", "Inbox", "capture.md");
    await fs.writeFile(contentFile, "A sourced reading note", "utf8");
    const pause = await invokeCommandApi({ vaultRoot: vault, requestId: "READING-PAUSE", method: "manageInstance", params: { instance_id: "reading-2026", action: "pause" } });
    const resume = await invokeCommandApi({ vaultRoot: vault, requestId: "READING-RESUME", method: "manageInstance", params: { instance_id: "reading-2026", action: "resume" } });
    const archive = await invokeCommandApi({ vaultRoot: vault, requestId: "READING-ARCHIVE", method: "manageInstance", params: { instance_id: "reading-2026", action: "archive", confirm: true } });
    assert.equal(pause.ok, true); assert.equal(resume.ok, true); assert.equal(archive.ok, true);
    assert.equal(await fs.readFile(contentFile, "utf8"), "A sourced reading note");
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("local package install, upgrade and rollback preserve an exact module lock", async () => {
  const engine = await temporaryEngine();
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-module-vault-"));
  try {
    await initializeVault(vault, "disabled");
    const workspace = path.join(engine, "user-workspace");
    await createModuleScaffold(engine, "package-sample", "minimal-config", "package-sample", { modulesRoot: workspace });
    const root = path.join(workspace, "package-sample");
    const manifest = parseYaml(root, path.join(root, "module.yaml"));
    manifest.maturity = "beta"; manifest.status = "enabled";
    writeYaml(root, path.join(root, "module.yaml"), manifest);
    const firstPackage = path.join(engine, "package-sample-0.1.0.pkb-module");
    await assert.rejects(() => packModuleDirectory(engine, root, firstPackage), (error: unknown) => (error as { code?: string }).code === "MODULE_READINESS_STALE");
    await writeReadinessEvidence(engine, "package-sample", root);
    await packModuleDirectory(engine, root, firstPackage);
    const installed = await installModulePackage(engine, vault, firstPackage, { enable: true });
    assert.equal(installed.status, "installed");

    manifest.version = "0.2.0";
    writeYaml(root, path.join(root, "module.yaml"), manifest);
    const secondPackage = path.join(engine, "package-sample-0.2.0.pkb-module");
    await assert.rejects(() => packModuleDirectory(engine, root, secondPackage), (error: unknown) => (error as { code?: string }).code === "MODULE_READINESS_STALE");
    await writeReadinessEvidence(engine, "package-sample", root);
    await packModuleDirectory(engine, root, secondPackage);
    const upgraded = await installModulePackage(engine, vault, secondPackage, { enable: true, upgrade: true });
    assert.equal(upgraded.previous_version, "0.1.0");
    const rolledBack = await rollbackModulePackage(engine, vault, "package-sample");
    assert.equal(rolledBack.status, "rolled-back");
    const lock = await readJson<{ modules: Record<string, JsonObject> }>(path.join(vault, "90-System", "Modules", "module-lock.json"), { modules: {} });
    assert.equal(lock.modules["package-sample"]?.version, "0.1.0");
    assert.equal(typeof lock.modules["package-sample"]?.checksum, "string");
    assert.equal(String(lock.modules["package-sample"]?.installed_path).startsWith("90-System/Modules/Installed/"), true);
    await syncInstalledConfiguration(vault);
    const preserved = await readJson<{ modules: Record<string, JsonObject> }>(path.join(vault, "90-System", "Modules", "module-lock.json"), { modules: {} });
    assert.equal(preserved.modules["package-sample"]?.version, "0.1.0", "Engine sync must preserve a Vault-installed user module.");

    const unsafeRoot = path.join(workspace, "unsafe-package");
    await createModuleScaffold(engine, "unsafe-package", "minimal-config", "unsafe-package", { modulesRoot: workspace });
    const unsafeManifest = parseYaml(unsafeRoot, path.join(unsafeRoot, "module.yaml"));
    unsafeManifest.maturity = "beta"; unsafeManifest.status = "enabled";
    writeYaml(unsafeRoot, path.join(unsafeRoot, "module.yaml"), unsafeManifest);
    const unsafePackage = path.join(engine, "unsafe-package-0.1.0.pkb-module");
    await packModuleDirectory(engine, unsafeRoot, unsafePackage, { developerUnsafe: true });
    await assert.rejects(() => installModulePackage(engine, vault, unsafePackage, { enable: true }), (error: unknown) => (error as { code?: string }).code === "MODULE_READINESS_UNSAFE_PACKAGE");
    const unsafeInstalled = await installModulePackage(engine, vault, unsafePackage, { enable: true, developerUnsafe: true });
    assert.equal(unsafeInstalled.status, "installed");
  } finally {
    await fs.rm(engine, { recursive: true, force: true });
    await fs.rm(vault, { recursive: true, force: true });
  }
});
