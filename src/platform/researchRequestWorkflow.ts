import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMarkdown, validateSchema } from "../core/bridge.js";
import { PkbError } from "../core/errors.js";
import { fromVaultPath, listFilesRecursive, toVaultPath, writeJsonAtomic } from "../core/files.js";
import { createGitSnapshot } from "../core/git.js";
import { allocateId } from "../core/ids.js";
import { writeRunLog } from "../core/logs.js";
import { executeOperationPlan } from "../core/operationExecutor.js";
import { discoverModulesForVault } from "../core/discovery.js";
import type { JsonObject, OperationPlan } from "../core/types.js";
import { atPath, parseResearchRequestContract, type ResearchRequestContract } from "../components/researchRequest.js";
import { prepareDueResearchRequests } from "../components/researchRequestScheduler.js";
import { rebuildTodayDashboard } from "./dashboard.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface ResearchSyncResult {
  created: string[];
  existing: string[];
  runId: string | null;
  planPath: string | null;
  snapshot: string | null;
  todayPath: string;
}

export interface ResearchStartResult {
  requestId: string;
  status: "in-progress";
  runId: string | null;
  planPath: string | null;
  snapshot: string | null;
  todayPath: string;
}

interface ResolvedResearchModule { id: string; version: string; manifest: JsonObject; contract: ResearchRequestContract; }

async function resolveResearchModule(vaultRoot: string, moduleId: string): Promise<ResolvedResearchModule> {
  const module = (await discoverModulesForVault(ENGINE_ROOT, vaultRoot)).find((candidate) => candidate.data.id === moduleId && candidate.data.status === "enabled");
  if (!module) throw new PkbError("RESEARCH_REQUEST_MODULE_UNAVAILABLE", `Enabled module ${moduleId} was not found.`);
  return { id: moduleId, version: String(module.data.version ?? "unknown"), manifest: module.data, contract: parseResearchRequestContract(module.data) };
}

/** Legacy CLI facade for a generic, module-owned research request lifecycle. */
export async function syncDueResearchRequests(vaultRoot: string, moduleId: string, now = new Date().toISOString()): Promise<ResearchSyncResult> {
  const resolved = await resolveResearchModule(vaultRoot, moduleId);
  const taskId = await allocateId(vaultRoot, "TASK"); const planId = await allocateId(vaultRoot, "PLAN"); const runId = await allocateId(vaultRoot, "RUN");
  const scheduled = await prepareDueResearchRequests({ vaultRoot, taskId, planId, now, moduleId: resolved.id, moduleVersion: resolved.version, manifest: resolved.manifest, allocateId: (prefix) => allocateId(vaultRoot, prefix) });
  if (!scheduled.plan) return { created: scheduled.created, existing: scheduled.existing, runId: null, planPath: null, snapshot: null, todayPath: toVaultPath(vaultRoot, await rebuildTodayDashboard(vaultRoot)) };
  const planPath = path.join(vaultRoot, "90-System", "State", "Plans", `${planId}.json`);
  await writeJsonAtomic(planPath, scheduled.plan);
  const snapshot = await createGitSnapshot(vaultRoot, runId);
  await executeOperationPlan(vaultRoot, scheduled.plan, { allowedTypes: ["create-file"], allowedTargets: scheduled.plan.operations.map((operation) => operation.target!).filter(Boolean), requiredReviewId: null, gitSnapshot: snapshot });
  await writeRunLog(vaultRoot, { run_id: runId, task_id: taskId, plan_id: planId, source_module: resolved.id, instance_id: null, review_id: null, status: "completed", git_snapshot: snapshot, started_at: now, completed_at: new Date().toISOString(), schema_version: 1 }, `# ${runId}\n\nCreated Research Requests: ${scheduled.created.join(", ")}\n`);
  return { created: scheduled.created, existing: scheduled.existing, runId, planPath: toVaultPath(vaultRoot, planPath), snapshot, todayPath: toVaultPath(vaultRoot, await rebuildTodayDashboard(vaultRoot)) };
}

export async function startResearchRequest(vaultRoot: string, moduleId: string, requestId: string, now = new Date().toISOString()): Promise<ResearchStartResult> {
  const resolved = await resolveResearchModule(vaultRoot, moduleId);
  const root = path.join(vaultRoot, ...resolved.contract.record.search_root.split("/"));
  const candidates = (await listFilesRecursive(root, ".md")).filter((file) => file.split(path.sep).includes(resolved.contract.request.directory) && path.basename(file, ".md") === requestId);
  if (candidates.length !== 1) throw new PkbError("RESEARCH_REQUEST_NOT_FOUND", `Expected exactly one Research Request ${requestId}.`, candidates);
  const file = candidates[0]!; const document = parseMarkdown(vaultRoot, file);
  validateSchema(vaultRoot, resolved.contract.request.schema, document.data);
  const status = document.data[resolved.contract.request.status_field];
  if (status === "in-progress") return { requestId, status: "in-progress", runId: null, planPath: null, snapshot: null, todayPath: toVaultPath(vaultRoot, await rebuildTodayDashboard(vaultRoot)) };
  if (status !== "pending" && status !== "needs-more-information") throw new PkbError("RESEARCH_REQUEST_NOT_STARTABLE", `Research Request ${requestId} is ${String(status)}.`);
  const taskId = await allocateId(vaultRoot, "TASK"); const planId = await allocateId(vaultRoot, "PLAN"); const runId = await allocateId(vaultRoot, "RUN"); const target = toVaultPath(vaultRoot, file);
  const instanceId = atPath(document.data, resolved.contract.request.instance_id_field);
  const plan: OperationPlan = { plan_id: planId, task_id: taskId, source_module: resolved.id, instance_id: typeof instanceId === "string" ? instanceId : null, summary: `Mark Research Request ${requestId} in progress.`, review_items: [], operations: [{ operation_id: "OP-001", type: "update-frontmatter", target, risk: "green", confidence: 1, idempotency_key: `${resolved.id}:${requestId}:start`, payload: { patch: { [resolved.contract.request.status_field]: "in-progress", updated_at: now, next_action_at: now }, schema_id: resolved.contract.request.schema }, requires_review_id: null }] };
  const planPath = path.join(vaultRoot, "90-System", "State", "Plans", `${planId}.json`); await writeJsonAtomic(planPath, plan);
  const snapshot = await createGitSnapshot(vaultRoot, runId);
  await executeOperationPlan(vaultRoot, plan, { allowedTypes: ["update-frontmatter"], allowedTargets: [target], requiredReviewId: null, gitSnapshot: snapshot });
  await writeRunLog(vaultRoot, { run_id: runId, task_id: taskId, plan_id: planId, source_module: resolved.id, instance_id: typeof instanceId === "string" ? instanceId : null, review_id: null, status: "completed", git_snapshot: snapshot, started_at: now, completed_at: new Date().toISOString(), schema_version: 1 }, `# ${runId}\n\nStarted Research Request ${requestId}.\n`);
  return { requestId, status: "in-progress", runId, planPath: toVaultPath(vaultRoot, planPath), snapshot, todayPath: toVaultPath(vaultRoot, await rebuildTodayDashboard(vaultRoot)) };
}
