import path from "node:path";
import { parseMarkdown, validateSchema } from "../core/bridge.js";
import { listFilesRecursive, toVaultPath } from "../core/files.js";
import type { ApplicationRecord, OperationPlan, ResearchRequest } from "../types.js";
import { createResearchRequest, OPEN_RESEARCH_REQUEST_STATUSES } from "../application/researchRequest.js";

const RECORD_SCHEMA = "https://pkb.local/schemas/application-tracker/application-record.schema.json";
const REQUEST_SCHEMA = "https://pkb.local/schemas/application-tracker/research-request.schema.json";

export interface ResearchRequestScheduleResult {
  plan: OperationPlan | null;
  created: string[];
  existing: string[];
}

/** A shared, read-only planner for field-due evidence requests. */
export async function prepareDueResearchRequests(options: { vaultRoot: string; taskId: string; planId: string; now: string; allocateId: (prefix: string) => Promise<string> }): Promise<ResearchRequestScheduleResult> {
  const applicationRoot = path.join(options.vaultRoot, "20-Workspace", "Applications");
  const requests: ResearchRequest[] = [];
  for (const file of await listFilesRecursive(applicationRoot, ".md")) {
    if (!file.split(path.sep).includes("Research Requests")) continue;
    const document = parseMarkdown(options.vaultRoot, file);
    if (document.data.type !== "research-request") continue;
    validateSchema(options.vaultRoot, REQUEST_SCHEMA, document.data);
    requests.push(document.data as unknown as ResearchRequest);
  }
  const operations: OperationPlan["operations"] = [];
  const created: string[] = []; const existing: string[] = [];
  for (const file of await listFilesRecursive(applicationRoot, ".md")) {
    if (!file.split(path.sep).includes("Records")) continue;
    const document = parseMarkdown(options.vaultRoot, file);
    if (document.data.type !== "application-record") continue;
    validateSchema(options.vaultRoot, RECORD_SCHEMA, document.data);
    const record = document.data as unknown as ApplicationRecord;
    const due = record.monitoring.active && record.monitoring.next_check !== null && Date.parse(record.monitoring.next_check) <= Date.parse(options.now);
    if (!due) continue;
    const duplicate = requests.find((request) => request.idempotency_key === `application-check:${record.id}:${record.monitoring.next_check}` && OPEN_RESEARCH_REQUEST_STATUSES.has(request.status));
    if (duplicate) { existing.push(duplicate.request_id); continue; }
    const requestId = await options.allocateId("REQ");
    const request = createResearchRequest(record, toVaultPath(options.vaultRoot, file), requestId, options.now);
    validateSchema(options.vaultRoot, REQUEST_SCHEMA, request);
    const root = path.dirname(path.dirname(file));
    const target = toVaultPath(options.vaultRoot, path.join(root, "Research Requests", `${requestId}.md`));
    operations.push({
      operation_id: `OP-${String(operations.length + 1).padStart(3, "0")}`, type: "create-file", target, risk: "green", confidence: 1,
      idempotency_key: request.idempotency_key,
      payload: { document: { data: request, content: `# Research Request ${requestId}\n\nApplication: [[${request.record_path.replace(/\.md$/i, "")}]]\n` }, schema_id: REQUEST_SCHEMA }, requires_review_id: null,
    });
    created.push(requestId); requests.push(request);
  }
  return { plan: operations.length ? { plan_id: options.planId, task_id: options.taskId, source_module: "application-tracker", instance_id: null, summary: `Create ${created.length} due application Research Request(s).`, operations, review_items: [] } : null, created, existing };
}
