import { promises as fs } from "node:fs";
import path from "node:path";
import { PkbError } from "../core/errors.js";
import { ensureDir, exists } from "../core/files.js";
import { writeYaml } from "../core/bridge.js";
import type { JsonObject } from "../core/types.js";
import type { ModuleTemplate } from "./types.js";

const MODULE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

async function text(file: string, content: string): Promise<void> { await ensureDir(path.dirname(file)); await fs.writeFile(file, content.endsWith("\n") ? content : `${content}\n`, "utf8"); }
async function yaml(root: string, relative: string, data: JsonObject): Promise<void> { await ensureDir(path.dirname(path.join(root, relative))); writeYaml(root, path.join(root, relative), data); }

function manifest(id: string, name: string, template: ModuleTemplate): JsonObject {
  const integration = template === "integration";
  const workflow = template === "workflow";
  const publishedEvents = workflow
    ? [`${id}.record-created`, `${id}.weekly-summary-created`]
    : integration ? [`${id}.record-created`] : [];
  return {
    id, name, version: "0.1.0", maturity: "experimental", status: "disabled",
    description: `${name} module generated from the ${template} scaffold.`,
    engine: { api_version: 1, min_version: "0.9.0-beta", max_version: "0.x" }, data: { schema_version: 1 },
    module_type: integration ? "integration" : workflow ? "workflow" : "configuration",
    capabilities: ["capture-processing", "metadata-enrichment", "dashboard-items", ...(workflow ? ["periodic-summary", "event-publishing"] : []), ...(integration ? ["event-publishing"] : [])],
    accepted_inputs: integration ? ["json", "email"] : ["markdown", "text"],
    inbox: { module_level: { enabled: true, path: `20-Workspace/${name}/Inbox` }, instance_level: { enabled: true, path_pattern: "{content_root}/Inbox" }, allow_global_routing: true },
    routing: { matcher: "workflows/classify/v1.0.0.yaml", auto_route_threshold: 0.85, review_threshold: 0.6 },
    entry_workflows: { capture: "workflows/normalize/v1.0.0.yaml" },
    schemas: { registry: "schemas/index.yaml", instance: "schemas/instance.schema.json", record: "schemas/record.schema.json" },
    prompts: { registry: "prompts/index.yaml" }, workflows: { registry: "workflows/index.yaml" },
    rules: { paths: "rules/paths.yaml", review: "rules/review-policy.yaml", permissions: "rules/permissions.yaml" },
    dashboard: { provider: "dashboard/provider.yaml" }, jobs: { registry: "jobs/jobs.yaml" },
    ...(publishedEvents.length ? { events: { publishes: publishedEvents } } : {}),
    dependencies: { components: workflow ? { "periodic-rollup": "^1.0.0" } : {} }, scheduled_jobs: [],
    permissions: { max_read_level: integration ? 1 : 0, network: integration, codex: "optional", delete: false, cross_module_write: false, max_default_read_level: integration ? 1 : 0, allow_external_network: integration, allow_delete: false, allow_bulk_move: false },
    instance_form: { content_root_pattern: `20-Workspace/${name}/{instance_id}`, inbox_path_pattern: "{content_root}/Inbox", fields: [{ key: "timezone", label: "Timezone", type: "timezone", required: true, default: "Asia/Shanghai" }] },
  };
}

