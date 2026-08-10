import type { ApplicationRecord, ResearchReport, UpdateResult } from "./types.js";
import { compareApplicationUpdate, type CompareOptions } from "./compare.js";

export interface ComparisonAdapter {
  readonly id: string;
  compare(
    record: ApplicationRecord,
    report: ResearchReport,
    options: CompareOptions,
  ): Promise<UpdateResult>;
}

/**
 * MVP 默认适配器：只比较已经结构化并通过 Schema 的字段。
 * 它不会联网，也不会推断报告中不存在的信息。
 */
export class DeterministicComparisonAdapter implements ComparisonAdapter {
  readonly id = "deterministic";

  compare(
    record: ApplicationRecord,
    report: ResearchReport,
    options: CompareOptions,
  ): Promise<UpdateResult> {
    return compareApplicationUpdate(record, report, options);
  }
}
