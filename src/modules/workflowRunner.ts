import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMarkdown, parseYaml, validateSchema } from "../core/bridge.js";
import { PkbError } from "../core/errors.js";
import { exists, fromVaultPath, listFilesRecursive, readJson, toVaultPath, writeJsonAtomic } from "../core/files.js";
import { createGitSnapshot } from "../core/git.js";
import { allocateId } from "../core/ids.js";
import { executeOperationPlan } from "../core/operationExecutor.js";
import type { JsonObject, JsonValue, OperationPlan } from "../core/types.js";
import { discoverInstances, discoverModulesForVault } from "../core/discovery.js";
import { runManagedCodexStep } from "../runtime/codexAdapter.js";
import { executeCodexJson, resolveCodexModel, resolveCodexReasoningEffort } from "../runtime/codexCli.js";
import type { RuntimeHandler, WorkerResult } from "../runtime/worker.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SUPPORTED_STEP_USES = new Set([
  "core.validate-capture",
  "core.parse-structured-document",
  "core.find-by-fields",
  "codex.prompt",
  "core.build-operation-plan",
]);

type CodexJsonExecutor = typeof executeCodexJson;

interface WorkflowStep extends JsonObject {
  id: string;
  uses: string;
  with: JsonObject;
}

interface ResolvedWorkflow {
  moduleRoot: string;
  manifest: JsonObject;
  instance: JsonObject;
  workflow: JsonObject;
  workflowId: string;
  workflowVersion: string;
}

interface DocumentInput extends JsonObject {
  path: string;
  data: JsonObject;
  content: string;
}

interface WorkflowState {
  resolved: ResolvedWorkflow;
  schedule: JsonObject;
  values: Map<string, JsonValue>;
  sourceFiles: Set<string>;
  outputFiles: Set<string>;
  planId: string | null;
  snapshot: string | null;
  codexCalls: number;
}

function object(value: unknown, code = "MODULE_WORKFLOW_INVALID"): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PkbError(code, "Workflow data must be an object.");
  return value as JsonObject;
}

function string(value: unknown, label: string, code = "MODULE_WORKFLOW_INVALID"): string {
  if (typeof value !== "string" || !value.trim()) throw new PkbError(code, `${label} is required.`);
  return value.trim();
}

function relative(value: string, label: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").includes("..") || path.isAbsolute(normalized)) throw new PkbError("MODULE_WORKFLOW_PATH_INVALID", `${label} must be a Vault- or module-relative path.`);
  return normalized;
}

function registry(moduleRoot: string, manifest: JsonObject, key: "schemas" | "prompts" | "workflows"): JsonObject {
  const descriptor = object(manifest[key]);
  const registryPath = relative(string(descriptor.registry, `${key}.registry`), `${key}.registry`);
  const parsed = parseYaml(ENGINE_ROOT, path.join(moduleRoot, ...registryPath.split("/")));
  return object(parsed[key]);
}

function findWorkflowEntry(task: Parameters<RuntimeHandler>[0]["task"], manifest: JsonObject, workflows: JsonObject): JsonObject {
  const triggerId = typeof task.trigger.workflow_id === "string" ? task.trigger.workflow_id : null;
  if (triggerId && workflows[triggerId]) return object(workflows[triggerId]);
  const marker = `module:${task.module}:`;
  if (task.workflow.startsWith(marker)) {
    const entrypoint = task.workflow.slice(marker.length);
    const declared = object(manifest.entry_workflows)[entrypoint];
    if (typeof declared === "string") return { path: declared };
  }
  const suffix = task.workflow.startsWith(`${task.module}:`) ? task.workflow.slice(task.module.length + 1) : task.workflow;
  if (workflows[suffix]) return object(workflows[suffix]);
  throw new PkbError("MODULE_WORKFLOW_UNREGISTERED", `Task ${task.workflow} does not reference a registered workflow for ${task.module}.`);
}

