import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMarkdown, parseYaml, writeMarkdown } from "./bridge.js";
import { PkbError } from "./errors.js";
import { ensureDir, exists, fromVaultPath, listFilesRecursive, sha256File, toVaultPath, writeJsonAtomic } from "./files.js";
import type { JsonObject, JsonValue } from "./types.js";
import { assertRepresentationLevel, assertSensitivityClass, defaultMaxRepresentation, resolveDocumentAccessPolicy, unclassifiedDocumentAccessPolicy, type AttachmentSensitivityClass, type ClassificationState, type DocumentAccessPolicy, type LegacyReadLevel, type RepresentationLevel, type SensitivityClass } from "./readLevels.js";

export type IngestionFormat = "markdown" | "text" | "json" | "yaml" | "pdf" | "image";
export type PdfExtractionStatus = "pending" | "completed" | "partial" | "empty" | "scanned" | "encrypted" | "corrupted" | "unsupported" | "failed";

export interface CaptureEnvelope extends JsonObject {
  schema_version: 3;
  asset_id: string;
  capture_id: string;
  source_path: string;
  original_asset_ref: string;
  format: IngestionFormat;
  content_hash: string;
  sidecar_path: string;
  /** `capture_path` remains as a task-contract alias for the canonical Sidecar. */
  capture_path: string;
  extraction_cache_path: string;
  companion_note_path: string;
  metadata: JsonObject;
  /** User-controlled privacy class, independent from the requested representation. */
  sensitivity_class: AttachmentSensitivityClass;
  /** Unclassified attachments may expose metadata only, never extracted text. */
  classification_state: ClassificationState;
  /** File-level cap on what any Workflow may receive. */
  access_policy: { max_representation: RepresentationLevel };
  policy_source: DocumentAccessPolicy["policy_source"];
  /** Preserved only when an old Sidecar used the overloaded read_level field. */
  legacy_read_level: LegacyReadLevel | null;
  created_at: string;
}

/** Volatile, re-creatable extraction payload. It is never duplicated into the Sidecar. */
export interface ExtractionCache extends JsonObject {
  schema_version: 1;
  asset_id: string;
  content_hash: string;
  extracted_text: string;
  structured_data: JsonObject | null;
  /** PDF text remains page-addressable without putting page contents in Runtime State metadata. */
  page_text: Array<{ page: number; text: string; characters: number }>;
  created_at: string;
  last_accessed_at: string;
  reference_count: number;
}

const EXTENSIONS: Record<string, IngestionFormat> = {
  ".md": "markdown", ".markdown": "markdown", ".txt": "text", ".text": "text", ".csv": "text",
  ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".pdf": "pdf",
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image", ".heic": "image",
};

export function formatForExtension(extension: string): IngestionFormat | null {
  return EXTENSIONS[extension.toLowerCase()] ?? null;
}

function asObject(value: JsonValue, message: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PkbError("INGESTION_STRUCTURED_INPUT_INVALID", message);
  return value as JsonObject;
}

const PDF_LIMITS = { maxPages: 200, maxTextChars: 500_000, maxPageTextChars: 50_000 } as const;

interface PdfBridgeResponse {
  text?: unknown;
  metadata?: unknown;
}

function assetId(contentHash: string): string { return `AST-${contentHash.slice(0, 24).toUpperCase()}`; }

function extractionCachePath(contentHash: string): string { return `90-System/Cache/Extractions/${contentHash}.json`; }
function legacyExtractionCachePath(contentHash: string): string { return `90-System/State/Extraction Cache/${contentHash}.json`; }

function companionNotePath(contentHash: string, sourcePath: string): string {
  const base = path.basename(sourcePath, path.extname(sourcePath)).replace(/[\\/:*?"<>|]+/g, "-").trim() || "attachment";
  return `30-Knowledge/Attachments/${base}-${contentHash.slice(0, 10)}.md`;
}

function extractionSummary(metadata: JsonObject, extractedText: string): JsonObject {
  const extraction = metadata.extraction;
  if (!extraction || typeof extraction !== "object" || Array.isArray(extraction)) return { ...metadata, extraction: { status: extractedText.trim() ? "completed" : "empty", text_available: Boolean(extractedText.trim()) } };
  const detail = extraction as JsonObject;
  const { page_text: _pageText, ...safeExtraction } = detail;
  return { ...metadata, extraction: { ...safeExtraction, text_available: Boolean(extractedText.trim()) } };
}

function extractionPages(metadata: JsonObject): ExtractionCache["page_text"] {
  const extraction = metadata.extraction;
  if (!extraction || typeof extraction !== "object" || Array.isArray(extraction)) return [];
  const pages = (extraction as JsonObject).page_text;
  if (!Array.isArray(pages)) return [];
  return pages.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const page = (value as JsonObject).page; const text = (value as JsonObject).text; const characters = (value as JsonObject).characters;
    return typeof page === "number" && typeof text === "string" ? [{ page, text, characters: typeof characters === "number" ? characters : text.length }] : [];
  });
}

