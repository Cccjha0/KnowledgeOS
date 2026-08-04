import path from "node:path";
import { parseMarkdown, validateSchema } from "../core/bridge.js";
import { PkbError } from "../core/errors.js";
import { exists, fromVaultPath, listFilesRecursive, readJson, sha256File, toVaultPath } from "../core/files.js";
import type { ApplicationRecord, JsonObject, OperationPlan, ProcessedReportsFile, ResearchReport, ResearchRequest, UpdateResult } from "../types.js";
import { DeterministicComparisonAdapter } from "../application/adapter.js";
import { buildOperationPlan } from "../application/plan.js";
import { applyReportToResearchRequest } from "../application/researchRequest.js";

const SCHEMAS = {
  record: "https://pkb.local/schemas/application-tracker/application-record.schema.json",
  request: "https://pkb.local/schemas/application-tracker/research-request.schema.json",
  review: "https://pkb.local/schemas/core/review-item.schema.json",
} as const;

export interface ReconciliationCandidate {
  path: string;
  data: JsonObject;
}

export interface ReconciliationInput {
  vaultRoot: string;
  taskId: string;
  runId: string;
  moduleId: string;
  moduleVersion: string;
  instance: JsonObject;
  report: JsonObject;
  sourceFile: string;
  candidates: ReconciliationCandidate[];
  allocateId: (prefix: string) => Promise<string>;
}

export interface ReconciliationResult {
  plan: OperationPlan | null;
  report: ResearchReport;
  destination: string | null;
  reportHash: string;
  reviewCount: number;
  status: "processed" | "already-processed";
}

function asRecord(value: JsonObject): ApplicationRecord { return value as unknown as ApplicationRecord; }
function asReport(value: JsonObject): ResearchReport { return value as unknown as ResearchReport; }

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function reportReference(vaultRoot: string, destination: string): string {
  return `[[${toVaultPath(vaultRoot, destination).replace(/\.md$/i, "")}]]`;
}

function locateRecord(vaultRoot: string, candidates: ReconciliationCandidate[], report: ResearchReport): { path: string; record: ApplicationRecord } {
  const identity: Array<{ path: string; record: ApplicationRecord }> = [];
  const exact: typeof identity = [];
  for (const candidate of candidates) {
    if (candidate.data.type !== "application-record") continue;
    validateSchema(vaultRoot, SCHEMAS.record, candidate.data);
    const record = asRecord(candidate.data);
    const institution = record.institution.trim().toLowerCase() === report.institution.trim().toLowerCase();
    const program = report.program_code ? record.program_code === report.program_code : record.program_name.trim().toLowerCase() === report.program_name.trim().toLowerCase();
    if (institution && program) identity.push({ path: candidate.path, record });
    if (institution && program && record.intake === report.intake) exact.push({ path: candidate.path, record });
  }
  if (exact.length === 1) return exact[0]!;
  if (exact.length === 0 && identity.length === 1) return identity[0]!;
  if (exact.length > 1) throw new PkbError("APPLICATION_RECORD_AMBIGUOUS", "Multiple application records match this report.", exact.map((item) => item.path));
  throw new PkbError("APPLICATION_RECORD_NOT_FOUND", `No application record matches ${report.institution} ${report.program_name} ${report.intake}.`);
}

async function destinationFor(vaultRoot: string, instanceRoot: string, sourceFile: string, report: ResearchReport): Promise<string> {
  const source = fromVaultPath(vaultRoot, sourceFile);
  const root = path.join(instanceRoot, "Research");
  let destination = path.join(root, path.basename(source));
  if (!(await exists(destination)) || await sha256File(destination) === await sha256File(source)) return destination;
  const extension = path.extname(source);
  destination = path.join(root, `${safeFilename(path.basename(source, extension))}-${safeFilename(report.report_id)}${extension}`);
  return destination;
}

