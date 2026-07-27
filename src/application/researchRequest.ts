import { PkbError } from "../core/errors.js";
import type { ApplicationRecord, ResearchReport, ResearchRequest } from "../types.js";

export const OPEN_RESEARCH_REQUEST_STATUSES = new Set<ResearchRequest["status"]>([
  "pending",
  "in-progress",
  "needs-more-information",
]);

export function researchRequestKey(record: ApplicationRecord): string {
  return `application-check:${record.id}:${record.monitoring.next_check ?? "unscheduled"}`;
}

export function createResearchRequest(
  record: ApplicationRecord,
  recordPath: string,
  requestId: string,
  now: string,
): ResearchRequest {
  const requestedFields = Object.entries(record.facts)
    .filter(([, fact]) => fact.status === "unknown" || fact.status === "pending" || fact.status === "conflicting")
    .map(([field]) => field);
  return {
    request_id: requestId,
    type: "research-request",
    instance_id: record.instance_id,
    application_id: record.id,
    record_path: recordPath,
    status: "pending",
    reason: "The application record reached its scheduled verification time.",
    requested_fields: requestedFields.length > 0
      ? requestedFields
      : ["application_open", "deadline", "tuition", "academic_requirement", "english_requirement"],
    report_ids: [],
    idempotency_key: researchRequestKey(record),
    created_at: now,
    updated_at: now,
    completed_at: null,
    next_action_at: now,
    schema_version: 1,
  };
}

export function applyReportToResearchRequest(
  request: ResearchRequest,
  report: ResearchReport,
  now: string,
): ResearchRequest {
  if (report.request_id !== request.request_id) {
    throw new PkbError("RESEARCH_REQUEST_MISMATCH", "The report does not reference the selected Research Request.");
  }
  if (report.instance_id !== request.instance_id) {
    throw new PkbError("RESEARCH_REQUEST_INSTANCE_MISMATCH", "The report and Research Request belong to different instances.");
  }
  if (!OPEN_RESEARCH_REQUEST_STATUSES.has(request.status)) {
    throw new PkbError("RESEARCH_REQUEST_CLOSED", `Research Request ${request.request_id} is already ${request.status}.`);
  }
  const reportIds = request.report_ids.includes(report.report_id)
    ? request.report_ids
    : [...request.report_ids, report.report_id];
  const complete = report.unresolved.length === 0;
  return {
    ...request,
    status: complete ? "completed" : "needs-more-information",
    report_ids: reportIds,
    updated_at: now,
    completed_at: complete ? now : null,
    next_action_at: complete ? null : now,
  };
}
