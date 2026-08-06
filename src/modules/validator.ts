import { promises as fs } from "node:fs";
import path from "node:path";
import { parseYaml, validateSchema } from "../core/bridge.js";
import { exists, listFilesRecursive, writeJsonAtomic } from "../core/files.js";
import type { JsonObject, JsonValue } from "../core/types.js";
import type { ModuleMaturity, ModuleValidationCheck, ModuleValidationReport } from "./types.js";
import { getWorkflowStepDefinition } from "./workflowStepRegistry.js";

const MANIFEST_SCHEMA = "https://pkb.local/schemas/core/module-manifest.schema.json";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
function object(value: JsonValue | undefined): JsonObject | null { return value && typeof value === "object" && !Array.isArray(value) ? value : null; }

function legacyReadFields(value: JsonValue | undefined, trail = ""): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => legacyReadFields(item, `${trail}[${index}]`));
  return Object.entries(value as JsonObject).flatMap(([key, child]) => {
    const current = trail ? `${trail}.${key}` : key;
    return (["read_level", "content_read_level", "max_read_level", "max_default_read_level"].includes(key) ? [current] : []).concat(legacyReadFields(child, current));
  });
}

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
  const strictAccessContract = manifest.maturity === "beta" || manifest.maturity === "stable";
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
      if (strictAccessContract) {
        const legacy = legacyReadFields(workflow);
        if (legacy.length) checks.push(check("permissions", "LEGACY_READ_CONTRACT_FORBIDDEN", "fail", `${id} uses deprecated read-level fields: ${legacy.join(", ")}. Use read.representation and max_sensitivity_class.`, relative, true));
      }
      const workflowId = workflow.workflow_id ?? workflow.id;
      const workflowVersion = workflow.workflow_version ?? workflow.version;
      if (workflowId !== id || String(workflowVersion) !== version) checks.push(check("contracts", "WORKFLOW_METADATA_LEGACY", "warning", `${id} registry and file metadata should use workflow_id/workflow_version ${version}.`, relative));
      const entryWorkflows = object(manifest.entry_workflows);
      const runtimeEntry = typeof entryWorkflows?.capture === "string" && entryWorkflows.capture.replace(/^workflows\//, "") === relative.replace(/^workflows\//, "");
      for (const step of (workflow.steps as JsonObject[] | undefined) ?? []) {
        const definition = typeof step.uses === "string" ? getWorkflowStepDefinition(step.uses) : null;
        if (!definition) {
          checks.push(check("permissions", runtimeEntry ? "WORKFLOW_STEP_UNSUPPORTED" : "WORKFLOW_STEP_DOCUMENTED_ONLY", runtimeEntry ? "fail" : "warning", `${id} uses ${runtimeEntry ? "unsupported runtime" : "documented-only"} Core step ${String(step.uses)}.`, relative, runtimeEntry));
          continue;
        }
        if (definition.componentId) {
          const componentId = definition.componentId;
          const dependencies = object(object(manifest.dependencies)?.components);
          if (!dependencies || typeof dependencies[componentId] !== "string") checks.push(check("contracts", "WORKFLOW_COMPONENT_UNDECLARED", "fail", `${id} uses component ${componentId} without declaring it in dependencies.components.`, relative, true));
        }
      }
    }
  }
  checks.push(check("references", `MODULE_${section.toUpperCase()}_REGISTRY_VALID`, "pass", `${section} registry references resolve.`, registryRelative));
}