function extractPdfText(source: string): { text: string; metadata: JsonObject } {
  const bridge = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "ingestion_bridge.py");
  const result = spawnSync("python", ["-X", "utf8", bridge, source, "--max-pages", String(PDF_LIMITS.maxPages), "--max-text-chars", String(PDF_LIMITS.maxTextChars), "--max-page-text-chars", String(PDF_LIMITS.maxPageTextChars)], { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new PkbError("PDF_EXTRACTION_FAILED", result.stderr.trim() || result.error?.message || "PDF text extraction failed.");
  }
  try {
    const parsed = JSON.parse(result.stdout) as PdfBridgeResponse;
    return { text: typeof parsed.text === "string" ? parsed.text : "", metadata: parsed.metadata && typeof parsed.metadata === "object" && !Array.isArray(parsed.metadata) ? parsed.metadata as JsonObject : {} };
  } catch { throw new PkbError("PDF_EXTRACTION_FAILED", "PDF extraction returned invalid JSON."); }
}

/** A PDF is eligible for module/Codex workflows only when it has usable local text. */
export interface PdfUsePolicy {
  accepted_statuses?: PdfExtractionStatus[];
  partial_policy?: "allow" | "review";
}

export const DEFAULT_PDF_USE_POLICY: Required<PdfUsePolicy> = {
  accepted_statuses: ["completed"],
  partial_policy: "review",
};

/** Parse only the documented, safe portion of a module PDF policy. */
export function parsePdfUsePolicy(value: unknown): PdfUsePolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as JsonObject;
  const accepted = Array.isArray(raw.accepted_statuses)
    ? raw.accepted_statuses.filter((status): status is PdfExtractionStatus => typeof status === "string" && ["pending", "completed", "partial", "empty", "scanned", "encrypted", "corrupted", "unsupported", "failed"].includes(status))
    : undefined;
  const partial = raw.partial_policy === "allow" || raw.partial_policy === "review" ? raw.partial_policy : undefined;
  return accepted || partial ? { ...(accepted ? { accepted_statuses: accepted } : {}), ...(partial ? { partial_policy: partial } : {}) } : null;
}

/** The Inbox and Workflow Runner both resolve this complete policy before use. */
export function effectivePdfUsePolicy(value: unknown): Required<PdfUsePolicy> {
  const policy = parsePdfUsePolicy(value);
  return {
    accepted_statuses: policy?.accepted_statuses ?? DEFAULT_PDF_USE_POLICY.accepted_statuses,
    partial_policy: policy?.partial_policy ?? DEFAULT_PDF_USE_POLICY.partial_policy,
  };
}

/** Resolve a module-declared policy; default safely stops partial extractions. */
export function pdfExtractionDecision(envelope: CaptureEnvelope, policy: PdfUsePolicy | null = null): { usable: boolean; requires_review: boolean; status: PdfExtractionStatus | null } {
  if (envelope.format !== "pdf") return { usable: true, requires_review: false, status: null };
  const extraction = envelope.metadata.extraction;
  const status = pdfExtractionStatus(envelope);
  const textAvailable = Boolean(extraction && typeof extraction === "object" && !Array.isArray(extraction) && (extraction as JsonObject).text_available === true);
  const effective = effectivePdfUsePolicy(policy);
  const accepted = new Set(effective.accepted_statuses);
  if (!status || !textAvailable || !accepted.has(status)) return { usable: false, requires_review: status === "partial", status };
  if (status === "partial" && effective.partial_policy !== "allow") return { usable: false, requires_review: true, status };
  return { usable: true, requires_review: false, status };
}