async function resolveWorkflow(task: Parameters<RuntimeHandler>[0]["task"], vaultRoot: string): Promise<ResolvedWorkflow> {
  if (!task.instance_id) throw new PkbError("MODULE_WORKFLOW_INSTANCE_REQUIRED", `Module workflow ${task.workflow} requires an instance.`);
  const module = (await discoverModulesForVault(ENGINE_ROOT, vaultRoot)).find((candidate) => candidate.data.id === task.module && candidate.data.status === "enabled");
  if (!module) throw new PkbError("MODULE_WORKFLOW_MODULE_UNAVAILABLE", `Enabled module ${task.module} was not found.`);
  const instance = (await discoverInstances(vaultRoot)).find((candidate) => candidate.data.instance_id === task.instance_id && candidate.data.module_id === task.module);
  if (!instance) throw new PkbError("MODULE_WORKFLOW_INSTANCE_UNAVAILABLE", `Active ${task.module} instance ${task.instance_id} was not found.`);
  const moduleRoot = path.dirname(module.path);
  const workflows = registry(moduleRoot, module.data, "workflows");
  const entry = findWorkflowEntry(task, module.data, workflows);
  const workflowPath = relative(string(entry.path, "workflow.path"), "workflow.path");
  const workflow = parseYaml(ENGINE_ROOT, workflowPath.startsWith("workflows/")
    ? path.join(moduleRoot, ...workflowPath.split("/"))
    : path.join(moduleRoot, "workflows", ...workflowPath.split("/")));
  const workflowId = string(workflow.workflow_id ?? workflow.id, "workflow_id");
  const workflowVersion = string(workflow.workflow_version ?? workflow.version, "workflow_version");
  // A module entrypoint is an alias selected by Core (for example `capture`),
  // rather than the immutable workflow ID/version itself. Resolve and record
  // the concrete registry version instead of treating the alias as a contract.
  const entrypointAlias = task.workflow.startsWith(`module:${task.module}:`);
  const expectedId = !entrypointAlias && typeof task.trigger.workflow_id === "string" ? task.trigger.workflow_id : workflowId;
  const expectedVersion = !entrypointAlias && typeof task.trigger.workflow_version === "string" ? task.trigger.workflow_version : workflowVersion;
  if (workflowId !== expectedId || workflowVersion !== expectedVersion) throw new PkbError("MODULE_WORKFLOW_VERSION_MISMATCH", `Workflow ${workflowId}@${workflowVersion} does not match Task contract ${expectedId}@${expectedVersion}.`);
  return { moduleRoot, manifest: module.data, instance: instance.data, workflow, workflowId, workflowVersion };
}

function dateParts(instant: string, timezone: string): { year: number; month: number; day: number } {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}

function isoWeek(parts: { year: number; month: number; day: number }): { iso_week: string; period_start: string; period_end: string; date: string } {
  const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const weekday = (utc.getUTCDay() + 6) % 7;
  const monday = new Date(utc); monday.setUTCDate(utc.getUTCDate() - weekday);
  const thursday = new Date(monday); thursday.setUTCDate(monday.getUTCDate() + 3);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((thursday.getTime() - yearStart.getTime()) / 86_400_000 - 3 + ((yearStart.getUTCDay() + 6) % 7)) / 7);
  const format = (value: Date) => value.toISOString().slice(0, 10);
  const sunday = new Date(monday); sunday.setUTCDate(monday.getUTCDate() + 6);
  return { iso_week: `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`, period_start: format(monday), period_end: format(sunday), date: format(utc) };
}

function scheduleFor(task: Parameters<RuntimeHandler>[0]["task"], instance: JsonObject): JsonObject {
  const timezone = typeof instance.timezone === "string" ? instance.timezone : "Asia/Shanghai";
  return { timezone, ...isoWeek(dateParts(task.scheduled_for, timezone)), window: task.payload.window ?? task.trigger.window ?? null };
}

function lookup(root: JsonValue | undefined, dotted: string): JsonValue | undefined {
  let current = root;
  for (const part of dotted.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as JsonObject)[part];
  }
  return current;
}

function interpolate(template: string, state: WorkflowState, task: Parameters<RuntimeHandler>[0]["task"]): string {
  return template.replace(/\{([^}]+)\}/g, (_match, key) => {
    const value = key.startsWith("instance.") ? lookup(state.resolved.instance, key.slice("instance.".length))
      : key.startsWith("schedule.") ? lookup(state.schedule, key.slice("schedule.".length))
        : key.startsWith("task.payload.") ? lookup(task.payload, key.slice("task.payload.".length))
          : key === "instance_id" ? task.instance_id : undefined;
    if (typeof value !== "string" && typeof value !== "number") throw new PkbError("MODULE_WORKFLOW_TEMPLATE_VALUE_MISSING", `No template value is available for {${key}}.`);
    return String(value);
  });
}