export async function createModuleScaffold(engineRoot: string, id: string, template: ModuleTemplate, displayName = id): Promise<{ module_root: string; files: number }> {
  if (!MODULE_ID.test(id)) throw new PkbError("MODULE_ID_INVALID", "module_id must use lowercase kebab-case.");
  if (!["minimal-config", "workflow", "integration"].includes(template)) throw new PkbError("MODULE_TEMPLATE_INVALID", `Unknown module template ${template}.`);
  const root = path.join(engineRoot, "modules", id);
  const publishesEvents = template === "workflow" || template === "integration";
  if (await exists(root)) throw new PkbError("MODULE_EXISTS", `Module ${id} already exists.`);
  await ensureDir(root);
  await yaml(root, "module.yaml", manifest(id, displayName, template));
  await text(path.join(root, "README.md"), `# ${displayName}\n\n## User guide\n\nDescribe what the module does, how to create an instance, where input belongs, automatic behavior, reviews, pause, and archive.\n\n## Developer notes\n\nThe module owns only its instance content roots. It returns structured plans through the Module SDK and never writes files directly.`);
  await text(path.join(root, "CHANGELOG.md"), `# Changelog\n\n## 0.1.0\n\n- Initial ${template} scaffold.\n- Data schema version 1.\n- Prompt and Workflow registries version 1.0.0.`);
  await text(path.join(root, "docs", "use-case.md"), `# Use Case Brief\n\n- User need:\n- Primary inputs:\n- Primary outputs:\n- Daily journey:\n- Explicitly out of scope:\n\n## Boundary decision\n\n- Extension type: Module\n- Data owner: ${id}\n- Cross-module communication: Events only\n- Forbidden roots: all other module-owned content roots`);
  const instanceSchema = { $schema: "https://json-schema.org/draft/2020-12/schema", $id: `https://pkb.local/schemas/${id}/instance.schema.json`, type: "object", additionalProperties: true, required: ["instance_id", "module_id", "status", "display_name", "content_root", "inbox_path", "created", "updated", "timezone"], properties: { instance_id: { type: "string" }, module_id: { const: id }, status: { enum: ["planned", "active", "paused", "completed", "archived", "error"] }, display_name: { type: "string" }, content_root: { type: "string" }, inbox_path: { type: "string" }, created: { type: "string", format: "date-time" }, updated: { type: "string", format: "date-time" }, timezone: { type: "string" } } };
  const recordSchema = { $schema: "https://json-schema.org/draft/2020-12/schema", $id: `https://pkb.local/schemas/${id}/record.schema.json`, type: "object", additionalProperties: false, required: ["id", "type", "schema_id", "schema_version", "module_version", "instance_id", "title", "source_refs", "created", "updated"], properties: { id: { type: "string" }, type: { const: `${id}-record` }, schema_id: { const: "record" }, schema_version: { const: 1 }, module_version: { type: "string" }, instance_id: { type: "string" }, title: { type: "string", minLength: 1 }, source_refs: { type: "array", items: { type: "string" } }, generation: { type: ["object", "null"] }, created: { type: "string", format: "date-time" }, updated: { type: "string", format: "date-time" } } };
  await text(path.join(root, "schemas", "instance.schema.json"), JSON.stringify(instanceSchema, null, 2));
  await text(path.join(root, "schemas", "record.schema.json"), JSON.stringify(recordSchema, null, 2));
  await yaml(root, "schemas/index.yaml", { schemas: { instance: { version: 1, path: "instance.schema.json", entity_type: "instance" }, record: { version: 1, path: "record.schema.json", entity_type: `${id}-record` } } });
  const promptEntries: JsonObject = { "classify-capture": { active_version: "1.0.0", path: "classify/v1.0.0.md", versions: { "1.0.0": "classify/v1.0.0.md" }, status: "active" }, "normalize-record": { active_version: "1.0.0", path: "normalize/v1.0.0.md", versions: { "1.0.0": "normalize/v1.0.0.md" }, status: "active" } };
  if (template === "workflow") promptEntries["weekly-summary"] = { active_version: "1.0.0", path: "summarize/v1.0.0.md", versions: { "1.0.0": "summarize/v1.0.0.md" }, status: "active" };
  await yaml(root, "prompts/index.yaml", { prompts: promptEntries });
  await text(path.join(root, "prompts", "classify", "v1.0.0.md"), `---\nprompt_id: classify-capture\nprompt_version: 1.0.0\nmodule: ${id}\ntask_type: classification\noutput_schema: https://pkb.local/schemas/core/match-result.schema.json\nstatus: active\n---\n\nClassify only whether the Capture belongs to this module. Preserve uncertainty and return the declared Schema.`);
  await text(path.join(root, "prompts", "normalize", "v1.0.0.md"), `---\nprompt_id: normalize-record\nprompt_version: 1.0.0\nmodule: ${id}\ntask_type: normalization\noutput_schema: https://pkb.local/schemas/${id}/record.schema.json\nstatus: active\n---\n\nNormalize facts without invention. Keep uncertain claims uncertain, retain source references, and request Review for ambiguity.`);
  if (template === "workflow") await text(path.join(root, "prompts", "summarize", "v1.0.0.md"), `---\nprompt_id: weekly-summary\nprompt_version: 1.0.0\nmodule: ${id}\ntask_type: summarization\noutput_schema: https://pkb.local/schemas/${id}/record.schema.json\nstatus: active\n---\n\nSummarize the selected period without inventing facts and retain all source references.`);
  const workflowEntries: JsonObject = { classify: { active_version: "1.0.0", path: "classify/v1.0.0.yaml", versions: { "1.0.0": "classify/v1.0.0.yaml" } }, normalize: { active_version: "1.0.0", path: "normalize/v1.0.0.yaml", versions: { "1.0.0": "normalize/v1.0.0.yaml" } } };
  if (template === "workflow") workflowEntries["weekly-summary"] = { active_version: "1.0.0", path: "weekly-summary/v1.0.0.yaml", versions: { "1.0.0": "weekly-summary/v1.0.0.yaml" } };
  await yaml(root, "workflows/index.yaml", { workflows: workflowEntries });
  await yaml(root, "workflows/classify/v1.0.0.yaml", { workflow_id: "classify", workflow_version: "1.0.0", inputs: ["capture"], resources: { filesystem: "required", network: "not-required", codex: "required", user: "not-required" }, steps: [{ id: "classify", uses: "codex.prompt", with: { prompt_id: "classify-capture", output_schema: "https://pkb.local/schemas/core/match-result.schema.json" } }], outputs: ["match_result"] });
  const normalizeSteps: JsonObject[] = [
    { id: "validate-capture", uses: "core.validate-capture" },
    { id: "parse-capture", uses: "core.parse-structured-document" },
    { id: "normalize", uses: "codex.prompt", with: { prompt_id: "normalize-record", output_schema: `https://pkb.local/schemas/${id}/record.schema.json` } },
    { id: "plan", uses: "core.build-operation-plan", with: { output: "normalize", output_schema: "record", target: "{instance.content_root}/Records/{task.payload.item_id}.md", template: "templates/record.md", idempotency_key: `${id}:{instance.instance_id}:record:{task.payload.item_id}`, summary: "Create a normalized record" } },
  ];
  if (publishesEvents) normalizeSteps.push({ id: "publish-record-created", uses: "core.publish-event", with: { event_type: `${id}.record-created`, payload_from: "normalize" } });
  await yaml(root, "workflows/normalize/v1.0.0.yaml", {
    workflow_id: "normalize", workflow_version: "1.0.0", inputs: ["capture", "instance"], resources: { filesystem: "required", network: integrationResource(template), codex: "required", user: "not-required" },
    steps: normalizeSteps, outputs: ["operation_plan", "dashboard_items", ...(publishesEvents ? ["events"] : [])],
  });
  if (template === "workflow") await yaml(root, "workflows/weekly-summary/v1.0.0.yaml", { workflow_id: "weekly-summary", workflow_version: "1.0.0", inputs: ["instance", "period"], resources: { filesystem: "required", network: "not-required", codex: "required", user: "not-required" }, steps: [{ id: "summarize", uses: "codex.prompt", with: { prompt_id: "weekly-summary", output_schema: `https://pkb.local/schemas/${id}/record.schema.json` } }, { id: "plan", uses: "core.build-operation-plan" }, { id: "publish-weekly-summary", uses: "core.publish-event", with: { event_type: `${id}.weekly-summary-created`, payload: { summary: "weekly-summary" } } }], outputs: ["operation_plan", "events"] });
  await yaml(root, "rules/paths.yaml", { owned_roots: [`20-Workspace/${displayName}/{instance_id}`], inbox: "{content_root}/Inbox", records: "{content_root}/Records", archive: "{content_root}/Archive" });
  await yaml(root, "rules/naming.yaml", { record: "{date}-{slug}.md", duplicate_key: "{instance_id}:{source_hash}" });
  await yaml(root, "rules/linking.yaml", { cross_module_write: false, cross_module_communication: "events-only" });
  await yaml(root, "rules/reading-policy.yaml", { default_level: template === "integration" ? 1 : 0, allowed_roots: ["{content_root}"] });
  await yaml(root, "rules/review-policy.yaml", { green: ["create-new-record", "add-source-ref"], yellow: ["replace-user-field", "ambiguous-match"], red: ["delete-file", "cross-module-write", "external-side-effect"] });
  await yaml(root, "rules/permissions.yaml", { network: template === "integration", delete: false, cross_module_write: false, arbitrary_scripts: false });
  await yaml(root, "dashboard/provider.yaml", { provider_id: `${id}-dashboard`, version: "1.0.0", items: ["inbox", "waiting-review", "recent-records"] });
  await yaml(root, "jobs/jobs.yaml", { jobs: template === "workflow" ? [{ id: "weekly-summary", scope: "instance", enabled: true, task_type: "workflow", workflow: `${id}:weekly-summary`, workflow_id: "weekly-summary", workflow_version: "1.0.0", trigger: { type: "weekly", weekday: "Sun", at: "18:00", timezone: "instance" }, resources: { filesystem: "required", network: "not-required", codex: "required", user: "not-required" }, catch_up: { policy: "aggregate", max_age_days: 21 }, retry: { max_attempts: 3 }, concurrency: { policy: "forbid", key: `${id}:{instance}:weekly-summary` }, priority: "normal" }] : [] });
  await yaml(root, "migrations/index.yaml", { migrations: [] });
  await yaml(root, "fixtures/sample-instance/instance.yaml", { instance_id: "sample-instance", module_id: id, status: "active", display_name: "Sample Instance", content_root: `20-Workspace/${displayName}/sample-instance`, inbox_path: `20-Workspace/${displayName}/sample-instance/Inbox`, timezone: "Asia/Shanghai", created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z" });
  await yaml(root, "fixtures/sample-instance/capture-test.yaml", {
    capture: {
      path: "module-test-capture.md", item_id: "module-test-capture", content: "# Fixture Capture\n\nA deterministic Capture used by pkb module test.\n",
      expected_output: `20-Workspace/${displayName}/sample-instance/Records/module-test-capture.md`,
      codex_output: {
        id: `${id}-test-record`, type: `${id}-record`, schema_id: "record", schema_version: 1, module_version: "0.1.0", instance_id: "sample-instance",
        title: "Fixture Capture", source_refs: [`20-Workspace/${displayName}/sample-instance/Inbox/module-test-capture.md`], created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z",
      },
    },
  });
  for (const [folder, fixture] of [["contract", "valid-plan.yaml"], ["behavior", "normal-input.md"], ["behavior", "ambiguous-input.md"], ["behavior", "invalid-input.md"], ["behavior", "duplicate-input.md"], ["permission", "cross-module-write.yaml"], ["prompt-regression", "facts.yaml"], ["lifecycle", "pause-archive.yaml"], ["migration", "v1-idempotency.yaml"]] as const) await text(path.join(root, "tests", folder, fixture), `# ${fixture}\nexpected: pass`);
  await yaml(root, "tests/prompt-regression/facts.yaml", { invariants: ["preserve-facts", "no-invented-values", "uncertainty-preserved", "schema-valid"] });
  await yaml(root, "fixtures/sample-instance/module-test.yaml", {
    contract_version: 1,
    scenarios: {
      normal_capture: { fixture: "fixtures/sample-instance/capture-test.yaml" },
      ambiguous_capture: { fixture: "tests/behavior/ambiguous-input.md", expected: "review" },
      permission_denied: { target: `20-Workspace/${displayName}/forbidden.md` },
      repeat_execution: { enabled: true },
      paused_instance: { enabled: true },
      archived_instance: { enabled: true },
      prompt_regression: { fixture: "tests/prompt-regression/facts.yaml" },
      periodic_job: { enabled: template === "workflow", ...(template === "workflow" ? { scheduled_at: "2026-08-09T10:00:00Z" } : {}) },
      event_consumption: { enabled: template === "workflow", ...(template === "workflow" ? { event_type: `${id}.fixture-event` } : {}) },
      migration_apply: { enabled: false, rollback: false },
    },
  });
  await text(path.join(root, "templates", "record.md"), `---\ntype: ${id}-record\nschema_id: record\nschema_version: 1\n---\n\n# {{title}}`);
  return { module_root: root, files: (await (async () => { const walk = async (dir: string): Promise<number> => (await fs.readdir(dir, { withFileTypes: true })).reduce(async (sumPromise, entry) => (await sumPromise) + (entry.isDirectory() ? await walk(path.join(dir, entry.name)) : 1), Promise.resolve(0)); return walk(root); })()) };
}

function integrationResource(template: ModuleTemplate): "required" | "not-required" { return template === "integration" ? "required" : "not-required"; }