export function pdfExtractionIsUsable(envelope: CaptureEnvelope, policy: PdfUsePolicy | null = null): boolean {
  return pdfExtractionDecision(envelope, policy).usable;
}

export function pdfExtractionStatus(envelope: CaptureEnvelope): PdfExtractionStatus | null {
  if (envelope.format !== "pdf") return null;
  const extraction = envelope.metadata.extraction;
  const status = extraction && typeof extraction === "object" && !Array.isArray(extraction) ? (extraction as JsonObject).status : null;
  return typeof status === "string" ? status as PdfExtractionStatus : "failed";
}

/** Core-owned ingestion: modules consume the resulting Envelope/Sidecar, never mutate the original asset. */
export async function ingestAsset(vaultRoot: string, sourcePath: string, options: { sensitivityClass?: number; maxRepresentation?: RepresentationLevel; classificationState?: Exclude<ClassificationState, "unclassified">; /** @deprecated maps to sensitivityClass for legacy callers. */ readLevel?: number } = {}): Promise<CaptureEnvelope> {
  const source = fromVaultPath(vaultRoot, sourcePath);
  const extension = path.extname(source).toLowerCase();
  const format = formatForExtension(extension);
  if (!format) throw new PkbError("INGESTION_FORMAT_UNSUPPORTED", `No Ingestion Adapter is registered for ${extension || "this file type"}.`);
  const stat = await fs.stat(source);
  const contentHash = await sha256File(source);
  const sidecarPath = `90-System/State/Sidecars/${contentHash}.json`;
  const capturePath = sidecarPath;
  const cachePath = extractionCachePath(contentHash);
  const notePath = companionNotePath(contentHash, sourcePath);
  // The JSON Sidecar is Core-managed policy state. Users change it through
  // updateAssetAccessPolicy; the Companion Note is a synchronized UI surface.
  let persistedPolicy: DocumentAccessPolicy | undefined;
  try {
    const existing = JSON.parse(await fs.readFile(fromVaultPath(vaultRoot, sidecarPath), "utf8")) as JsonObject;
    persistedPolicy = resolveDocumentAccessPolicy(existing);
  } catch { /* First ingestion or an obsolete sidecar: use the safe default below. */ }
  let extractedText = "";
  let structuredData: JsonObject | null = null;
  let metadata: JsonObject = { extension, bytes: stat.size, modified_at: stat.mtime.toISOString() };
  if (format === "text") extractedText = await fs.readFile(source, "utf8");
  if (format === "json") {
    structuredData = asObject(JSON.parse(await fs.readFile(source, "utf8")) as JsonValue, "JSON Capture inputs must be objects.");
    extractedText = JSON.stringify(structuredData, null, 2);
  }
  if (format === "yaml") {
    structuredData = asObject(parseYaml(vaultRoot, source), "YAML Capture inputs must be objects.");
    extractedText = JSON.stringify(structuredData, null, 2);
  }
  if (format === "pdf") {
    const extracted = extractPdfText(source);
    extractedText = extracted.text; metadata = { ...metadata, ...extracted.metadata };
  }
  if (format === "image") metadata = { ...metadata, adapter: "image-metadata", extraction: "metadata-only", ocr: "not-run" };
  const cache: ExtractionCache = {
    schema_version: 1, asset_id: assetId(contentHash), content_hash: contentHash,
    extracted_text: extractedText, structured_data: structuredData, page_text: extractionPages(metadata), created_at: new Date().toISOString(), last_accessed_at: new Date().toISOString(), reference_count: 0,
  };
  const requestedSensitivity = options.sensitivityClass ?? options.readLevel;
  const explicitSensitivity = requestedSensitivity ?? (typeof persistedPolicy?.sensitivity_class === "number" ? persistedPolicy.sensitivity_class : 0);
  const hasExplicitPolicy = options.sensitivityClass !== undefined || options.maxRepresentation !== undefined || options.classificationState !== undefined;
  // A user-confirmed policy always wins over a module Inbox default on later
  // materialization. Otherwise an Inbox refresh could silently undo the
  // privacy choice that unblocked the task.
  const hasUserConfirmedPolicy = persistedPolicy?.classification_state === "classified" && persistedPolicy.policy_source === "explicit";
  const policy: DocumentAccessPolicy = hasUserConfirmedPolicy
    ? persistedPolicy!
    : hasExplicitPolicy
    ? {
        sensitivity_class: assertSensitivityClass(explicitSensitivity, "capture sensitivity_class"),
        max_representation: assertRepresentationLevel(options.maxRepresentation ?? defaultMaxRepresentation(assertSensitivityClass(explicitSensitivity, "capture sensitivity_class")), "capture access_policy.max_representation"),
        classification_state: options.classificationState ?? "classified",
        policy_source: options.classificationState === "inherited" ? "inherited" as const : "explicit" as const,
      }
    : persistedPolicy ?? unclassifiedDocumentAccessPolicy();
  const envelope: CaptureEnvelope = {
    schema_version: 3, asset_id: assetId(contentHash), capture_id: `CAP-${contentHash.slice(0, 24).toUpperCase()}`,
    source_path: sourcePath, original_asset_ref: sourcePath, format, content_hash: contentHash,
    sidecar_path: sidecarPath, capture_path: capturePath, extraction_cache_path: cachePath, companion_note_path: notePath,
    metadata: extractionSummary(metadata, extractedText), sensitivity_class: policy.sensitivity_class, classification_state: policy.classification_state,
    access_policy: { max_representation: policy.max_representation }, policy_source: policy.policy_source,
    legacy_read_level: options.readLevel === undefined && persistedPolicy?.legacy_read_level === undefined
      ? null : assertSensitivityClass(options.readLevel ?? persistedPolicy?.legacy_read_level ?? (typeof policy.sensitivity_class === "number" ? policy.sensitivity_class : 0), "legacy read_level"),
    created_at: new Date().toISOString(),
  };
  await ensureDir(path.dirname(fromVaultPath(vaultRoot, sidecarPath)));
  await ensureDir(path.dirname(fromVaultPath(vaultRoot, cachePath)));
  await writeJsonAtomic(fromVaultPath(vaultRoot, sidecarPath), envelope);
  await writeJsonAtomic(fromVaultPath(vaultRoot, cachePath), cache);
  if (!(await exists(fromVaultPath(vaultRoot, notePath)))) {
    await ensureDir(path.dirname(fromVaultPath(vaultRoot, notePath)));
    writeMarkdown(vaultRoot, fromVaultPath(vaultRoot, notePath), {
      data: {
        type: "attachment-note", asset_id: envelope.asset_id, asset_ref: `[[${sourcePath}]]`, source_path: sourcePath,
        content_hash: contentHash, format, sensitivity_class: envelope.sensitivity_class, classification_state: envelope.classification_state, access_policy: envelope.access_policy, policy_source: envelope.policy_source,
        access_policy_source_of_truth: "sidecar-core-api",
        extraction_status: pdfExtractionStatus(envelope) ?? "completed",
        extraction_cache_path: cachePath, created_at: envelope.created_at,
      },
      content: `# ${path.basename(sourcePath)}\n\n## 原始附件\n\n[[${sourcePath}]]\n\n## 文件信息\n\n- Asset ID: ${envelope.asset_id}\n- 内容哈希: ${contentHash}\n- 格式: ${format}\n${format === "pdf" ? `- 页数: ${String(envelope.metadata.pages ?? "未知")}\n` : ""}- 提取状态: ${String(pdfExtractionStatus(envelope) ?? "completed")}\n\n## 我的笔记\n\n\n## AI 摘要\n\n\n## 相关内容\n\n`,
    });
  }
  return envelope;
}