function schemaId(moduleRoot: string, manifest: JsonObject, value: string): string {
  if (/^https:\/\//.test(value)) return value;
  const schemas = registry(moduleRoot, manifest, "schemas");
  const entry = schemas[value] ? object(schemas[value]) : Object.values(schemas)
    .map((raw) => object(raw))
    .find((candidate) => `schemas/${String(candidate.path)}` === value || String(candidate.path) === value);
  if (!entry) throw new PkbError("MODULE_WORKFLOW_SCHEMA_UNREGISTERED", `Schema ${value} is not registered.`);
  const file = path.join(moduleRoot, "schemas", ...relative(string(entry.path, "schema.path"), "schema.path").split("/"));
  try { return string(JSON.parse(requireText(file)).$id, "schema.$id"); }
  catch { throw new PkbError("MODULE_WORKFLOW_SCHEMA_INVALID", `Unable to read schema ${value}.`); }
}

function requireText(file: string): string {
  // This helper is intentionally synchronous only for small immutable module assets.
  return readFileSync(file, "utf8");
}

async function sourceDocument(vaultRoot: string, state: WorkflowState, task: Parameters<RuntimeHandler>[0]["task"]): Promise<DocumentInput> {
  const source = typeof task.payload.source_file === "string" ? task.payload.source_file : typeof task.payload.capture_path === "string" ? task.payload.capture_path : null;
  if (!source) throw new PkbError("MODULE_WORKFLOW_SOURCE_REQUIRED", "The workflow needs payload.source_file or payload.capture_path.");
  const normalized = relative(source, "source_file");
  const contentRoot = String(state.resolved.instance.content_root ?? "");
  if (!normalized.startsWith(`${contentRoot}/`)) throw new PkbError("MODULE_READ_DENIED", `Workflow cannot read ${normalized}.`);
  const document = parseMarkdown(vaultRoot, fromVaultPath(vaultRoot, normalized));
  state.sourceFiles.add(normalized);
  return { path: normalized, data: document.data, content: document.content };
}

async function collectDocuments(vaultRoot: string, state: WorkflowState, task: Parameters<RuntimeHandler>[0]["task"], settings: JsonObject): Promise<DocumentInput[]> {
  const root = relative(interpolate(string(settings.root, "find-by-fields.root"), state, task), "find-by-fields.root");
  const contentRoot = String(state.resolved.instance.content_root ?? "");
  if (!root.startsWith(contentRoot)) throw new PkbError("MODULE_READ_DENIED", `Workflow cannot scan ${root}.`);
  const output: DocumentInput[] = [];
  for (const file of await listFilesRecursive(fromVaultPath(vaultRoot, root), ".md")) {
    const relativePath = toVaultPath(vaultRoot, file);
    const parsed = parseMarkdown(vaultRoot, file);
    if (parsed.data.instance_id !== task.instance_id) continue;
    const dateValue = typeof parsed.data.date === "string" ? parsed.data.date : typeof parsed.data.occurred_at === "string" ? parsed.data.occurred_at.slice(0, 10) : null;
    if (dateValue && (dateValue < String(state.schedule.period_start) || dateValue > String(state.schedule.period_end))) continue;
    output.push({ path: relativePath, data: parsed.data, content: parsed.content });
    state.sourceFiles.add(relativePath);
  }
  return output;
}

function documentBody(template: string, data: JsonObject): string {
  const body = template.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  return body.replace(/\{\{([^}]+)\}\}/g, (_match, key) => String(lookup(data, key.trim()) ?? ""));
}

function promptEntry(moduleRoot: string, manifest: JsonObject, id: string): { id: string; version: string; file: string; schema: string } {
  const prompts = registry(moduleRoot, manifest, "prompts");
  const entry = object(prompts[id], "MODULE_WORKFLOW_PROMPT_UNREGISTERED");
  const version = string(entry.active_version, "prompt.active_version");
  const file = path.join(moduleRoot, "prompts", ...relative(string(entry.path, "prompt.path"), "prompt.path").split("/"));
  const raw = requireText(file);
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const metadata = frontmatter ? parseMarkdown(ENGINE_ROOT, file).data : {};
  return { id, version, file, schema: string(metadata.output_schema, "prompt.output_schema") };
}

