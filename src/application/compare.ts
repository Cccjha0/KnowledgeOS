import type {
  ApplicationFact,
  ApplicationRecord,
  FieldChange,
  ResearchFinding,
  ResearchReport,
  UpdateResult,
} from "./types.js";
import type { JsonObject, JsonValue, ReviewItem } from "../core/types.js";
import { deepEqual, uniqueJsonValues } from "../core/files.js";
import { fieldRisk } from "./fieldPolicy.js";

export interface CompareOptions {
  targetRecordPath: string;
  reportReference: string;
  now: string;
  allocateReviewId: () => Promise<string>;
}

function addDays(iso: string, days: number): string {
  const timestamp = Date.parse(iso) + days * 24 * 60 * 60 * 1000;
  const offsetMatch = iso.match(/([+-])(\d{2}):(\d{2})$/);
  if (!offsetMatch) {
    return new Date(timestamp).toISOString();
  }

  const sign = offsetMatch[1] === "-" ? -1 : 1;
  const hours = Number(offsetMatch[2]);
  const minutes = Number(offsetMatch[3]);
  const offsetMinutes = sign * (hours * 60 + minutes);
  const local = new Date(timestamp + offsetMinutes * 60 * 1000);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const offset = `${offsetMatch[1]}${offsetMatch[2]}:${offsetMatch[3]}`;
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}${offset}`;
}

function toStringArray(values: JsonValue[]): string[] {
  return values.filter((value): value is string => typeof value === "string");
}

function updatedFact(
  current: ApplicationFact | undefined,
  finding: ResearchFinding,
  report: ResearchReport,
  reportReference: string,
): ApplicationFact {
  const existingRefs = current ? current.source_refs : [];
  return {
    value: structuredClone(finding.value),
    status: finding.status,
    confidence: finding.confidence,
    checked_at: report.checked_at,
    source_refs: uniqueJsonValues([...existingRefs, reportReference]),
    notes: finding.notes,
  };
}

function proposedStatus(field: string, newValue: JsonValue): string | null {
  if (field === "application_open" && newValue === true) {
    return "open";
  }
  if (field === "application_open" && newValue === false) {
    return "not-open";
  }
  return null;
}

function normalizedText(value: JsonValue): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function recordAliasValue(record: ApplicationRecord, report: ResearchReport, field: string, value: JsonValue): JsonValue | undefined {
  if (field === "course_code") {
    const canonical = record.program_code ?? report.program_code;
    return canonical !== null && normalizedText(canonical) === normalizedText(value) ? canonical : undefined;
  }
  if (field === "verified_date") {
    const observedDay = normalizedText(value).slice(0, 10);
    return observedDay && observedDay === report.checked_at.slice(0, 10) ? report.checked_at : undefined;
  }
  if (field === "intake_month") {
    const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    const match = report.intake.match(/-(\d{2})(?:$|\D)/);
    const expected = match ? monthNames[Number(match[1]) - 1] : null;
    return expected && normalizedText(value) === expected ? report.intake : undefined;
  }
  if (field === "intake_term") {
    const term = normalizedText(value);
    const year = report.intake.match(/\b(20\d{2})\b/)?.[1];
    const firstSemester = /(?:-0?[1-6]\b|-s1\b)/i.test(report.intake);
    const secondSemester = /(?:-(?:0?[7-9]|1[0-2])\b|-s2\b)/i.test(report.intake);
    if (year && term.includes(year) && ((firstSemester && /(?:semester\s*1|s1)/.test(term)) || (secondSemester && /(?:semester\s*2|s2)/.test(term)))) {
      return report.intake;
    }
  }
  return undefined;
}

export async function compareApplicationUpdate(
  record: ApplicationRecord,
  report: ResearchReport,
  options: CompareOptions,
): Promise<UpdateResult> {
  const nextCheck = report.unresolved.length > 0
    ? record.monitoring.next_check ?? report.checked_at
    : addDays(report.checked_at, record.monitoring.check_interval_days);
  const facts: Record<string, ApplicationFact> = structuredClone(record.facts);
  const fieldChanges: FieldChange[] = [];
  const reviewItems: ReviewItem[] = [];
  let materialChange = false;

  for (const [field, finding] of Object.entries(report.findings)) {
    const risk = fieldRisk(field);
    const current = facts[field];
    const oldValue = current?.value ?? null;
    const sourceIds = toStringArray(finding.source_ids);
    const aliasValue = recordAliasValue(record, report, field, finding.value);

    if (aliasValue !== undefined) {
      fieldChanges.push({
        field,
        old_value: structuredClone(aliasValue),
        new_value: structuredClone(finding.value),
        confidence: finding.confidence,
        action: "no-change",
        reason: "该信息已由档案中的规范字段表达，不创建重复字段或审核。",
        source_ids: sourceIds,
      });
      continue;
    }

    const sameValue = deepEqual(oldValue, finding.value);

    if (finding.status === "unknown") {
      fieldChanges.push({
        field,
        old_value: structuredClone(oldValue),
        new_value: structuredClone(finding.value),
        confidence: finding.confidence,
        action: "ignore",
        reason: "新报告未确认该字段，保留现有值。",
        source_ids: sourceIds,
      });
      continue;
    }

    if (risk === "prior-confirmation") {
      const reviewId = await options.allocateReviewId();
      reviewItems.push({
        review_id: reviewId,
        schema_version: 1,
        source_module: "application-tracker",
        instance_id: report.instance_id,
        target: options.targetRecordPath,
        action: "confirm-user-action",
        proposed_value: {
          field,
          old_value: structuredClone(oldValue),
          new_value: structuredClone(finding.value),
          finding_status: finding.status,
          source_ids: sourceIds,
          report_id: report.report_id,
        },
        confidence: finding.confidence,
        priority: "high",
        status: "pending",
        reason: `Research observed ${field}, but only the user can confirm that this action actually occurred.`,
        evidence: [options.reportReference, ...sourceIds],
        created: options.now,
        review_after: null,
        decision: null,
        decision_history: [],
        target_observation: null,
        resolution: null,
      });
      fieldChanges.push({
        field,
        old_value: structuredClone(oldValue),
        new_value: structuredClone(finding.value),
        confidence: finding.confidence,
        action: "user-confirmation-required",
        reason: `Field ${field} records a real user action and cannot be inferred from research.`,
        source_ids: sourceIds,
      });
      continue;
    }

    if (risk === "unsupported") {
      fieldChanges.push({
        field,
        old_value: structuredClone(oldValue),
        new_value: structuredClone(finding.value),
        confidence: finding.confidence,
        action: "ignore",
        reason: "字段尚未在申请模块的数据契约中声明；信息保留在研究报告中，不写入正式档案。",
        source_ids: sourceIds,
      });
      continue;
    }

    if (sameValue) {
      facts[field] = updatedFact(current, finding, report, options.reportReference);
      fieldChanges.push({
        field,
        old_value: structuredClone(oldValue),
        new_value: structuredClone(finding.value),
        confidence: finding.confidence,
        action: "no-change",
        reason: "新旧值一致，仅刷新核验时间和来源。",
        source_ids: sourceIds,
      });
      continue;
    }

    const sufficientlySupported = finding.status === "confirmed" && finding.confidence >= 0.95;
    if ((risk === "automatic" || risk === "informational") && !sufficientlySupported) {
      fieldChanges.push({
        field,
        old_value: structuredClone(oldValue),
        new_value: structuredClone(finding.value),
        confidence: finding.confidence,
        action: "ignore",
        reason: "来源状态或置信度不足；信息保留在研究报告中，待后续核验，不创建低价值审核。",
        source_ids: sourceIds,
      });
      continue;
    }

    materialChange = true;
    const requiresReview = risk === "review-required";

    if (requiresReview) {
      const reviewId = await options.allocateReviewId();
      const statusSuggestion = proposedStatus(field, finding.value);
      const proposedValue: JsonObject = {
        field,
        old_value: structuredClone(oldValue),
        new_value: structuredClone(finding.value),
        finding_status: finding.status,
        source_ids: sourceIds,
        report_id: report.report_id,
      };
      if (statusSuggestion !== null) {
        proposedValue.application_status = statusSuggestion;
      }

      reviewItems.push({
        review_id: reviewId,
        schema_version: 1,
        source_module: "application-tracker",
        instance_id: report.instance_id,
        target: options.targetRecordPath,
        action: "change-critical-field",
        proposed_value: proposedValue,
        confidence: finding.confidence,
        priority: "high",
        status: "pending",
        reason: `关键字段 ${field} 发生变化，必须由用户确认。`,
        evidence: [options.reportReference, ...sourceIds],
        created: options.now,
        review_after: null,
        decision: null,
        decision_history: [],
        target_observation: null,
        resolution: null,
      });

      fieldChanges.push({
        field,
        old_value: structuredClone(oldValue),
        new_value: structuredClone(finding.value),
        confidence: finding.confidence,
        action: "review",
        reason: `字段 ${field} 需要人工审核。`,
        source_ids: sourceIds,
      });
      continue;
    }

    facts[field] = updatedFact(current, finding, report, options.reportReference);
    fieldChanges.push({
      field,
      old_value: structuredClone(oldValue),
      new_value: structuredClone(finding.value),
      confidence: finding.confidence,
      action: "auto-update",
      reason: "非关键字段由高置信度、已确认来源支持，允许自动更新。",
      source_ids: sourceIds,
    });
  }

  const sourceFiles = uniqueJsonValues([
    ...record.source_files,
    options.reportReference,
  ]);

  const changesSummary = fieldChanges
    .filter((change) => change.action !== "ignore")
    .map((change) => `${change.field}: ${change.action}`)
    .join("；");

  return {
    target_record: options.targetRecordPath,
    material_change: materialChange || report.material_change,
    field_changes: fieldChanges,
    frontmatter_patch: {
      monitoring: {
        last_checked: report.checked_at,
        next_check: nextCheck,
      },
      facts,
      source_files: sourceFiles,
      updated: options.now,
    },
    sections_to_append: [
      {
        section: "变更记录",
        content: `- ${report.checked_at.slice(0, 10)}：${report.summary}${changesSummary ? `（${changesSummary}）` : ""}`,
      },
    ],
    review_items: reviewItems,
    next_check: nextCheck,
  };
}