async function validateEventContracts(moduleRoot: string, manifest: JsonObject, checks: ModuleValidationCheck[]): Promise<void> {
  const events = object(manifest.events) ?? {};
  const declaredPublishes = new Set(Array.isArray(events.publishes) ? events.publishes.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : []);
  const declaredSubscriptions = (Array.isArray(events.subscribes) ? events.subscribes : []).flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [{ event: item, scope: null as "instance" | "module" | "global" | null, sourceModules: null as string[] | null }];
    const subscription = object(item as JsonValue);
    const event = typeof subscription?.event === "string" && subscription.event.trim() ? subscription.event : null;
    const scope = subscription?.scope === "instance" || subscription?.scope === "module" || subscription?.scope === "global" ? subscription.scope : null;
    const sourceModules = Array.isArray(subscription?.source_modules) ? subscription.source_modules.filter((source): source is string => typeof source === "string" && source.trim().length > 0) : null;
    return event ? [{ event, scope, sourceModules }] : [];
  });
  const declaredSubscribes = new Set(declaredSubscriptions.map((subscription) => subscription.event));
  const capabilities = new Set(Array.isArray(manifest.capabilities) ? manifest.capabilities.filter((item): item is string => typeof item === "string") : []);
  const workflows = object(loadRegistrySafe(moduleRoot, manifest, "workflows")?.workflows) ?? {};
  const published = new Map<string, string[]>();
  for (const [workflowId, raw] of Object.entries(workflows)) {
    const entry = object(raw); const workflowPath = typeof entry?.path === "string" ? entry.path : null;
    if (!workflowPath) continue;
    const file = path.join(moduleRoot, "workflows", ...workflowPath.replace(/^workflows\//, "").split("/"));
    if (!(await exists(file))) continue;
    const workflow = parseYaml(moduleRoot, file);
    const steps = Array.isArray(workflow.steps) ? workflow.steps.filter((step): step is JsonObject => Boolean(object(step as JsonValue))) : [];
    const publishesHere = steps.filter((step) => step.uses === "core.publish-event");
    const outputsEvents = Array.isArray(workflow.outputs) && workflow.outputs.includes("events");
    if (outputsEvents && publishesHere.length === 0) checks.push(check("events", "WORKFLOW_EVENTS_WITHOUT_PUBLISH_STEP", "fail", `${workflowId} declares outputs.events but has no core.publish-event step.`, workflowPath, true));
    for (const step of publishesHere) {
      const withValue = object(step.with);
      const eventType = typeof withValue?.event_type === "string" ? withValue.event_type : null;
      if (!eventType) checks.push(check("events", "EVENT_TYPE_MISSING", "fail", `${workflowId} has core.publish-event without with.event_type.`, workflowPath, true));
      else published.set(eventType, [...(published.get(eventType) ?? []), workflowId]);
    }
  }
  if (capabilities.has("event-publishing") && published.size === 0) checks.push(check("events", "EVENT_PUBLISHING_CAPABILITY_UNFULFILLED", "fail", "event-publishing requires at least one executable core.publish-event step.", "module.yaml", true));
  for (const eventType of declaredPublishes) if (!published.has(eventType)) checks.push(check("events", "DECLARED_EVENT_UNPUBLISHED", "fail", `Manifest declares ${eventType}, but no Workflow publishes it.`, "module.yaml", true));
  for (const [eventType, workflowIds] of published) if (!declaredPublishes.has(eventType)) checks.push(check("events", "UNDECLARED_EVENT_PUBLISHED", "fail", `${workflowIds.join(", ")} publishes ${eventType}, which is absent from manifest.events.publishes.`, "module.yaml", true));

  const jobsDescriptor = object(manifest.jobs);
  const eventJobs: Array<{ event: string; scope: "instance" | "module" | "global"; sourceModules: string[]; jobId: string }> = [];
  if (typeof jobsDescriptor?.registry === "string") {
    const jobsFile = path.join(moduleRoot, ...jobsDescriptor.registry.split("/"));
    if (await exists(jobsFile)) {
      const registry = parseYaml(moduleRoot, jobsFile);
      for (const raw of Array.isArray(registry.jobs) ? registry.jobs : []) {
        const job = object(raw as JsonValue); const trigger = object(job?.trigger);
        if (trigger?.type !== "event") continue;
        const eventType = trigger.event ?? trigger.event_type ?? trigger.source;
        if (typeof eventType !== "string") {
          checks.push(check("events", "EVENT_JOB_TYPE_MISSING", "fail", "An Event Job must declare trigger.event, trigger.event_type, or trigger.source.", String(jobsDescriptor.registry), true));
          continue;
        }
        const scope = trigger.subscription_scope === "instance" || trigger.subscription_scope === "module" || trigger.subscription_scope === "global"
          ? trigger.subscription_scope
          : job?.scope === "instance" ? "instance" : "module";
        const sourceModules = Array.isArray(trigger.source_modules) ? trigger.source_modules.filter((source): source is string => typeof source === "string" && source.trim().length > 0) : [];
        const jobId = typeof job?.id === "string" ? job.id : eventType;
        eventJobs.push({ event: eventType, scope, sourceModules, jobId });
      }
    }
  }
  for (const eventType of declaredSubscribes) if (!eventJobs.some((job) => job.event === eventType)) checks.push(check("events", "DECLARED_EVENT_UNSUBSCRIBED", "fail", `Manifest subscribes to ${eventType}, but no Event Job consumes it.`, "module.yaml", true));
  const canSubscribeGlobally = manifest.module_type === "integration"
    || (object(manifest.permissions)?.global_event_subscription === true);
  for (const job of eventJobs) {
    const declared = declaredSubscriptions.some((subscription) => subscription.event === job.event
      && (subscription.scope === null || subscription.scope === job.scope)
      && (job.scope !== "global" || subscription.sourceModules !== null && subscription.sourceModules.length === job.sourceModules.length && subscription.sourceModules.every((source) => job.sourceModules.includes(source))));
    if (!declared) checks.push(check("events", "EVENT_JOB_UNDECLARED", "fail", `${job.jobId} consumes ${job.event}, but manifest.events.subscribes does not declare the same subscription.`, String(jobsDescriptor?.registry ?? "module.yaml"), true));
    if (job.scope === "global") {
      if (!canSubscribeGlobally) checks.push(check("permissions", "GLOBAL_EVENT_SUBSCRIPTION_DENIED", "fail", `${job.jobId} uses global scope, which requires an integration module or permissions.global_event_subscription: true.`, String(jobsDescriptor?.registry ?? "module.yaml"), true));
      if (job.sourceModules.length === 0) checks.push(check("events", "GLOBAL_EVENT_SOURCE_REQUIRED", "fail", `${job.jobId} global scope must declare trigger.source_modules.`, String(jobsDescriptor?.registry ?? "module.yaml"), true));
    }
  }
  if (capabilities.has("event-subscription") && eventJobs.length === 0) checks.push(check("events", "EVENT_SUBSCRIPTION_CAPABILITY_UNFULFILLED", "fail", "event-subscription requires at least one declared Event Job.", "module.yaml", true));
  if (!capabilities.has("event-subscription") && eventJobs.length > 0) checks.push(check("events", "EVENT_JOB_CAPABILITY_UNDECLARED", "fail", "Event Jobs require the event-subscription capability.", "module.yaml", true));
  if (!capabilities.has("event-subscription") && declaredSubscriptions.length > 0) checks.push(check("events", "EVENT_SUBSCRIPTION_CAPABILITY_MISSING", "fail", "Manifest event subscriptions require the event-subscription capability.", "module.yaml", true));
  checks.push(check("events", "EVENT_CONTRACTS_VALID", "pass", "Event declarations, publish steps, and Event Jobs were checked.", "module.yaml"));
}

function validateInboxRoleContracts(manifest: JsonObject, checks: ModuleValidationCheck[]): void {
  const inbox = object(manifest.inbox);
  const roles = object(inbox?.asset_roles);
  if (!roles) return;
  const entrypoints = object(manifest.entry_workflows) ?? {};
  const defaultRole = typeof inbox?.default_asset_role === "string" ? inbox.default_asset_role : null;
  if (defaultRole && !roles[defaultRole]) checks.push(check("contracts", "INBOX_DEFAULT_ROLE_MISSING", "fail", `inbox.default_asset_role ${defaultRole} is not declared in inbox.asset_roles.`, "module.yaml", true));
  const folders = new Set<string>();
  for (const [id, raw] of Object.entries(roles)) {
    const role = object(raw);
    const folder = typeof role?.inbox_subpath === "string" ? role.inbox_subpath.toLocaleLowerCase() : "";
    if (folder && folders.has(folder)) checks.push(check("contracts", "INBOX_ROLE_FOLDER_DUPLICATE", "fail", `Inbox role ${id} reuses the subfolder ${role?.inbox_subpath}.`, "module.yaml", true));
    if (folder) folders.add(folder);
    const entrypoint = typeof role?.entrypoint === "string" ? role.entrypoint : null;
    if (entrypoint && typeof entrypoints[entrypoint] !== "string") checks.push(check("contracts", "INBOX_ROLE_ENTRYPOINT_MISSING", "fail", `Inbox role ${id} references undeclared entrypoint ${entrypoint}.`, "module.yaml", true));
    if (!entrypoint && role?.required_user_action !== "resolve-review") checks.push(check("contracts", "INBOX_ROLE_ACTION_REQUIRED", "fail", `Inbox role ${id} has no automatic entrypoint and must declare required_user_action: resolve-review.`, "module.yaml", true));
  }
  checks.push(check("contracts", "INBOX_ROLE_CONTRACTS_VALID", "pass", "Inbox asset roles and their entrypoints were checked.", "module.yaml"));
}

function enabledScenario(scenarios: JsonObject, name: string): boolean {
  const scenario = object(scenarios[name]);
  return Boolean(scenario && scenario.enabled !== false);
}

function acceptedInputFormats(manifest: JsonObject): Set<string> {
  return new Set(Array.isArray(manifest.accepted_inputs) ? manifest.accepted_inputs.filter((value): value is string => typeof value === "string") : []);
}

async function validateExecutableFixtureContract(moduleRoot: string, maturity: ModuleMaturity, manifest: JsonObject, checks: ModuleValidationCheck[]): Promise<void> {
  if (maturity !== "beta" && maturity !== "stable") return;
  const contractPath = path.join(moduleRoot, "fixtures", "sample-instance", "module-test.yaml");
  if (!(await exists(contractPath))) {
    checks.push(check("behavior", "MODULE_TEST_CONTRACT_MISSING", "fail", "Beta modules require fixtures/sample-instance/module-test.yaml.", "fixtures/sample-instance/module-test.yaml", true));
    return;
  }
  let scenarios: JsonObject = {};
  try { scenarios = object(parseYaml(moduleRoot, contractPath).scenarios) ?? {}; }
  catch (error) { checks.push(check("behavior", "MODULE_TEST_CONTRACT_INVALID", "fail", error instanceof Error ? error.message : String(error), "fixtures/sample-instance/module-test.yaml", true)); return; }
  const required = ["normal_capture", "ambiguous_capture", "permission_denied", "resource_unavailable", "repeat_execution", "paused_instance", "archived_instance", "prompt_regression"];
  const missing = required.filter((name) => !object(scenarios[name]));
  checks.push(check("behavior", missing.length ? "MODULE_TEST_SCENARIOS_MISSING" : "MODULE_TEST_SCENARIOS_VALID", missing.length ? "fail" : "pass", missing.length ? `Missing executable fixture scenarios: ${missing.join(", ")}.` : "Executable fixture contract declares all required scenarios.", "fixtures/sample-instance/module-test.yaml", missing.length > 0));
  const capabilities = new Set(Array.isArray(manifest.capabilities) ? manifest.capabilities.filter((value): value is string => typeof value === "string") : []);
  const formats = acceptedInputFormats(manifest);
  const pdfPolicy = object(manifest.pdf_policy);
  const requiredEnabled: string[] = [];
  if (capabilities.has("periodic-summary")) requiredEnabled.push("periodic_job");
  if (capabilities.has("event-publishing")) requiredEnabled.push("event_publication");
  if (capabilities.has("event-subscription")) requiredEnabled.push("event_consumption");
  if (capabilities.has("review-items")) requiredEnabled.push("ambiguous_capture");
  if (formats.has("pdf")) requiredEnabled.push("pdf_policy");
  if (pdfPolicy?.partial_policy === "allow") requiredEnabled.push("partial_pdf_execution");
  const disabled = requiredEnabled.filter((name) => !enabledScenario(scenarios, name));
  checks.push(check("behavior", disabled.length ? "MODULE_TEST_REQUIRED_SCENARIO_DISABLED" : "MODULE_TEST_CAPABILITY_SCENARIOS_ENABLED", disabled.length ? "fail" : "pass", disabled.length ? `Declared capabilities require enabled executable scenarios: ${disabled.join(", ")}.` : "Every declared dynamic capability has an enabled executable fixture scenario.", "fixtures/sample-instance/module-test.yaml", disabled.length > 0));
  const prompt = object(scenarios.prompt_regression);
  const fixture = typeof prompt?.fixture === "string" ? path.join(moduleRoot, ...prompt.fixture.split("/")) : null;
  let invariants: string[] = [];
  try { const parsed = fixture ? parseYaml(moduleRoot, fixture) : {}; invariants = Array.isArray(parsed.invariants) ? parsed.invariants.filter((item): item is string => typeof item === "string") : []; }
  catch { /* reported by the missing-invariants check below */ }
  const missingInvariants = ["preserve-facts", "uncertainty-preserved", "schema-valid"].filter((name) => !invariants.includes(name));
  if (!invariants.includes("no-invented-values") && !invariants.includes("no-invented-completion")) missingInvariants.push("no-invented-values or no-invented-completion");
  checks.push(check("prompt-regression", missingInvariants.length ? "DETERMINISTIC_PROMPT_CONTRACT_INVARIANTS_MISSING" : "DETERMINISTIC_PROMPT_CONTRACT_INVARIANTS_VALID", missingInvariants.length ? "fail" : "pass", missingInvariants.length ? `Deterministic Prompt Contract fixture is missing: ${missingInvariants.join(", ")}.` : "Deterministic Prompt Contract fixture protects facts, uncertainty, and schema validity; it is not a real-model evaluation.", prompt?.fixture as string ?? "fixtures/sample-instance/module-test.yaml", missingInvariants.length > 0));
  const migrationIndex = path.join(moduleRoot, "migrations", "index.yaml");
  if (await exists(migrationIndex)) {
    const migrations = object(parseYaml(moduleRoot, migrationIndex).migrations) ?? {};
    if (Object.keys(migrations).length) {
      const migration = object(scenarios.migration_apply);
      const migrationReady = migration?.enabled === true && migration.rollback === true;
      checks.push(check("migration", migrationReady ? "MIGRATION_FIXTURE_DECLARED" : "MIGRATION_FIXTURE_MISSING", migrationReady ? "pass" : "fail", migrationReady ? "Migration fixture declares apply, repeat, and rollback coverage." : "Module migrations require an enabled migration_apply fixture with rollback enabled.", "fixtures/sample-instance/module-test.yaml", !migrationReady));
    }
  }
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
  validateInboxRoleContracts(manifest, checks);
  if (maturity === "beta" || maturity === "stable") {
    const legacy = legacyReadFields(object(manifest.permissions) ?? {});
    if (legacy.length) checks.push(check("permissions", "LEGACY_READ_CONTRACT_FORBIDDEN", "fail", `Beta/Stable modules cannot declare deprecated read-level fields: ${legacy.join(", ")}. Use max_sensitivity_class.`, "module.yaml", true));
  }
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
  await validateEventContracts(moduleRoot, manifest, checks);

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
      const trigger = object(job.trigger);
      if (trigger?.type === "event") {
        const subscriptionScope = trigger.subscription_scope;
        const validScope = subscriptionScope === "instance" || subscriptionScope === "module" || subscriptionScope === "global";
        if (!validScope) checks.push(check("events", "EVENT_SUBSCRIPTION_SCOPE_INVALID", "fail", `Event Job ${String(job.id)} must explicitly declare trigger.subscription_scope as instance, module, or global.`, String(jobs.registry), true));
        if (subscriptionScope === "instance" && job.scope !== "instance") checks.push(check("events", "EVENT_INSTANCE_SCOPE_JOB_INVALID", "fail", `Event Job ${String(job.id)} uses instance subscription_scope but is not an instance Job.`, String(jobs.registry), true));
        if (subscriptionScope === "module" && job.scope === "instance") checks.push(check("events", "EVENT_MODULE_SCOPE_JOB_INVALID", "fail", `Event Job ${String(job.id)} uses module subscription_scope and must not target an instance.`, String(jobs.registry), true));
      }
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
  await validateExecutableFixtureContract(moduleRoot, maturity, manifest, checks);
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
