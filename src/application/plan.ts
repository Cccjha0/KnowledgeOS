import path from "node:path";
import type { OperationPlan, ResearchReport, UpdateResult } from "../types.js";
import { toVaultPath } from "../core/files.js";

export interface PlanIds {
  planId: string;
  taskId: string;
}

export function buildOperationPlan(
  vaultRoot: string,
  sourceReportAbsolute: string,
  destinationReportAbsolute: string,
  report: ResearchReport,
  update: UpdateResult,
  ids: PlanIds,
): OperationPlan {
  const source = toVaultPath(vaultRoot, sourceReportAbsolute);
  const destination = toVaultPath(vaultRoot, destinationReportAbsolute);
  const marker = `<!-- pkb-report:${report.report_id} -->`;
  const section = update.sections_to_append[0];

  return {
    plan_id: ids.planId,
    task_id: ids.taskId,
    module: "application-tracker",
    instance: report.instance_id,
    summary: `处理 ${report.institution} ${report.program_name} 的研究报告`,
    operations: [
      {
        operation_id: "OP-001",
        type: "update-frontmatter",
        target: update.target_record,
        risk: "green",
        confidence: report.confidence,
        idempotency_key: `${report.report_id}:update-record-frontmatter`,
        payload: {
          patch: update.frontmatter_patch,
        },
        requires_review_id: null,
      },
      {
        operation_id: "OP-002",
        type: "append-section",
        target: update.target_record,
        risk: "green",
        confidence: report.confidence,
        idempotency_key: `${report.report_id}:append-change-log`,
        payload: {
          section: section?.section ?? "变更记录",
          content: section?.content ?? report.summary,
          marker,
        },
        requires_review_id: null,
      },
      {
        operation_id: "OP-003",
        type: "move-file",
        target: source,
        risk: "green",
        confidence: 1,
        idempotency_key: `${report.report_id}:archive-report`,
        payload: {
          destination,
          destination_filename: path.basename(destinationReportAbsolute),
        },
        requires_review_id: null,
      },
    ],
    review_items: update.review_items,
  };
}
