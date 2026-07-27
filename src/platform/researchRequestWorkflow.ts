import path from "node:path";
import type { ApplicationRecord, OperationPlan, ResearchRequest } from "../types.js";
import { createResearchRequest, OPEN_RESEARCH_REQUEST_STATUSES } from "../application/researchRequest.js";
import { parseMarkdown, validateSchema } from "../core/bridge.js";
import { listFilesRecursive, toVaultPath, writeJsonAtomic } from "../core/files.js";
import { createGitSnapshot } from "../core/git.js";
import { allocateId } from "../core/ids.js";
import { writeRunLog } from "../core/logs.js";
import { executeOperationPlan } from "../core/operationExecutor.js";
import { rebuildTodayDashboard } from "./dashboard.js";
import { PkbError } from "../core/errors.js";

const RECORD_SCHEMA = "https://pkb.local/schemas/application-tracker/application-record.schema.json";
const REQUEST_SCHEMA = "https://pkb.local/schemas/application-tracker/research-request.schema.json";

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

function requestBody(request: ResearchRequest): string {
  return [
    `# Research Request ${request.request_id}`,
    "",
    `Application: [[${request.record_path.replace(/\.md$/i, "")}]]`,
    "",
    "## Fields to verify",
    "",
    ...request.requested_fields.map((field) => `- ${field}`),
    "",
    "## Instructions",
    "",
    "Give this request to a web-enabled research assistant. The returned Research Report must set request_id to this request ID and be placed in the instance Inbox.",
    "",
  ].join("\n");
}

export async function syncDueResearchRequests(vaultRoot: string, now = new Date().toISOString()): Promise<ResearchSyncResult> {
  const applicationRoot = path.join(vaultRoot, "20-Workspace", "Applications");
  const existingRequests: ResearchRequest[] = [];
  for (const file of await listFilesRecursive(applicationRoot, ".md")) {
    if (!file.split(path.sep).includes("Research Requests")) continue;
    const document = parseMarkdown(vaultRoot, file);
    if (document.data.type !== "research-request") continue;
    validateSchema(vaultRoot, REQUEST_SCHEMA, document.data);
    existingRequests.push(document.data as unknown as ResearchRequest);
  }

  const operations: OperationPlan["operations"] = [];
  const created: string[] = [];
  const existing: string[] = [];
  for (const file of await listFilesRecursive(applicationRoot, ".md")) {
    if (!file.split(path.sep).includes("Records")) continue;
    const document = parseMarkdown(vaultRoot, file);
    if (document.data.type !== "application-record") continue;
    validateSchema(vaultRoot, RECORD_SCHEMA, document.data);
    const record = document.data as unknown as ApplicationRecord;
    const due = record.monitoring.active && record.monitoring.next_check !== null && Date.parse(record.monitoring.next_check) <= Date.parse(now);
    if (!due) continue;
    const duplicate = existingRequests.find((request) =>
      request.idempotency_key === `application-check:${record.id}:${record.monitoring.next_check}` &&
      OPEN_RESEARCH_REQUEST_STATUSES.has(request.status),
    );
    if (duplicate) {
      existing.push(duplicate.request_id);
      continue;
    }
    const requestId = await allocateId(vaultRoot, "REQ");
    const recordPath = toVaultPath(vaultRoot, file);
    const request = createResearchRequest(record, recordPath, requestId, now);
    validateSchema(vaultRoot, REQUEST_SCHEMA, request);
    const instanceRoot = path.dirname(path.dirname(file));
    const target = toVaultPath(vaultRoot, path.join(instanceRoot, "Research Requests", `${requestId}.md`));
    operations.push({
      operation_id: `OP-${String(operations.length + 1).padStart(3, "0")}`,
      type: "create-file",
      target,
      risk: "green",
      confidence: 1,
      idempotency_key: request.idempotency_key,
      payload: { document: { data: request, content: requestBody(request) }, schema_id: REQUEST_SCHEMA },
      requires_review_id: null,
    });
    created.push(requestId);
    existingRequests.push(request);
  }

  if (operations.length === 0) {
    return { created, existing, runId: null, planPath: null, snapshot: null, todayPath: toVaultPath(vaultRoot, await rebuildTodayDashboard(vaultRoot)) };
  }
  const taskId = await allocateId(vaultRoot, "TASK");
  const planId = await allocateId(vaultRoot, "PLAN");
  const runId = await allocateId(vaultRoot, "RUN");
  const plan: OperationPlan = {
    plan_id: planId,
    task_id: taskId,
    source_module: "application-tracker",
    instance_id: null,
    summary: `Create ${created.length} due application Research Request(s).`,
    operations,
    review_items: [],
  };
  const planAbsolute = path.join(vaultRoot, "90-System", "State", "Plans", `${planId}.json`);
  await writeJsonAtomic(planAbsolute, plan);
  const snapshot = await createGitSnapshot(vaultRoot, runId);
  await executeOperationPlan(vaultRoot, plan, {
    allowedTypes: ["create-file"],
    allowedTargets: operations.map((operation) => operation.target!),
    requiredReviewId: null,
    gitSnapshot: snapshot,
  });
  await writeRunLog(vaultRoot, {
    run_id: runId, task_id: taskId, plan_id: planId, source_module: "application-tracker", instance_id: null,
    review_id: null, status: "completed", git_snapshot: snapshot, started_at: now,
    completed_at: new Date().toISOString(), schema_version: 1,
  }, `# ${runId}\n\nCreated Research Requests: ${created.join(", ")}\n`);
  const todayPath = await rebuildTodayDashboard(vaultRoot);
  return { created, existing, runId, planPath: toVaultPath(vaultRoot, planAbsolute), snapshot, todayPath: toVaultPath(vaultRoot, todayPath) };
}

