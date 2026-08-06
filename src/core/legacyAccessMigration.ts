import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseMarkdown, writeMarkdown } from "./bridge.js";
import { PkbError } from "./errors.js";
import { exists, fromVaultPath, listFilesRecursive, readJson, toVaultPath, writeJsonAtomic } from "./files.js";
import { createGitSnapshot } from "./git.js";
import { ingestAsset } from "./ingestion.js";
import { assertSensitivityClass, defaultMaxRepresentation, type RepresentationLevel, type SensitivityClass } from "./readLevels.js";
import type { JsonObject, JsonValue } from "./types.js";
import { QualityRepository } from "../quality/repository.js";

export type LegacyAccessMigrationAction = "preview" | "apply" | "rollback";

export interface LegacyAccessMigrationParams {
  action: LegacyAccessMigrationAction;
  preview_id?: string;
  reviewed_paths?: string[];
  confirm?: boolean;
}

interface LegacyCandidate extends JsonObject {
  path: string;
  kind: "markdown" | "sidecar";
  legacy_read_level: number;
  proposed: JsonObject;
  requires_review: boolean;
  review_reason: string | null;
  source_hash: string;
  migratable: boolean;
}

interface MigrationPreview extends JsonObject {
  migration_id: string;
  created_at: string;
  status: "preview" | "applied" | "rolled-back";
  candidates: LegacyCandidate[];
  summary: JsonObject;
  backup_path: string | null;
  git_snapshot: string | null;
}

const STATE_ROOT = "90-System/State/Migrations";
const SUMMARY_PATH = `${STATE_ROOT}/legacy-access-policy-summary.json`;
const SENSITIVE_PATH = /(?:^|\/)(?:journal|journals|private|medical|health|identity|passport|visa|transcript|recommendation|contract)(?:\/|$)/i;

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function previewPath(id: string): string { return `${STATE_ROOT}/legacy-access-policy-${id}.json`; }
function backupPath(id: string): string { return `${STATE_ROOT}/legacy-access-policy-${id}.backup.json`; }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function proposal(readLevel: number, target: string): { proposed: JsonObject; requiresReview: boolean; reason: string | null } {
  const legacy = assertSensitivityClass(readLevel, "legacy read_level");
  const sensitive = SENSITIVE_PATH.test(target.replace(/\\/g, "/"));
  const sensitivity: SensitivityClass = sensitive ? 3 : legacy;
  return {
    proposed: {
      sensitivity_class: sensitivity,
      classification_state: "classified",
      access_policy: { max_representation: sensitive ? "metadata" : defaultMaxRepresentation(sensitivity) },
      policy_source: "explicit",
      legacy_read_level: null,
    },
    requiresReview: sensitive,
    reason: sensitive ? "Sensitive directory: explicit user review is required before this legacy policy may be migrated." : null,
  };
}

function isLegacySidecar(raw: JsonObject): number | null {
  if (typeof raw.read_level === "number") return raw.read_level;
  if (raw.policy_source === "legacy" && typeof raw.legacy_read_level === "number") return raw.legacy_read_level;
  if (typeof raw.legacy_read_level === "number") return raw.legacy_read_level;
  return null;
}

async function scanLegacyPolicies(vaultRoot: string): Promise<LegacyCandidate[]> {
  const output: LegacyCandidate[] = [];
  for (const file of await listFilesRecursive(vaultRoot, ".md")) {
    const target = toVaultPath(vaultRoot, file);
    if (target.startsWith("90-System/") || target.startsWith(".obsidian/")) continue;
    try {
      const document = parseMarkdown(vaultRoot, file);
      if (typeof document.data.read_level !== "number") continue;
      const suggested = proposal(document.data.read_level, target);
      output.push({ path: target, kind: "markdown", legacy_read_level: document.data.read_level, proposed: suggested.proposed, requires_review: suggested.requiresReview, review_reason: suggested.reason, source_hash: digest(await fs.readFile(file, "utf8")), migratable: true });
    } catch { /* Invalid user Markdown is handled by the ordinary schema audit. */ }
  }
  const sidecarRoot = path.join(vaultRoot, "90-System", "State", "Sidecars");
  for (const file of await listFilesRecursive(sidecarRoot, ".json")) {
    try {
      const rawText = await fs.readFile(file, "utf8"); const raw = JSON.parse(rawText) as JsonObject;
      const level = isLegacySidecar(raw); if (level === null) continue;
      const sourcePath = typeof raw.source_path === "string" ? raw.source_path : toVaultPath(vaultRoot, file);
      const suggested = proposal(level, sourcePath);
      output.push({ path: toVaultPath(vaultRoot, file), kind: "sidecar", legacy_read_level: level, proposed: suggested.proposed, requires_review: suggested.requiresReview, review_reason: suggested.reason, source_hash: digest(rawText), migratable: typeof raw.source_path === "string" && await exists(fromVaultPath(vaultRoot, raw.source_path)) });
    } catch { /* Invalid sidecars remain visible to the normal sidecar/schema audit. */ }
  }
  return output.sort((a, b) => String(a.path).localeCompare(String(b.path)));
}

