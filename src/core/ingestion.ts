import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseYaml } from "./bridge.js";
import { PkbError } from "./errors.js";
import { ensureDir, fromVaultPath, sha256File, writeJsonAtomic } from "./files.js";
import type { JsonObject, JsonValue } from "./types.js";

export type IngestionFormat = "markdown" | "text" | "json" | "yaml" | "pdf" | "image";

export interface CaptureEnvelope extends JsonObject {
  schema_version: 1;
  capture_id: string;
  source_path: string;
  original_asset_ref: string;
  format: IngestionFormat;
  content_hash: string;
  sidecar_path: string;
  capture_path: string;
  extracted_text: string;
  metadata: JsonObject;
  structured_data: JsonObject | null;
  created_at: string;
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

function extractPdfText(source: string): { text: string; metadata: JsonObject } {
  const bridge = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "ingestion_bridge.py");
  const result = spawnSync("python", ["-X", "utf8", bridge, source], { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new PkbError("PDF_EXTRACTION_FAILED", result.stderr.trim() || result.error?.message || "PDF text extraction failed.");
  }
  try {
    const parsed = JSON.parse(result.stdout) as { text?: unknown; metadata?: unknown };
    return { text: typeof parsed.text === "string" ? parsed.text : "", metadata: parsed.metadata && typeof parsed.metadata === "object" && !Array.isArray(parsed.metadata) ? parsed.metadata as JsonObject : {} };
  } catch { throw new PkbError("PDF_EXTRACTION_FAILED", "PDF extraction returned invalid JSON."); }
}

/** Core-owned ingestion: modules consume the resulting Envelope/Sidecar, never mutate the original asset. */
export async function ingestAsset(vaultRoot: string, sourcePath: string): Promise<CaptureEnvelope> {
  const source = fromVaultPath(vaultRoot, sourcePath);
  const extension = path.extname(source).toLowerCase();
  const format = formatForExtension(extension);
  if (!format) throw new PkbError("INGESTION_FORMAT_UNSUPPORTED", `No Ingestion Adapter is registered for ${extension || "this file type"}.`);
  const stat = await fs.stat(source);
  const contentHash = await sha256File(source);
  const sidecarPath = `90-System/State/Sidecars/${contentHash}.json`;
  const capturePath = `90-System/State/Captures/${contentHash}.json`;
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
  const envelope: CaptureEnvelope = {
    schema_version: 1, capture_id: `CAP-${contentHash.slice(0, 24).toUpperCase()}`,
    source_path: sourcePath, original_asset_ref: sourcePath, format, content_hash: contentHash,
    sidecar_path: sidecarPath, capture_path: capturePath, extracted_text: extractedText,
    metadata, structured_data: structuredData, created_at: new Date().toISOString(),
  };
  await ensureDir(path.dirname(fromVaultPath(vaultRoot, sidecarPath)));
  await ensureDir(path.dirname(fromVaultPath(vaultRoot, capturePath)));
  await writeJsonAtomic(fromVaultPath(vaultRoot, sidecarPath), envelope);
  await writeJsonAtomic(fromVaultPath(vaultRoot, capturePath), envelope);
  return envelope;
}

export async function readCaptureEnvelope(vaultRoot: string, capturePath: string): Promise<CaptureEnvelope> {
  const parsed = JSON.parse(await fs.readFile(fromVaultPath(vaultRoot, capturePath), "utf8")) as CaptureEnvelope;
  if (parsed.schema_version !== 1 || typeof parsed.extracted_text !== "string" || typeof parsed.source_path !== "string") throw new PkbError("CAPTURE_ENVELOPE_INVALID", `Invalid Capture Envelope ${capturePath}.`);
  return parsed;
}

export function isAcceptedInput(module: JsonObject, format: IngestionFormat): boolean {
  const accepted = Array.isArray(module.accepted_inputs) ? module.accepted_inputs : ["markdown"];
  return accepted.includes(format);
}
