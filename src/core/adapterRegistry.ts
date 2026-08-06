import type { JsonObject } from "./types.js";

/** Formats a Module may declare in accepted_inputs. Availability is determined
 * by the Engine's installed local adapters, never by Manifest vocabulary. */
export type IngestionFormat = "markdown" | "text" | "json" | "yaml" | "pdf" | "pptx" | "docx" | "image" | "archive" | "email";

export interface IngestionAdapterDefinition extends JsonObject {
  format: IngestionFormat;
  adapter_id: string;
  adapter_version: string;
  available: boolean;
  supported_platforms: string[];
  extraction_modes: string[];
  locator_type: "line" | "page" | "slide" | "asset" | "none";
  max_file_size: number;
  extensions: string[];
}

const ALL_PLATFORMS = ["win32", "linux", "darwin"];

const ADAPTERS: readonly IngestionAdapterDefinition[] = [
  { format: "markdown", adapter_id: "markdown-frontmatter", adapter_version: "1.0.0", available: true, supported_platforms: ALL_PLATFORMS, extraction_modes: ["frontmatter", "full-text"], locator_type: "line", max_file_size: 20 * 1024 * 1024, extensions: [".md", ".markdown"] },
  { format: "text", adapter_id: "plain-text", adapter_version: "1.0.0", available: true, supported_platforms: ALL_PLATFORMS, extraction_modes: ["full-text"], locator_type: "line", max_file_size: 20 * 1024 * 1024, extensions: [".txt", ".text", ".csv"] },
  { format: "json", adapter_id: "json-structured", adapter_version: "1.0.0", available: true, supported_platforms: ALL_PLATFORMS, extraction_modes: ["structured-data", "full-text"], locator_type: "asset", max_file_size: 20 * 1024 * 1024, extensions: [".json"] },
  { format: "yaml", adapter_id: "yaml-structured", adapter_version: "1.0.0", available: true, supported_platforms: ALL_PLATFORMS, extraction_modes: ["structured-data", "full-text"], locator_type: "asset", max_file_size: 20 * 1024 * 1024, extensions: [".yaml", ".yml"] },
  { format: "pdf", adapter_id: "pdf-sidecar", adapter_version: "1.0.0", available: true, supported_platforms: ALL_PLATFORMS, extraction_modes: ["local-text", "page-text"], locator_type: "page", max_file_size: 100 * 1024 * 1024, extensions: [".pdf"] },
  { format: "pptx", adapter_id: "pptx-openxml", adapter_version: "1.0.0", available: true, supported_platforms: ALL_PLATFORMS, extraction_modes: ["slide-text", "speaker-notes", "image-references"], locator_type: "slide", max_file_size: 100 * 1024 * 1024, extensions: [".pptx"] },
  { format: "image", adapter_id: "image-metadata", adapter_version: "1.0.0", available: true, supported_platforms: ALL_PLATFORMS, extraction_modes: ["metadata-only"], locator_type: "asset", max_file_size: 100 * 1024 * 1024, extensions: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic"] },
  { format: "docx", adapter_id: "docx-openxml", adapter_version: "0.0.0", available: false, supported_platforms: [], extraction_modes: [], locator_type: "none", max_file_size: 0, extensions: [".docx"] },
  { format: "archive", adapter_id: "archive-safe-listing", adapter_version: "0.0.0", available: false, supported_platforms: [], extraction_modes: [], locator_type: "none", max_file_size: 0, extensions: [".zip", ".7z", ".tar", ".gz"] },
  { format: "email", adapter_id: "email-rfc822", adapter_version: "0.0.0", available: false, supported_platforms: [], extraction_modes: [], locator_type: "none", max_file_size: 0, extensions: [".eml", ".msg"] },
];

export function listIngestionAdapters(): readonly IngestionAdapterDefinition[] { return ADAPTERS; }
export function getIngestionAdapter(format: string): IngestionAdapterDefinition | null { return ADAPTERS.find((adapter) => adapter.format === format) ?? null; }
export function availableIngestionAdapter(format: string): IngestionAdapterDefinition | null {
  const adapter = getIngestionAdapter(format);
  return adapter?.available && adapter.supported_platforms.includes(process.platform) ? adapter : null;
}
export function adapterForExtension(extension: string): IngestionAdapterDefinition | null {
  const normalized = extension.toLowerCase();
  return ADAPTERS.find((adapter) => adapter.extensions.includes(normalized)) ?? null;
}