/**
 * The only supported mutation path for an asset's sensitivity/representation
 * policy. It keeps Core state authoritative and mirrors the result into the
 * visible Companion Note without touching user-authored note content.
 */
export async function updateAssetAccessPolicy(vaultRoot: string, capturePath: string, input: { sensitivity_class: number; max_representation: RepresentationLevel }): Promise<CaptureEnvelope> {
  const envelope = await readCaptureEnvelope(vaultRoot, capturePath);
  const updatedAt = new Date().toISOString();
  const updated: CaptureEnvelope = {
    ...envelope,
    sensitivity_class: assertSensitivityClass(input.sensitivity_class, "sensitivity_class"), classification_state: "classified",
    access_policy: { max_representation: assertRepresentationLevel(input.max_representation, "max_representation") },
    policy_source: "explicit",
    legacy_read_level: null,
    metadata: { ...envelope.metadata, policy_updated_at: updatedAt, policy_authority: "core-api" },
  };
  await writeJsonAtomic(fromVaultPath(vaultRoot, updated.sidecar_path), updated);
  const noteFile = fromVaultPath(vaultRoot, updated.companion_note_path);
  if (await exists(noteFile)) {
    const note = parseMarkdown(vaultRoot, noteFile);
    writeMarkdown(vaultRoot, noteFile, {
      data: { ...note.data, sensitivity_class: updated.sensitivity_class, classification_state: updated.classification_state, access_policy: updated.access_policy, policy_source: updated.policy_source, access_policy_source_of_truth: "sidecar-core-api", policy_updated_at: updatedAt },
      content: note.content,
    });
  }
  return updated;
}

