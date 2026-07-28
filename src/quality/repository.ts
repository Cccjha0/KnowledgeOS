import type { JsonObject } from "../core/types.js";
import { RuntimeRepository } from "../runtime/repository.js";
import type { ChangeRecord, EvidenceRecord, MetricEvent, QualityIssue, QualityIssueStatus } from "./domain.js";

export class QualityRepository {
  private constructor(private readonly runtime: RuntimeRepository) {}
  static async open(vaultRoot: string): Promise<QualityRepository> { return new QualityRepository(await RuntimeRepository.open(vaultRoot)); }
  close(): void { this.runtime.close(); }
  upsertEvidence(input: Omit<EvidenceRecord, "evidence_id"> & { evidence_id?: string }): EvidenceRecord { return this.runtime.upsertEvidence(input as JsonObject) as unknown as EvidenceRecord; }
  getEvidence(evidenceId: string): EvidenceRecord | null { return this.runtime.getEvidence(evidenceId) as unknown as EvidenceRecord | null; }
  listEvidence(limit = 100): EvidenceRecord[] { return this.runtime.listEvidence(limit) as unknown as EvidenceRecord[]; }
  upsertIssue(input: Omit<QualityIssue, "issue_id" | "first_seen" | "last_seen" | "occurrence_count"> & Partial<Pick<QualityIssue, "issue_id" | "first_seen" | "last_seen" | "occurrence_count">>): QualityIssue { return this.runtime.upsertQualityIssue(input as JsonObject) as unknown as QualityIssue; }
  listIssues(filters: { statuses?: QualityIssueStatus[]; severities?: string[]; modules?: string[]; instanceId?: string | null; limit?: number } = {}): QualityIssue[] { return this.runtime.listQualityIssues({ statuses: filters.statuses ?? [], severities: filters.severities ?? [], modules: filters.modules ?? [], instance_id: filters.instanceId ?? null, limit: filters.limit ?? 500 }) as unknown as QualityIssue[]; }
  updateIssue(issueId: string, status: QualityIssueStatus, patch: JsonObject = {}): QualityIssue { return this.runtime.updateQualityIssue({ issue_id: issueId, status, ...patch }) as unknown as QualityIssue; }
  recordMetric(input: Omit<MetricEvent, "metric_id"> & { metric_id?: string }): MetricEvent { return this.runtime.recordMetricEvent(input as JsonObject) as unknown as MetricEvent; }
  aggregateMetrics(since: string): JsonObject { return this.runtime.aggregateMetrics(since); }
  recordChange(input: Omit<ChangeRecord, "change_id"> & { change_id?: string }): ChangeRecord { return this.runtime.recordChange(input as JsonObject) as unknown as ChangeRecord; }
  listChanges(entityRef?: string, limit = 100): ChangeRecord[] { return this.runtime.listChanges({ entity_ref: entityRef ?? null, limit }) as unknown as ChangeRecord[]; }
  startAudit(frequency: string): JsonObject { return this.runtime.startQualityAudit(frequency); }
  finishAudit(auditId: string, status: "completed" | "failed", summary: JsonObject): JsonObject { return this.runtime.finishQualityAudit(auditId, status, summary); }
  listAudits(limit = 50): JsonObject[] { return this.runtime.listQualityAudits(limit); }
  rememberRejection(memory: JsonObject): JsonObject { return this.runtime.rememberReviewRejection(memory); }
  rejectionMemory(fingerprint: string): JsonObject | null { return this.runtime.getReviewRejection(fingerprint); }
}
