import path from "node:path";
import { parseMarkdown, validateSchema } from "../core/bridge.js";
import { PkbError } from "../core/errors.js";
import { exists, fromVaultPath, listFilesRecursive, sha256File, toVaultPath } from "../core/files.js";
import type { JsonObject, OperationPlan } from "../core/types.js";
import type { ApplicationRecord, ResearchReport, ResearchRequest, UpdateResult } from "./types.js";
import { DeterministicComparisonAdapter } from "./adapter.js";
import { buildOperationPlan } from "./plan.js";
import { applyReportToResearchRequest } from "./researchRequest.js";
import type { ReconciliationAdapterInput, ReconciliationAdapterResult, ResearchReconciliationAdapter } from "../components/researchReconciliation.js";
import { atPath } from "../components/researchRequest.js";

const REVIEW_SCHEMA = "https://pkb.local/schemas/core/review-item.schema.json";

function safeFilename(value: string): string { return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, ""); }
function asRecord(value: JsonObject): ApplicationRecord { return value as unknown as ApplicationRecord; }
function asReport(value: JsonObject): ResearchReport { return value as unknown as ResearchReport; }
function reportReference(vaultRoot: string, destination: string): string { return `[[${toVaultPath(vaultRoot, destination).replace(/\.md$/i, "")}]]`; }

function locateRecord(vaultRoot: string, candidates: ReconciliationAdapterInput["candidates"], report: ResearchReport, input: ReconciliationAdapterInput): { path: string; record: ApplicationRecord } {
  const identity: Array<{ path: string; record: ApplicationRecord }> = []; const exact: typeof identity = [];
  for (const candidate of candidates) {
    if (candidate.data.type !== "application-record") continue;
    validateSchema(vaultRoot, input.researchRequest.record.schema, candidate.data); const record = asRecord(candidate.data);
    const institution = record.institution.trim().toLowerCase() === report.institution.trim().toLowerCase();
    const program = report.program_code ? record.program_code === report.program_code : record.program_name.trim().toLowerCase() === report.program_name.trim().toLowerCase();
    if (institution && program) identity.push({ path: candidate.path, record }); if (institution && program && record.intake === report.intake) exact.push({ path: candidate.path, record });
  }
  if (exact.length === 1) return exact[0]!; if (exact.length === 0 && identity.length === 1) return identity[0]!;
  if (exact.length > 1) throw new PkbError("APPLICATION_RECORD_AMBIGUOUS", "Multiple application records match this report.", exact.map((item) => item.path));
  throw new PkbError("APPLICATION_RECORD_NOT_FOUND", `No application record matches ${report.institution} ${report.program_name} ${report.intake}.`);
}

async function destinationFor(vaultRoot: string, instanceRoot: string, sourceFile: string, report: ResearchReport): Promise<string> {
  const source = fromVaultPath(vaultRoot, sourceFile); const root = path.join(instanceRoot, "Research"); let destination = path.join(root, path.basename(source));
  if (!(await exists(destination)) || await sha256File(destination) === await sha256File(source)) return destination;
  const extension = path.extname(source); return path.join(root, `${safeFilename(path.basename(source, extension))}-${safeFilename(report.report_id)}${extension}`);
}

async function attachRequest(vaultRoot: string, plan: OperationPlan, report: ResearchReport, record: ApplicationRecord, recordPath: string, now: string, input: ReconciliationAdapterInput): Promise<void> {
  if (!report.request_id) return;
  const contract = input.researchRequest;
  const requests = (await listFilesRecursive(path.join(vaultRoot, ...contract.record.search_root.split("/")), ".md")).filter((file) => file.split(path.sep).includes(contract.request.directory) && path.basename(file, ".md") === report.request_id);
  if (requests.length !== 1) throw new PkbError("RESEARCH_REQUEST_NOT_FOUND", `Expected one Research Request ${report.request_id}.`, requests);
  const document = parseMarkdown(vaultRoot, requests[0]!); validateSchema(vaultRoot, contract.request.schema, document.data); const request = document.data as unknown as ResearchRequest;
  if (atPath(document.data, contract.request.record_id_field) !== record.id || atPath(document.data, contract.request.record_path_field) !== recordPath) throw new PkbError("RESEARCH_REQUEST_TARGET_MISMATCH", "Research Request does not belong to the matched target record.");
  plan.operations.push({ operation_id: `OP-${String(plan.operations.length + 1).padStart(3, "0")}`, type: "update-frontmatter", target: toVaultPath(vaultRoot, requests[0]!), risk: "green", confidence: 1, idempotency_key: `${request.request_id}:${report.report_id}:lifecycle`, payload: { patch: applyReportToResearchRequest(request, report, now), schema_id: contract.request.schema }, requires_review_id: null });
}

/** Application module's deterministic matching and comparison implementation. */
export const applicationResearchReconciliationAdapter: ResearchReconciliationAdapter = {
  id: "application-deterministic",
  reportId: (report) => typeof report.report_id === "string" ? report.report_id : "",
  instanceId: (report) => typeof report.instance_id === "string" ? report.instance_id : null,
  async reconcile(input): Promise<ReconciliationAdapterResult> {
    const report = asReport(input.report); const contentRoot = String(input.instance.content_root ?? "");
    if (!contentRoot) throw new PkbError("INVALID_INSTANCE", "Instance is missing content_root.");
    const target = locateRecord(input.vaultRoot, input.candidates, report, input);
    const destination = await destinationFor(input.vaultRoot, fromVaultPath(input.vaultRoot, contentRoot), input.sourceFile, report); const now = new Date().toISOString();
    const update: UpdateResult = await new DeterministicComparisonAdapter().compare(target.record, report, { targetRecordPath: target.path, reportReference: reportReference(input.vaultRoot, destination), now, allocateReviewId: () => input.allocateId("REV") });
    const planId = await input.allocateId("PLAN");
    for (const review of update.review_items) {
      review.generation = { run_id: input.runId, module: { id: input.moduleId, version: input.moduleVersion }, workflow: { id: "process-research-report", version: "1.0.0" }, prompt: null, processor: { id: "comparison-table", version: "1.0.0" }, generated_at: now };
      validateSchema(input.vaultRoot, REVIEW_SCHEMA, review);
    }
    const plan = buildOperationPlan(input.vaultRoot, fromVaultPath(input.vaultRoot, input.sourceFile), destination, report, update, { taskId: input.taskId, planId });
    await attachRequest(input.vaultRoot, plan, report, target.record, target.path, now, input);
    return { plan, report, destination: toVaultPath(input.vaultRoot, destination), reviewCount: update.review_items.length };
  },
};