function generation(task: Parameters<RuntimeHandler>[0]["task"], runId: string, state: WorkflowState, prompt: { id: string; version: string }, model: string, reasoningEffort: string): JsonObject {
  return {
    run_id: runId,
    module: { id: task.module, version: String(state.resolved.manifest.version ?? "unknown") },
    workflow: { id: state.resolved.workflowId, version: state.resolved.workflowVersion },
    prompt: { id: prompt.id, version: prompt.version },
    adapter: "codex-cli", model, reasoning_effort: reasoningEffort, generated_at: new Date().toISOString(),
  };
}

export function createModuleWorkflowRunner(executeJson: CodexJsonExecutor = executeCodexJson): RuntimeHandler {
  return async ({ vaultRoot, task, runId, checkpoint }): Promise<WorkerResult> => {
    const resolved = await resolveWorkflow(task, vaultRoot);
    const state: WorkflowState = {
      resolved, schedule: scheduleFor(task, resolved.instance), values: new Map([["instance", resolved.instance], ["schedule", {}]]),
      sourceFiles: new Set(), outputFiles: new Set(), planId: null, snapshot: null, codexCalls: 0,
    };
    state.values.set("schedule", state.schedule);
    const steps = (resolved.workflow.steps as unknown[] ?? []).map((raw) => {
      const step = object(raw); return { id: string(step.id, "step.id"), uses: string(step.uses, "step.uses"), with: (step.with && typeof step.with === "object" && !Array.isArray(step.with) ? step.with : {}) as JsonObject } satisfies WorkflowStep;
    });
    if (!steps.length) throw new PkbError("MODULE_WORKFLOW_EMPTY", `${resolved.workflowId} has no steps.`);
    for (const step of steps) {
      checkpoint();
      if (!SUPPORTED_STEP_USES.has(step.uses)) throw new PkbError("WORKFLOW_STEP_UNSUPPORTED", `${resolved.workflowId} uses unsupported step ${step.uses}.`);
      if (step.uses === "core.validate-capture") {
        const capture = await sourceDocument(vaultRoot, state, task);
        // A Capture can come from Quick Capture (typed frontmatter) or a user
        // dropping a plain Markdown note into an instance Inbox. The runner
        // validates that it is material, while the module Prompt classifies it.
        if (!capture.content.trim() && !Object.keys(capture.data).length) throw new PkbError("MODULE_WORKFLOW_CAPTURE_INVALID", `${capture.path} is empty.`);
        state.values.set(step.id, capture);
      } else if (step.uses === "core.parse-structured-document") {
        const parsed = await sourceDocument(vaultRoot, state, task);
        if (typeof step.with.output_schema === "string") validateSchema(vaultRoot, schemaId(resolved.moduleRoot, resolved.manifest, step.with.output_schema), parsed.data);
        state.values.set(step.id, parsed);
      } else if (step.uses === "core.find-by-fields") {
        state.values.set(step.id, await collectDocuments(vaultRoot, state, task, step.with));
      } else if (step.uses === "codex.prompt") {
        const prompt = promptEntry(resolved.moduleRoot, resolved.manifest, string(step.with.prompt_id, "codex.prompt.prompt_id"));
        const outputSchema = typeof step.with.output_schema === "string" ? schemaId(resolved.moduleRoot, resolved.manifest, step.with.output_schema) : prompt.schema;
        const model = resolveCodexModel(typeof task.payload.codex_model === "string" ? task.payload.codex_model : undefined);
        const reasoningEffort = resolveCodexReasoningEffort(typeof task.payload.codex_reasoning_effort === "string" ? task.payload.codex_reasoning_effort : undefined);
        const inputs = Object.fromEntries([...state.values.entries()].filter(([key]) => key !== "schedule"));
        const managed = await runManagedCodexStep(vaultRoot, {
          task_id: task.task_id, run_id: runId, prompt_id: prompt.id, prompt_version: prompt.version, adapter: "codex-cli", model, reasoning_effort: reasoningEffort,
          output_schema: outputSchema, module: task.module, instance_id: task.instance_id, workflow_id: resolved.workflowId, workflow_version: resolved.workflowVersion,
        }, async ({ repair_format }) => {
          const promptText = await fs.readFile(prompt.file, "utf8");
          const request = `${promptText}\n\n# Runtime context\n\n${JSON.stringify({ instance: resolved.instance, schedule: state.schedule, inputs, source_files: [...state.sourceFiles] }, null, 2)}\n${repair_format ? "\nReturn only repaired JSON that conforms to the declared schema." : ""}`;
          const result = await executeJson({ vaultRoot, prompt: request, model, reasoningEffort });
          return { output: { ...object(result.output, "CODEX_OUTPUT_INVALID"), generation: generation(task, runId, state, prompt, model, reasoningEffort) } };
        }, (output) => {
          try { validateSchema(vaultRoot, outputSchema, output); return true; } catch { return false; }
        });
        state.values.set(step.id, managed.output);
        state.codexCalls += 1;
      } else if (step.uses === "core.build-operation-plan") {
        const outputKey = typeof step.with.output === "string" ? step.with.output : steps.slice(0, steps.indexOf(step)).reverse().find((candidate) => candidate.uses === "codex.prompt")?.id;
        const output = outputKey ? object(state.values.get(outputKey), "MODULE_WORKFLOW_OUTPUT_MISSING") : null;
        if (!output) throw new PkbError("MODULE_WORKFLOW_OUTPUT_MISSING", `${resolved.workflowId} has no structured output for build-operation-plan.`);
        const outputSchema = schemaId(resolved.moduleRoot, resolved.manifest, string(step.with.output_schema, "build-operation-plan.output_schema"));
        validateSchema(vaultRoot, outputSchema, output);
        const target = relative(interpolate(string(step.with.target, "build-operation-plan.target"), state, task), "build-operation-plan.target");
        const contentRoot = String(resolved.instance.content_root ?? "");
        if (!target.startsWith(`${contentRoot}/`)) throw new PkbError("MODULE_WRITE_DENIED", `Workflow cannot write ${target}.`);
        const idempotencyKey = interpolate(string(step.with.idempotency_key, "build-operation-plan.idempotency_key"), state, task);
        if (await exists(fromVaultPath(vaultRoot, target))) {
          // A process can exit after the transactional write succeeds but before
          // its Task is marked complete. Reuse the durable operation ledger in
          // that narrow recovery window; unrelated user files are never replaced.
          const ledger = await readJson<{ completed?: Record<string, { plan_id?: string }> }>(path.join(vaultRoot, "90-System", "State", "idempotency.json"), {});
          const completed = ledger.completed?.[idempotencyKey];
          if (!completed?.plan_id) throw new PkbError("MODULE_WORKFLOW_OUTPUT_EXISTS", `Workflow will not overwrite existing output ${target}.`);
          state.planId = completed.plan_id;
          state.outputFiles.add(target);
          state.values.set(step.id, { plan_id: completed.plan_id, recovered: true });
          continue;
        }
        const templatePath = path.join(resolved.moduleRoot, ...relative(string(step.with.template, "build-operation-plan.template"), "build-operation-plan.template").split("/"));
        const planId = await allocateId(vaultRoot, "PLAN");
        const plan: OperationPlan = {
          plan_id: planId, task_id: task.task_id, source_module: task.module, instance_id: task.instance_id,
          summary: typeof step.with.summary === "string" ? interpolate(step.with.summary, state, task) : `Run ${resolved.workflowId}`,
          operations: [{
            operation_id: "OP-001", type: "create-file", target, risk: "green", confidence: 1,
            idempotency_key: idempotencyKey, requires_review_id: null,
            payload: { document: { data: output, content: documentBody(await fs.readFile(templatePath, "utf8"), output) }, schema_id: outputSchema },
          }], review_items: [],
        };
        await writeJsonAtomic(path.join(vaultRoot, "90-System", "State", "Plans", `${planId}.json`), plan);
        const snapshot = await createGitSnapshot(vaultRoot, runId);
        await executeOperationPlan(vaultRoot, plan, { allowedTypes: ["create-file"], allowedTargets: [target], requiredReviewId: null, gitSnapshot: snapshot });
        state.planId = planId; state.snapshot = snapshot; state.outputFiles.add(target); state.values.set(step.id, plan);
      }
    }
    return {
      completion_reason: `module-workflow:${resolved.workflowId}`,
      operation_plan_id: state.planId, git_snapshot_id: state.snapshot,
      input_files: [...state.sourceFiles], output_files: [...state.outputFiles],
      metrics: { module_workflow: resolved.workflowId, module_workflow_version: resolved.workflowVersion, steps_executed: steps.length, codex_calls: state.codexCalls, files_read: state.sourceFiles.size, files_written: state.outputFiles.size },
    };
  };
}

export const runModuleWorkflow = createModuleWorkflowRunner();
