import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseYaml } from "../core/bridge.js";
import { PkbError } from "../core/errors.js";
import { exists, listFilesRecursive, toVaultPath, writeJsonAtomic } from "../core/files.js";
import type { JsonObject } from "../core/types.js";
import { executeCodexJson } from "../runtime/codexCli.js";
import { testModule } from "./testRunner.js";
import type { ModuleTestReport, ModuleValidationReport } from "./types.js";
import { validateModule } from "./validator.js";

const MODULE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_FILES_PER_ATTEMPT = 40;
const MAX_FILE_BYTES = 256_000;
const MAX_TOTAL_BYTES = 1_000_000;
const MAX_AUTO_FIXES = 2;

export interface ModuleImplementationChange extends JsonObject {
  path: string;
  content: string;
}

export interface ModuleImplementationReport extends JsonObject {
  report_version: 1;
  module_id: string;
  workspace_path: string;
  generated_at: string;
  overall: "PASS" | "FAIL";
  attempts: JsonObject[];
  max_auto_fixes: number;
  validation: ModuleValidationReport | null;
  test: ModuleTestReport | null;
}

export interface ModuleImplementationOptions {
  codexModel?: string;
  codexReasoningEffort?: string;
  execute?: typeof executeCodexJson;
}

function workspaceRoot(vaultRoot: string, moduleId: string): string {
  return path.join(vaultRoot, "90-System", "Module Development", moduleId);
}

export function moduleImplementationReportPath(vaultRoot: string, moduleId: string): string {
  return path.join(vaultRoot, "90-System", "State", "Module Builder", moduleId, "implementation-report.json");
}

/** Only declarative module artifacts may be authored by the Implementation model. */
export function isAllowedImplementationPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..") || path.posix.isAbsolute(normalized)) return false;
  return /^(?:schemas\/(?:index\.yaml|[A-Za-z0-9][A-Za-z0-9._-]*\.schema\.json)|prompts\/[A-Za-z0-9][A-Za-z0-9_./-]*\.md|prompts\/index\.yaml|workflows\/[A-Za-z0-9][A-Za-z0-9_./-]*\.ya?ml|workflows\/index\.yaml|rules\/[A-Za-z0-9][A-Za-z0-9_./-]*\.ya?ml|templates\/[A-Za-z0-9][A-Za-z0-9_./-]*\.md|fixtures\/[A-Za-z0-9][A-Za-z0-9_./-]*\.(?:md|txt|json|ya?ml))$/.test(normalized);
}

function normalizeChanges(raw: unknown): ModuleImplementationChange[] {
  const result = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  const files = Array.isArray(result?.files) ? result.files : null;
  if (!files) throw new PkbError("MODULE_IMPLEMENTATION_INVALID_OUTPUT", "Implementation must return a files array.");
  if (!files.length || files.length > MAX_FILES_PER_ATTEMPT) throw new PkbError("MODULE_IMPLEMENTATION_FILE_LIMIT", `Implementation must propose between 1 and ${MAX_FILES_PER_ATTEMPT} files.`);
  const seen = new Set<string>();
  let totalBytes = 0;
  return files.map((rawChange) => {
    const change = rawChange && typeof rawChange === "object" && !Array.isArray(rawChange) ? rawChange as Record<string, unknown> : null;
    const filePath = typeof change?.path === "string" ? change.path.replaceAll("\\", "/").replace(/^\/+/, "") : "";
    const content = typeof change?.content === "string" ? change.content : null;
    if (!isAllowedImplementationPath(filePath)) throw new PkbError("MODULE_IMPLEMENTATION_PATH_DENIED", `Implementation cannot write ${filePath || "this path"}. Only declarative Schema, Prompt, Workflow, Rule, Template, and Fixture files are allowed.`);
    if (content === null) throw new PkbError("MODULE_IMPLEMENTATION_CONTENT_INVALID", `${filePath} must contain text content.`);
    const size = Buffer.byteLength(content, "utf8");
    if (size > MAX_FILE_BYTES) throw new PkbError("MODULE_IMPLEMENTATION_FILE_TOO_LARGE", `${filePath} exceeds the ${MAX_FILE_BYTES} byte implementation limit.`);
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_BYTES) throw new PkbError("MODULE_IMPLEMENTATION_TOTAL_TOO_LARGE", `Implementation exceeds the ${MAX_TOTAL_BYTES} byte total limit.`);
    if (seen.has(filePath)) throw new PkbError("MODULE_IMPLEMENTATION_DUPLICATE_PATH", `Implementation proposed ${filePath} more than once.`);
    seen.add(filePath);
    return { path: filePath, content };
  });
}

function implementationPrompt(moduleId: string, retry: number, previous: { validation: ModuleValidationReport | null; test: ModuleTestReport | null }): string {
  const diagnostics = retry === 0 ? "This is the first implementation pass." : `This is bounded correction pass ${retry} of ${MAX_AUTO_FIXES}. Fix only the reported problems.\n\nValidation report:\n${JSON.stringify(previous.validation, null, 2)}\n\nModule test report:\n${JSON.stringify(previous.test, null, 2)}`;
  return `You are implementing the declarative artifacts for KnowledgeOS module ${moduleId}.\n\n${diagnostics}\n\nRead module.blueprint.yaml and the existing module/ directory in this temporary context. Keep module.yaml and the Blueprint unchanged. You may only propose text updates under schemas/, prompts/, workflows/, rules/, templates/, and fixtures/. Never create scripts, TypeScript, executors, package files, or files outside those directories. Preserve Core-generated schema fields and contracts. Complete fixtures so the declared module can validate and pass its deterministic Module Test.\n\nReturn JSON only:\n{\n  "summary": "short description",\n  "files": [{ "path": "rules/example.yaml", "content": "complete file text" }]\n}\nDo not use markdown fences.`;
}