async function attachRequest(vaultRoot: string, plan: OperationPlan, report: ResearchReport, record: ApplicationRecord, recordPath: string, now: string): Promise<void> {
  if (!report.request_id) return;
  const requests = (await listFilesRecursive(path.join(vaultRoot, "20-Workspace", "Applications"), ".md"))
    .filter((file) => file.split(path.sep).includes("Research Requests") && path.basename(file, ".md") === report.request_id);
  if (requests.length !== 1) throw new PkbError("RESEARCH_REQUEST_NOT_FOUND", `Expected one Research Request ${report.request_id}.`, requests);
  const document = parseMarkdown(vaultRoot, requests[0]!);
  validateSchema(vaultRoot, SCHEMAS.request, document.data);
  const request = document.data as unknown as ResearchRequest;
  if (request.application_id !== record.id || request.record_path !== recordPath) throw new PkbError("RESEARCH_REQUEST_TARGET_MISMATCH", "Research Request does not belong to the matched Application Record.");
  const target = toVaultPath(vaultRoot, requests[0]!);
  plan.operations.push({
    operation_id: `OP-${String(plan.operations.length + 1).padStart(3, "0")}`,
    type: "update-frontmatter", target, risk: "green", confidence: 1,
    idempotency_key: `${request.request_id}:${report.report_id}:lifecycle`,
    payload: { patch: applyReportToResearchRequest(request, report, now), schema_id: SCHEMAS.request }, requires_review_id: null,
  });
}

/**
 * Shared component: performs no writes. It converts a structured evidence
 * report and matching record candidates into a constrained Operation Plan.
 */
export async function prepareResearchReconciliation(input: ReconciliationInput): Promise<ReconciliationResult> {
  const report = asReport(input.report);
  const sourceAbsolute = fromVaultPath(input.vaultRoot, input.sourceFile);
  const reportHash = await sha256File(sourceAbsolute);
  const processed = await readJson<ProcessedReportsFile>(path.join(input.vaultRoot, "90-System", "State", "processed-reports.json"), { reports: {} });
  const previous = processed.reports[report.report_id];
  if (previous?.hash === reportHash) {
    const archive = fromVaultPath(input.vaultRoot, previous.destination);
    if (input.sourceFile !== previous.destination && !(await exists(archive))) {
      const planId = await input.allocateId("PLAN");
      return {
        plan: { plan_id: planId, task_id: input.taskId, source_module: input.moduleId, instance_id: report.instance_id, summary: "Restore an already processed research report to its archive", review_items: [], operations: [{
          operation_id: "OP-001", type: "move-file", target: input.sourceFile, risk: "green", confidence: 1,
          idempotency_key: `restore-processed-report:${report.report_id}:${reportHash}`, payload: { destination: previous.destination }, requires_review_id: null,
        }] },
        report, destination: previous.destination, reportHash, reviewCount: 0, status: "already-processed",
      };
    }
    return { plan: null, report, destination: previous.destination, reportHash, reviewCount: 0, status: "already-processed" };
  }

  const contentRoot = String(input.instance.content_root ?? "");
  if (!contentRoot) throw new PkbError("INVALID_INSTANCE", "Instance is missing content_root.");
  const target = locateRecord(input.vaultRoot, input.candidates, report);
  const destination = await destinationFor(input.vaultRoot, fromVaultPath(input.vaultRoot, contentRoot), input.sourceFile, report);
  const now = new Date().toISOString();
  const update: UpdateResult = await new DeterministicComparisonAdapter().compare(target.record, report, {
    targetRecordPath: target.path, reportReference: reportReference(input.vaultRoot, destination), now,
    allocateReviewId: () => input.allocateId("REV"),
  });
  const planId = await input.allocateId("PLAN");
  for (const review of update.review_items) {
    review.generation = { run_id: input.runId, module: { id: input.moduleId, version: input.moduleVersion }, workflow: { id: "process-research-report", version: "1.0.0" }, prompt: null, processor: { id: "comparison-table", version: "1.0.0" }, generated_at: now };
    validateSchema(input.vaultRoot, SCHEMAS.review, review);
  }
  const plan = buildOperationPlan(input.vaultRoot, sourceAbsolute, destination, report, update, { taskId: input.taskId, planId });
  await attachRequest(input.vaultRoot, plan, report, target.record, target.path, now);
  return { plan, report, destination: toVaultPath(input.vaultRoot, destination), reportHash, reviewCount: update.review_items.length, status: "processed" };
}
