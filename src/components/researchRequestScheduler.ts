import path from "node:path";
import { parseMarkdown, validateSchema } from "../core/bridge.js";
import { listFilesRecursive, toVaultPath } from "../core/files.js";
import type { JsonObject, OperationPlan } from "../core/types.js";
import { atPath, createResearchRequestDocument, parseResearchRequestContract, requestIdempotencyKey, requestTargetPath, researchRequestBody, type ResearchRequestContract } from "./researchRequest.js";

export interface ResearchRequestScheduleResult {
  plan: OperationPlan | null;
  created: string[];
  existing: string[];
}

export interface PrepareDueResearchRequestsOptions {
  vaultRoot: string;
  taskId: string;
  planId: string;
  now: string;
  moduleId: string;
  moduleVersion: string;
  manifest: JsonObject;
  allocateId: (prefix: string) => Promise<string>;
}

function requestId(request: JsonObject, contract: ResearchRequestContract): string | null {
  const id = request[contract.request.id_field];
  return typeof id === "string" ? id : null;
}

function isOpenRequest(request: JsonObject, contract: ResearchRequestContract): boolean {
  const status = request[contract.request.status_field];
  return typeof status === "string" && contract.request.open_statuses.includes(status);
}

/**
 * Shared, schema-parameterized planner for field-due evidence requests.
 * It never assumes an Application Record, a particular folder layout, or a
 * request field name; those are all module-owned Research Request Contract data.
 */
export async function prepareDueResearchRequests(options: PrepareDueResearchRequestsOptions): Promise<ResearchRequestScheduleResult> {
  const contract = parseResearchRequestContract(options.manifest);
  const root = path.join(options.vaultRoot, ...contract.record.search_root.split("/"));
  const requests: JsonObject[] = [];
  for (const file of await listFilesRecursive(root, ".md")) {
    if (!file.split(path.sep).includes(contract.request.directory)) continue;
    const document = parseMarkdown(options.vaultRoot, file);
    if (document.data.type !== contract.request.type) continue;
    validateSchema(options.vaultRoot, contract.request.schema, document.data);
    requests.push(document.data);
  }
  const operations: OperationPlan["operations"] = [];
  const created: string[] = []; const existing: string[] = [];
  for (const file of await listFilesRecursive(root, ".md")) {
    if (!file.split(path.sep).includes(contract.record.directory)) continue;
    const document = parseMarkdown(options.vaultRoot, file);
    if (document.data.type !== contract.record.type) continue;
    validateSchema(options.vaultRoot, contract.record.schema, document.data);
    const active = atPath(document.data, contract.record.active_path);
    const dueAt = atPath(document.data, contract.record.due_path);
    const recordId = atPath(document.data, contract.record.id_field);
    if (active !== true || typeof dueAt !== "string" || typeof recordId !== "string" || Date.parse(dueAt) > Date.parse(options.now)) continue;
    const key = requestIdempotencyKey(options.moduleId, recordId, dueAt);
    const duplicate = requests.find((request) => request[contract.request.idempotency_key_field] === key && isOpenRequest(request, contract));
    if (duplicate) { const id = requestId(duplicate, contract); if (id) existing.push(id); continue; }
    const id = await options.allocateId(contract.request.id_prefix);
    const recordPath = toVaultPath(options.vaultRoot, file);
    const request = createResearchRequestDocument({ vaultRoot: options.vaultRoot, moduleId: options.moduleId, contract, record: document.data, recordPath, requestId: id, now: options.now });
    validateSchema(options.vaultRoot, contract.request.schema, request);
    const target = requestTargetPath(options.vaultRoot, file, id, contract);
    operations.push({
      operation_id: `OP-${String(operations.length + 1).padStart(3, "0")}`, type: "create-file", target, risk: "green", confidence: 1,
      idempotency_key: key,
      payload: { document: { data: request, content: researchRequestBody(options.vaultRoot, request, contract) }, schema_id: contract.request.schema }, requires_review_id: null,
    });
    created.push(id); requests.push(request);
  }
  return {
    plan: operations.length ? {
      plan_id: options.planId, task_id: options.taskId, source_module: options.moduleId, instance_id: null,
      summary: `Create ${created.length} due Research Request(s).`, operations, review_items: [],
    } : null,
    created, existing,
  };
}