async function copyImplementationContext(moduleRoot: string, contextRoot: string): Promise<void> {
  const contextModule = path.join(contextRoot, "module");
  let copiedBytes = 0;
  for (const file of await listFilesRecursive(moduleRoot)) {
    const relative = path.relative(moduleRoot, file).replaceAll(path.sep, "/");
    if (relative !== "module.blueprint.yaml" && !isAllowedImplementationPath(relative)) continue;
    const bytes = (await fs.stat(file)).size;
    if (bytes > MAX_FILE_BYTES || copiedBytes + bytes > MAX_TOTAL_BYTES) continue;
    copiedBytes += bytes;
    const target = path.join(contextModule, ...relative.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(file, target);
  }
}

async function applyChanges(moduleRoot: string, changes: ModuleImplementationChange[]): Promise<void> {
  for (const change of changes) {
    const target = path.resolve(moduleRoot, ...change.path.split("/"));
    if (path.relative(moduleRoot, target).split(path.sep).includes("..")) throw new PkbError("MODULE_IMPLEMENTATION_PATH_DENIED", `Implementation target escaped the module workspace: ${change.path}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.implementation-${process.pid}.tmp`;
    await fs.writeFile(temporary, change.content.endsWith("\n") ? change.content : `${change.content}\n`, "utf8");
    await fs.rename(temporary, target);
  }
}

function attemptRecord(index: number, changes: ModuleImplementationChange[], validation: ModuleValidationReport | null, test: ModuleTestReport | null, summary: unknown): JsonObject {
  return { attempt: index + 1, changed_files: changes.map((change) => change.path), summary: typeof summary === "string" ? summary : null, validation: validation?.overall ?? "NOT_RUN", test: test?.overall ?? "NOT_RUN", at: new Date().toISOString() };
}

/**
 * Runs a bounded, Core-controlled implementation loop. The model only sees a
 * copied context and can only return declarative file proposals; Core writes,
 * validates, and tests each proposal before allowing the next correction.
 */
export async function implementModuleWorkspace(engineRoot: string, vaultRoot: string, moduleId: string, options: ModuleImplementationOptions = {}): Promise<ModuleImplementationReport> {
  if (!MODULE_ID.test(moduleId)) throw new PkbError("MODULE_ID_INVALID", "module_id must use lowercase kebab-case.");
  const moduleRoot = workspaceRoot(vaultRoot, moduleId);
  const manifestPath = path.join(moduleRoot, "module.yaml");
  const blueprintPath = path.join(moduleRoot, "module.blueprint.yaml");
  if (!(await exists(manifestPath)) || !(await exists(blueprintPath))) throw new PkbError("MODULE_IMPLEMENTATION_WORKSPACE_INVALID", "Scaffold a Blueprint in the Module Development workspace before implementation.");
  const manifest = parseYaml(moduleRoot, manifestPath);
  if (manifest.id !== moduleId) throw new PkbError("MODULE_IMPLEMENTATION_WORKSPACE_INVALID", "Workspace manifest does not match the requested module_id.");
  const reportPath = moduleImplementationReportPath(vaultRoot, moduleId);
  const attempts: JsonObject[] = [];
  let validation: ModuleValidationReport | null = null;
  let test: ModuleTestReport | null = null;
  let caught: unknown = null;
  for (let retry = 0; retry <= MAX_AUTO_FIXES; retry += 1) {
    const contextRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-module-implementation-"));
    try {
      await copyImplementationContext(moduleRoot, contextRoot);
      const response = await (options.execute ?? executeCodexJson)({ contextRoot, prompt: implementationPrompt(moduleId, retry, { validation, test }), model: options.codexModel, reasoningEffort: options.codexReasoningEffort, timeoutMs: 180_000 });
      const changes = normalizeChanges(response.output);
      await applyChanges(moduleRoot, changes);
      validation = await validateModule(engineRoot, moduleRoot, { writeReport: true });
      test = validation.overall === "PASS" ? await testModule(engineRoot, moduleId, { writeReport: true, moduleRoot }) : null;
      attempts.push(attemptRecord(retry, changes, validation, test, (response.output as Record<string, unknown>)?.summary));
      if (validation.overall === "PASS" && test?.overall === "PASS") {
        const report: ModuleImplementationReport = { report_version: 1, module_id: moduleId, workspace_path: toVaultPath(vaultRoot, moduleRoot), generated_at: new Date().toISOString(), overall: "PASS", attempts, max_auto_fixes: MAX_AUTO_FIXES, validation, test };
        await writeJsonAtomic(reportPath, report);
        return report;
      }
    } catch (error) {
      caught = error;
      attempts.push({ attempt: retry + 1, changed_files: [], summary: null, validation: validation?.overall ?? "NOT_RUN", test: test?.overall ?? "NOT_RUN", error: error instanceof Error ? error.message : String(error), at: new Date().toISOString() });
      break;
    } finally {
      await fs.rm(contextRoot, { recursive: true, force: true });
    }
  }
  const report: ModuleImplementationReport = { report_version: 1, module_id: moduleId, workspace_path: toVaultPath(vaultRoot, moduleRoot), generated_at: new Date().toISOString(), overall: "FAIL", attempts, max_auto_fixes: MAX_AUTO_FIXES, validation, test };
  await writeJsonAtomic(reportPath, report);
  if (caught) throw caught;
  return report;
}