export async function readCaptureEnvelope(vaultRoot: string, capturePath: string): Promise<CaptureEnvelope> {
  const parsed = JSON.parse(await fs.readFile(fromVaultPath(vaultRoot, capturePath), "utf8")) as JsonObject & { schema_version?: number; extracted_text?: unknown; structured_data?: unknown; source_path?: unknown; content_hash?: unknown };
  if (typeof parsed.source_path !== "string" || typeof parsed.content_hash !== "string") throw new PkbError("CAPTURE_ENVELOPE_INVALID", `Invalid Asset Metadata Sidecar ${capturePath}.`);
  if (parsed.schema_version === 1 && typeof parsed.extracted_text === "string") {
    // Compatibility for queued tasks created before the Sidecar/cache split.
    const hash = parsed.content_hash;
    return {
      schema_version: 3, asset_id: assetId(hash), capture_id: String(parsed.capture_id), source_path: parsed.source_path, original_asset_ref: String(parsed.original_asset_ref ?? parsed.source_path),
      format: parsed.format as IngestionFormat, content_hash: hash, sidecar_path: String(parsed.sidecar_path ?? capturePath), capture_path: capturePath,
      extraction_cache_path: String(parsed.capture_path ?? capturePath), companion_note_path: companionNotePath(hash, parsed.source_path),
      metadata: extractionSummary((parsed.metadata && typeof parsed.metadata === "object" && !Array.isArray(parsed.metadata) ? parsed.metadata : {}) as JsonObject, parsed.extracted_text),
      sensitivity_class: assertSensitivityClass(typeof parsed.read_level === "number" ? parsed.read_level : 0, "legacy capture read_level"), classification_state: "inherited", access_policy: { max_representation: "sensitive-original" }, policy_source: "legacy",
      legacy_read_level: typeof parsed.read_level === "number" ? assertSensitivityClass(parsed.read_level, "legacy capture read_level") : null, created_at: String(parsed.created_at ?? new Date().toISOString()),
    };
  }
  if (parsed.schema_version === 2 && typeof parsed.extraction_cache_path === "string") {
    const policy = resolveDocumentAccessPolicy(parsed);
    return {
      ...parsed, schema_version: 3, sensitivity_class: policy.sensitivity_class, classification_state: policy.classification_state, access_policy: { max_representation: policy.max_representation }, policy_source: policy.policy_source,
      legacy_read_level: policy.legacy_read_level ?? null,
    } as unknown as CaptureEnvelope;
  }
  if (parsed.schema_version !== 3 || typeof parsed.extraction_cache_path !== "string") throw new PkbError("CAPTURE_ENVELOPE_INVALID", `Invalid Asset Metadata Sidecar ${capturePath}.`);
  const policy = resolveDocumentAccessPolicy(parsed);
  return {
    ...parsed, sensitivity_class: policy.sensitivity_class, classification_state: policy.classification_state, access_policy: { max_representation: policy.max_representation }, policy_source: policy.policy_source,
    legacy_read_level: policy.legacy_read_level ?? null,
  } as unknown as CaptureEnvelope;
}