export async function startResearchRequest(vaultRoot: string, requestId: string, now = new Date().toISOString()): Promise<ResearchStartResult> {
  const candidates = (await listFilesRecursive(path.join(vaultRoot, "20-Workspace", "Applications"), ".md"))
    .filter((file) => file.split(path.sep).includes("Research Requests") && path.basename(file, ".md") === requestId);
  if (candidates.length !== 1) throw new PkbError("RESEARCH_REQUEST_NOT_FOUND", `Expected exactly one Research Request ${requestId}.`, candidates);
  const file = candidates[0]!;
  const document = parseMarkdown(vaultRoot, file);
  validateSchema(vaultRoot, REQUEST_SCHEMA, document.data);
  const request = document.data as unknown as ResearchRequest;
  if (request.status === "in-progress") {
    return { requestId, status: "in-progress", runId: null, planPath: null, snapshot: null, todayPath: toVaultPath(vaultRoot, await rebuildTodayDashboard(vaultRoot)) };
  }
  if (request.status !== "pending" && request.status !== "needs-more-information") {
    throw new PkbError("RESEARCH_REQUEST_NOT_STARTABLE", `Research Request ${requestId} is ${request.status}.`);
  }
  const taskId = await allocateId(vaultRoot, "TASK");
  const planId = await allocateId(vaultRoot, "PLAN");
  const runId = await allocateId(vaultRoot, "RUN");
  const target = toVaultPath(vaultRoot, file);
  const plan: OperationPlan = {
    plan_id: planId, task_id: taskId, source_module: "application-tracker", instance_id: request.instance_id,
    summary: `Mark Research Request ${requestId} in progress.`, review_items: [],
    operations: [{
      operation_id: "OP-001", type: "update-frontmatter", target, risk: "green", confidence: 1,
      idempotency_key: `${requestId}:start`, payload: {
        patch: { status: "in-progress", updated_at: now, next_action_at: now }, schema_id: REQUEST_SCHEMA,
      }, requires_review_id: null,
    }],
  };
  const planAbsolute = path.join(vaultRoot, "90-System", "State", "Plans", `${planId}.json`);
  await writeJsonAtomic(planAbsolute, plan);
  const snapshot = await createGitSnapshot(vaultRoot, runId);
  await executeOperationPlan(vaultRoot, plan, { allowedTypes: ["update-frontmatter"], allowedTargets: [target], requiredReviewId: null, gitSnapshot: snapshot });
  await writeRunLog(vaultRoot, {
    run_id: runId, task_id: taskId, plan_id: planId, source_module: "application-tracker", instance_id: request.instance_id,
    review_id: null, status: "completed", git_snapshot: snapshot, started_at: now,
    completed_at: new Date().toISOString(), schema_version: 1,
  }, `# ${runId}\n\nStarted Research Request ${requestId}.\n`);
  return { requestId, status: "in-progress", runId, planPath: toVaultPath(vaultRoot, planAbsolute), snapshot, todayPath: toVaultPath(vaultRoot, await rebuildTodayDashboard(vaultRoot)) };
}
