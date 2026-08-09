import path from "node:path";
import { PkbError } from "../core/errors.js";
import { exists, fromVaultPath, readJson, sha256File } from "../core/files.js";
import type { JsonObject, OperationPlan } from "../core/types.js";
import type { ProcessedReportsFile } from "../types.js";
import type { ResearchRequestContract } from "./researchRequest.js";

export interface ReconciliationCandidate { path: string; data: JsonObject; }

export interface ReconciliationAdapterInput {
  vaultRoot: string;
  taskId: string;
  runId: string;
  moduleId: string;
  moduleVersion: string;
  instance: JsonObject;
  report: JsonObject;
  sourceFile: string;
  candidates: ReconciliationCandidate[];
  researchRequest: ResearchRequestContract;
  allocateId: (prefix: string) => Promise<string>;
}

export interface ReconciliationAdapterResult {
  plan: OperationPlan;
  report: JsonObject;
  destination: string;
  reviewCount: number;
}

/**
 * A module supplies its own matching/comparison adapter. The shared component
 * owns only durable report idempotency and archive restoration, so it never
 * embeds a business Record or Request schema.
 */
export interface ResearchReconciliationAdapter {
  id: string;
  reportId(report: JsonObject): string;
  instanceId(report: JsonObject): string | null;
  reconcile(input: ReconciliationAdapterInput): Promise<ReconciliationAdapterResult>;
}

export interface ReconciliationInput extends ReconciliationAdapterInput { adapter: ResearchReconciliationAdapter; }

export interface ReconciliationResult {
  plan: OperationPlan | null;
  report: JsonObject;
  destination: string | null;
  reportHash: string;
  reviewCount: number;
  status: "processed" | "already-processed";
}

export async function prepareResearchReconciliation(input: ReconciliationInput): Promise<ReconciliationResult> {
  const reportId = input.adapter.reportId(input.report);
  if (!reportId) throw new PkbError("RESEARCH_REPORT_ID_REQUIRED", `Research reconciliation adapter ${input.adapter.id} did not provide a report id.`);
  const sourceAbsolute = fromVaultPath(input.vaultRoot, input.sourceFile);
  const reportHash = await sha256File(sourceAbsolute);
  const processed = await readJson<ProcessedReportsFile>(path.join(input.vaultRoot, "90-System", "State", "processed-reports.json"), { reports: {} });
  const previous = processed.reports[reportId];
  if (previous?.hash === reportHash) {
    const archive = fromVaultPath(input.vaultRoot, previous.destination);
    if (input.sourceFile !== previous.destination && !(await exists(archive))) {
      const planId = await input.allocateId("PLAN");
      return { plan: { plan_id: planId, task_id: input.taskId, source_module: input.moduleId, instance_id: input.adapter.instanceId(input.report), summary: "Restore an already processed research report to its archive", review_items: [], operations: [{ operation_id: "OP-001", type: "move-file", target: input.sourceFile, risk: "green", confidence: 1, idempotency_key: `restore-processed-report:${reportId}:${reportHash}`, payload: { destination: previous.destination }, requires_review_id: null }] }, report: input.report, destination: previous.destination, reportHash, reviewCount: 0, status: "already-processed" };
    }
    return { plan: null, report: input.report, destination: previous.destination, reportHash, reviewCount: 0, status: "already-processed" };
  }
  const result = await input.adapter.reconcile(input);
  return { plan: result.plan, report: result.report, destination: result.destination, reportHash, reviewCount: result.reviewCount, status: "processed" };
}