export async function readExtractionCache(vaultRoot: string, envelope: CaptureEnvelope): Promise<ExtractionCache> {
  const canonicalPath = extractionCachePath(envelope.content_hash);
  const candidates = [...new Set([canonicalPath, envelope.extraction_cache_path, legacyExtractionCachePath(envelope.content_hash)])];
  for (const candidate of candidates) try {
    const cachePath = fromVaultPath(vaultRoot, candidate);
    const parsed = JSON.parse(await fs.readFile(cachePath, "utf8")) as ExtractionCache & { schema_version?: number; extracted_text?: unknown; structured_data?: unknown; metadata?: unknown };
    if (parsed.schema_version === 1 && typeof parsed.extracted_text === "string" && !parsed.asset_id) {
      // A task queued before v2 stored its extraction in the legacy Capture;
      // use it once without copying the text into a new long-lived Sidecar.
      return { schema_version: 1, asset_id: envelope.asset_id, content_hash: envelope.content_hash, extracted_text: parsed.extracted_text,
        structured_data: parsed.structured_data && typeof parsed.structured_data === "object" && !Array.isArray(parsed.structured_data) ? parsed.structured_data as JsonObject : null,
        page_text: extractionPages(parsed.metadata && typeof parsed.metadata === "object" && !Array.isArray(parsed.metadata) ? parsed.metadata as JsonObject : {}), created_at: envelope.created_at, last_accessed_at: new Date().toISOString(), reference_count: 0 };
    }
    if (parsed.schema_version !== 1 || parsed.content_hash !== envelope.content_hash || typeof parsed.extracted_text !== "string") throw new Error("invalid extraction cache");
    const resolved: ExtractionCache = { schema_version: 1, asset_id: String(parsed.asset_id), content_hash: parsed.content_hash, extracted_text: parsed.extracted_text,
      structured_data: parsed.structured_data && typeof parsed.structured_data === "object" && !Array.isArray(parsed.structured_data) ? parsed.structured_data as JsonObject : null,
      page_text: Array.isArray(parsed.page_text) ? parsed.page_text as ExtractionCache["page_text"] : [], created_at: typeof parsed.created_at === "string" ? parsed.created_at : envelope.created_at,
      last_accessed_at: new Date().toISOString(), reference_count: typeof parsed.reference_count === "number" ? parsed.reference_count : 0 };
    await ensureDir(path.dirname(fromVaultPath(vaultRoot, canonicalPath)));
    await writeJsonAtomic(fromVaultPath(vaultRoot, canonicalPath), resolved);
    if (candidate !== canonicalPath) {
      await fs.rm(cachePath, { force: true });
      await writeJsonAtomic(fromVaultPath(vaultRoot, envelope.sidecar_path), { ...envelope, extraction_cache_path: canonicalPath });
    }
    return resolved;
  } catch { /* Try the next compatible cache location. */ }
  if (await exists(fromVaultPath(vaultRoot, envelope.source_path))) {
    const refreshed = await ingestAsset(vaultRoot, envelope.source_path, envelope.sensitivity_class === "unknown"
      ? {} : { sensitivityClass: envelope.sensitivity_class, maxRepresentation: envelope.access_policy.max_representation, classificationState: envelope.classification_state === "inherited" ? "inherited" : "classified" });
    if (refreshed.content_hash === envelope.content_hash) return readExtractionCache(vaultRoot, refreshed);
  }
  throw new PkbError("EXTRACTION_CACHE_UNAVAILABLE", `The extraction cache for ${envelope.source_path} is unavailable and the original asset cannot be re-ingested.`, { source_path: envelope.source_path, extraction_cache_path: envelope.extraction_cache_path });
}

export function evidenceLocator(envelope: CaptureEnvelope, pages: number[] = [], locator?: string): JsonObject {
  return { asset_id: envelope.asset_id, source_ref: `[[${envelope.companion_note_path}]]`, original_asset_ref: `[[${envelope.original_asset_ref}]]`, content_hash: envelope.content_hash, ...(pages.length ? { pages: [...new Set(pages)].sort((a, b) => a - b) } : {}), ...(locator ? { locator } : {}) };
}

/** Counts user-authored references, deliberately excluding the generated
 * Companion Note itself so it cannot keep an otherwise orphaned asset alive. */
export async function countAssetReferences(vaultRoot: string, envelope: CaptureEnvelope): Promise<number> {
  let count = 0;
  for (const root of [path.join(vaultRoot, "20-Workspace"), path.join(vaultRoot, "30-Knowledge")]) {
    if (!(await exists(root))) continue;
    for (const file of await listFilesRecursive(root, ".md")) {
      if (toVaultPath(vaultRoot, file) === envelope.companion_note_path) continue;
      const text = await fs.readFile(file, "utf8");
      if (text.includes(envelope.asset_id) || text.includes(envelope.source_path) || text.includes(envelope.content_hash)) count += 1;
    }
  }
  return count;
}