async function writeSummary(vaultRoot: string, candidates: LegacyCandidate[], lastPreviewId: string | null, lastMigrationStatus: MigrationPreview["status"] | null = null): Promise<JsonObject> {
  const summary = {
    updated_at: new Date().toISOString(),
    remaining: candidates.length,
    requires_review: candidates.filter((candidate) => candidate.requires_review).length,
    unmigratable: candidates.filter((candidate) => !candidate.migratable).length,
    last_preview_id: lastPreviewId,
    last_migration_status: lastMigrationStatus,
  };
  await writeJsonAtomic(fromVaultPath(vaultRoot, SUMMARY_PATH), summary);
  return summary;
}

export async function legacyAccessPolicyMigrationSummary(vaultRoot: string): Promise<JsonObject> {
  const cached = await readJson<JsonObject | null>(fromVaultPath(vaultRoot, SUMMARY_PATH), null);
  if (cached) return cached;
  const candidates = await scanLegacyPolicies(vaultRoot);
  return writeSummary(vaultRoot, candidates, null);
}

export async function previewLegacyAccessPolicyMigration(vaultRoot: string): Promise<JsonObject> {
  const migrationId = `LAPM-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  const candidates = await scanLegacyPolicies(vaultRoot);
  const preview: MigrationPreview = {
    migration_id: migrationId, created_at: new Date().toISOString(), status: "preview", candidates,
    summary: await writeSummary(vaultRoot, candidates, migrationId, "preview"), backup_path: null, git_snapshot: null,
  };
  await writeJsonAtomic(fromVaultPath(vaultRoot, previewPath(migrationId)), preview);
  return preview;
}

async function loadPreview(vaultRoot: string, id: string): Promise<MigrationPreview> {
  const preview = await readJson<MigrationPreview | null>(fromVaultPath(vaultRoot, previewPath(id)), null);
  if (!preview) throw new PkbError("LEGACY_ACCESS_MIGRATION_NOT_FOUND", `No Legacy Access Policy Migration preview exists for ${id}.`);
  return preview;
}

export async function applyLegacyAccessPolicyMigration(vaultRoot: string, params: LegacyAccessMigrationParams): Promise<JsonObject> {
  if (!params.preview_id || !params.confirm) throw new PkbError("LEGACY_ACCESS_MIGRATION_CONFIRMATION_REQUIRED", "Applying a Legacy Access Policy Migration requires preview_id and confirm: true.");
  const preview = await loadPreview(vaultRoot, params.preview_id);
  if (preview.status !== "preview") throw new PkbError("LEGACY_ACCESS_MIGRATION_NOT_APPLICABLE", `Migration ${preview.migration_id} is ${preview.status}.`);
  const reviewed = new Set(params.reviewed_paths ?? []);
  const blocked = preview.candidates.filter((candidate) => candidate.requires_review && !reviewed.has(candidate.path));
  if (blocked.length) throw new PkbError("LEGACY_ACCESS_MIGRATION_REVIEW_REQUIRED", "Sensitive legacy files require an explicit review decision before migration.", { paths: blocked.map((candidate) => candidate.path) });
  const unmigratable = preview.candidates.filter((candidate) => !candidate.migratable);
  if (unmigratable.length) throw new PkbError("LEGACY_ACCESS_MIGRATION_SOURCE_MISSING", "Some legacy Sidecars no longer have their original asset and cannot be safely migrated automatically.", { paths: unmigratable.map((candidate) => candidate.path) });
  const changed: JsonObject[] = [];
  for (const candidate of preview.candidates) {
    const file = fromVaultPath(vaultRoot, candidate.path);
    const current = await fs.readFile(file, "utf8");
    if (digest(current) !== candidate.source_hash) throw new PkbError("LEGACY_ACCESS_MIGRATION_STALE_PREVIEW", `File changed after preview: ${candidate.path}. Create a new preview.`, { path: candidate.path });
    changed.push({ path: candidate.path, kind: candidate.kind, original: current });
  }
  const snapshot = await createGitSnapshot(vaultRoot, preview.migration_id);
  const backup = { migration_id: preview.migration_id, created_at: new Date().toISOString(), files: changed };
  const savedBackupPath = backupPath(preview.migration_id);
  await writeJsonAtomic(fromVaultPath(vaultRoot, savedBackupPath), backup);
  for (const candidate of preview.candidates) {
    const file = fromVaultPath(vaultRoot, candidate.path);
    const proposed = candidate.proposed;
    if (candidate.kind === "markdown") {
      const document = parseMarkdown(vaultRoot, file);
      const data = { ...document.data, ...proposed, _access_policy_migration: { migration_id: preview.migration_id, migrated_at: new Date().toISOString(), previous_read_level: candidate.legacy_read_level } } as JsonObject;
      delete data.read_level;
      writeMarkdown(vaultRoot, file, { data, content: document.content });
    } else {
      const raw = JSON.parse(await fs.readFile(file, "utf8")) as JsonObject;
      const sourcePath = typeof raw.source_path === "string" ? raw.source_path : null;
      if (!sourcePath) throw new PkbError("LEGACY_ACCESS_MIGRATION_SOURCE_MISSING", `Sidecar has no original source: ${candidate.path}.`);
      const migrated = await ingestAsset(vaultRoot, sourcePath, {
        sensitivityClass: Number(proposed.sensitivity_class),
        maxRepresentation: (proposed.access_policy as JsonObject).max_representation as RepresentationLevel,
        classificationState: "classified",
      });
      const refreshed = JSON.parse(await fs.readFile(fromVaultPath(vaultRoot, migrated.sidecar_path), "utf8")) as JsonObject;
      delete refreshed.read_level;
      await writeJsonAtomic(fromVaultPath(vaultRoot, migrated.sidecar_path), { ...refreshed, legacy_read_level: null, policy_migration: { migration_id: preview.migration_id, migrated_at: new Date().toISOString(), previous_read_level: candidate.legacy_read_level } });
    }
  }
  const quality = await QualityRepository.open(vaultRoot);
  try {
    const changedAt = new Date().toISOString();
    for (const candidate of preview.candidates) quality.recordChange({
      entity_ref: `[[${candidate.path}]]`, field: "access_policy",
      old_value: { read_level: candidate.legacy_read_level, policy_source: "legacy" }, new_value: candidate.proposed,
      reason: `Legacy Access Policy Migration ${preview.migration_id}.`, evidence_refs: [], generation: null,
      review: { status: candidate.requires_review ? "user-reviewed" : "system-migration", reviewed_by: candidate.requires_review ? "user" : "system", reviewed_at: changedAt }, changed_at: changedAt,
    });
  } finally { quality.close(); }
  const remaining = await scanLegacyPolicies(vaultRoot);
  preview.status = "applied"; preview.backup_path = savedBackupPath; preview.git_snapshot = snapshot; preview.summary = await writeSummary(vaultRoot, remaining, preview.migration_id, "applied");
  await writeJsonAtomic(fromVaultPath(vaultRoot, previewPath(preview.migration_id)), preview);
  return { status: "applied", migration_id: preview.migration_id, git_snapshot: snapshot, changed: changed.length, remaining: remaining.length, backup_path: savedBackupPath };
}

export async function rollbackLegacyAccessPolicyMigration(vaultRoot: string, id: string, confirm: boolean): Promise<JsonObject> {
  if (!confirm) throw new PkbError("LEGACY_ACCESS_MIGRATION_CONFIRMATION_REQUIRED", "Rolling back a Legacy Access Policy Migration requires confirm: true.");
  const preview = await loadPreview(vaultRoot, id);
  if (preview.status !== "applied" || !preview.backup_path) throw new PkbError("LEGACY_ACCESS_MIGRATION_NOT_APPLICABLE", `Migration ${id} has not been applied.`);
  const backup = await readJson<{ files?: Array<{ path: string; original: string }> }>(fromVaultPath(vaultRoot, preview.backup_path), {});
  for (const file of backup.files ?? []) await fs.writeFile(fromVaultPath(vaultRoot, file.path), file.original, "utf8");
  const quality = await QualityRepository.open(vaultRoot);
  try {
    const changedAt = new Date().toISOString();
    for (const candidate of preview.candidates) quality.recordChange({
      entity_ref: `[[${candidate.path}]]`, field: "access_policy", old_value: candidate.proposed,
      new_value: { read_level: candidate.legacy_read_level, policy_source: "legacy" }, reason: `Rolled back Legacy Access Policy Migration ${preview.migration_id}.`, evidence_refs: [], generation: null,
      review: { status: "user-direct", reviewed_by: "user", reviewed_at: changedAt }, changed_at: changedAt,
    });
  } finally { quality.close(); }
  const remaining = await scanLegacyPolicies(vaultRoot);
  preview.status = "rolled-back"; preview.summary = await writeSummary(vaultRoot, remaining, preview.migration_id, "rolled-back");
  await writeJsonAtomic(fromVaultPath(vaultRoot, previewPath(preview.migration_id)), preview);
  return { status: "rolled-back", migration_id: id, restored: (backup.files ?? []).length, remaining: remaining.length };
}