export async function cleanIngestionArtifacts(vaultRoot: string, options: { now?: Date; cacheRetentionDays?: number; maxCacheBytes?: number } = {}): Promise<JsonObject> {
  const now = options.now ?? new Date(); const retentionDays = options.cacheRetentionDays ?? 90; const maxCacheBytes = options.maxCacheBytes ?? 512 * 1024 * 1024;
  const sidecarRoot = path.join(vaultRoot, "90-System", "State", "Sidecars"); const cacheRoot = path.join(vaultRoot, "90-System", "Cache", "Extractions"); const legacyCacheRoot = path.join(vaultRoot, "90-System", "State", "Extraction Cache");
  let removedSidecars = 0; let removedCaches = 0; let referenceCounted = 0; let removedForSpace = 0;
  for (const file of await listFilesRecursive(sidecarRoot, ".json")) {
    let envelope: CaptureEnvelope; try { envelope = await readCaptureEnvelope(vaultRoot, toVaultPath(vaultRoot, file)); } catch { continue; }
    const originalExists = await exists(fromVaultPath(vaultRoot, envelope.source_path));
    const references = await countAssetReferences(vaultRoot, envelope); referenceCounted += 1;
    if (!originalExists && references === 0) {
      await fs.rm(file, { force: true });
      await fs.rm(fromVaultPath(vaultRoot, envelope.extraction_cache_path), { force: true });
      await fs.rm(fromVaultPath(vaultRoot, extractionCachePath(envelope.content_hash)), { force: true });
      await fs.rm(fromVaultPath(vaultRoot, legacyExtractionCachePath(envelope.content_hash)), { force: true });
      removedSidecars += 1; removedCaches += 1; continue;
    }
    if (Number(envelope.metadata.reference_count ?? -1) !== references) {
      envelope.metadata = { ...envelope.metadata, reference_count: references, reference_counted_at: now.toISOString() };
      await writeJsonAtomic(file, envelope);
    }
    const cacheFile = fromVaultPath(vaultRoot, extractionCachePath(envelope.content_hash));
    if (await exists(cacheFile)) {
      try {
        const cache = JSON.parse(await fs.readFile(cacheFile, "utf8")) as ExtractionCache;
        await writeJsonAtomic(cacheFile, { ...cache, reference_count: references });
      } catch { /* An invalid cache is disposable and handled by the cleanup pass below. */ }
    }
  }
  const cacheFiles = [...await listFilesRecursive(cacheRoot, ".json"), ...await listFilesRecursive(legacyCacheRoot, ".json")];
  for (const file of cacheFiles) {
    const stat = await fs.stat(file); if (now.getTime() - stat.mtimeMs <= retentionDays * 86_400_000) continue;
    await fs.rm(file, { force: true }); removedCaches += 1;
  }
  const retained = await listFilesRecursive(cacheRoot, ".json");
  const cacheStats = await Promise.all(retained.map(async (file) => {
    const stat = await fs.stat(file);
    let lastAccessedAt = "";
    try { lastAccessedAt = String((JSON.parse(await fs.readFile(file, "utf8")) as ExtractionCache).last_accessed_at ?? ""); } catch { /* Invalid caches sort by file time and are safely disposable. */ }
    return { file, stat, lastAccessedAt };
  }));
  let totalBytes = cacheStats.reduce((sum, item) => sum + item.stat.size, 0);
  for (const candidate of cacheStats.sort((left, right) => (Date.parse(left.lastAccessedAt) || left.stat.mtimeMs) - (Date.parse(right.lastAccessedAt) || right.stat.mtimeMs))) {
    if (totalBytes <= maxCacheBytes) break;
    await fs.rm(candidate.file, { force: true }); totalBytes -= candidate.stat.size; removedCaches += 1; removedForSpace += 1;
  }
  return { removed_sidecars: removedSidecars, removed_extraction_caches: removedCaches, removed_for_space: removedForSpace, reference_counted: referenceCounted, cache_retention_days: retentionDays, max_cache_bytes: maxCacheBytes, cache_bytes: totalBytes };
}

export function isAcceptedInput(module: JsonObject, format: IngestionFormat): boolean {
  const accepted = Array.isArray(module.accepted_inputs) ? module.accepted_inputs : ["markdown"];
  return accepted.includes(format);
}
