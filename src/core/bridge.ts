import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonObject, MarkdownDocument } from "./types.js";
import { PkbError } from "./errors.js";
import { incrementPerformanceDiagnostic } from "./performanceDiagnostics.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOCUMENT_CACHE_LIMIT = 1_000;
const documentCache = new Map<string, { mtimeMs: number; size: number; value: MarkdownDocument }>();
const yamlCache = new Map<string, { mtimeMs: number; size: number; value: JsonObject }>();
const validatedYamlCache = new Map<string, { mtimeMs: number; size: number; value: JsonObject }>();

function schemaRegistryRevision(): string {
  const entries: string[] = [];
  const visit = (root: string): void => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const absolute = path.join(root, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.name.endsWith(".schema.json")) {
        const stat = statSync(absolute);
        entries.push(`${absolute}:${stat.mtimeMs}:${stat.size}`);
      }
    }
  };
  visit(path.join(ENGINE_ROOT, "core", "schemas"));
  visit(path.join(ENGINE_ROOT, "modules"));
  return entries.sort().join("|");
}

function cached<T>(cache: Map<string, { mtimeMs: number; size: number; value: T }>, filePath: string): T | null {
  const stat = statSync(filePath);
  const entry = cache.get(filePath);
  if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
    incrementPerformanceDiagnostic("parse_cache_misses");
    return null;
  }
  incrementPerformanceDiagnostic("parse_cache_hits");
  cache.delete(filePath); cache.set(filePath, entry);
  return structuredClone(entry.value);
}

function remember<T>(cache: Map<string, { mtimeMs: number; size: number; value: T }>, filePath: string, value: T): T {
  const stat = statSync(filePath);
  cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value: structuredClone(value) });
  while (cache.size > DOCUMENT_CACHE_LIMIT) {
    cache.delete(cache.keys().next().value!);
    incrementPerformanceDiagnostic("parse_cache_evictions");
  }
  return structuredClone(value);
}

function invalidate(filePath: string): void { documentCache.delete(filePath); yamlCache.delete(filePath); }

function runBridge(
  vaultRoot: string,
  args: string[],
  input?: unknown,
): string {
  incrementPerformanceDiagnostic("python_subprocesses");
  const bridge = path.join(ENGINE_ROOT, "tools", "pkb_bridge.py");
  const result = spawnSync("python", ["-X", "utf8", bridge, ...args], {
    cwd: vaultRoot,
    encoding: "utf8",
    input: input === undefined ? undefined : JSON.stringify(input),
    maxBuffer: 32 * 1024 * 1024,
  });

  if (result.error) {
    throw new PkbError("PYTHON_BRIDGE_FAILED", result.error.message, result.error);
  }
  if (result.status !== 0) {
    let details: unknown = result.stderr.trim();
    try {
      details = JSON.parse(result.stderr.trim());
    } catch {
      // Keep raw stderr.
    }
    throw new PkbError(
      "PYTHON_BRIDGE_FAILED",
      `Python bridge exited with status ${result.status ?? "unknown"}: ${
        typeof details === "string" ? details : JSON.stringify(details)
      }`,
      details,
    );
  }
  return result.stdout.trim();
}

export function parseMarkdown(vaultRoot: string, filePath: string): MarkdownDocument {
  incrementPerformanceDiagnostic("markdown_parse_requests");
  const hit = cached(documentCache, filePath);
  if (hit) return hit;
  const output = runBridge(vaultRoot, ["parse-markdown", filePath]);
  incrementPerformanceDiagnostic("markdown_files_parsed");
  return remember(documentCache, filePath, JSON.parse(output) as MarkdownDocument);
}

export function parseMarkdownBatch(vaultRoot: string, filePaths: string[]): Map<string, MarkdownDocument | null> {
  incrementPerformanceDiagnostic("markdown_parse_requests");
  const result = new Map<string, MarkdownDocument | null>();
  const misses: string[] = [];
  for (const filePath of filePaths) {
    try {
      const hit = cached(documentCache, filePath);
      if (hit) result.set(filePath, hit);
      else misses.push(filePath);
    } catch { result.set(filePath, null); }
  }
  if (!misses.length) return result;
  incrementPerformanceDiagnostic("markdown_files_parsed", misses.length);
  const output = JSON.parse(runBridge(vaultRoot, ["parse-markdown-batch"], misses)) as Array<{
    ok: boolean;
    path: string | null;
    document?: MarkdownDocument;
  }>;
  for (const entry of output) {
    if (!entry.path) continue;
    if (!entry.ok || !entry.document) result.set(entry.path, null);
    else result.set(entry.path, remember(documentCache, entry.path, entry.document));
  }
  for (const filePath of misses) if (!result.has(filePath)) result.set(filePath, null);
  return result;
}

export function writeMarkdown(
  vaultRoot: string,
  filePath: string,
  document: MarkdownDocument,
): void {
  runBridge(vaultRoot, ["write-markdown", filePath], document);
  invalidate(filePath);
}

export function parseYaml(vaultRoot: string, filePath: string): JsonObject {
  incrementPerformanceDiagnostic("yaml_parse_requests");
  const hit = cached(yamlCache, filePath);
  if (hit) return hit;
  const output = runBridge(vaultRoot, ["parse-yaml", filePath]);
  return remember(yamlCache, filePath, JSON.parse(output) as JsonObject);
}

export function parseValidateYamlBatch(
  _vaultRoot: string,
  items: Array<{ path: string; schema_id: string }>,
): JsonObject[] {
  if (items.length === 0) return [];
  const schemaRevision = schemaRegistryRevision();
  const results: Array<JsonObject | null> = Array.from({ length: items.length }, () => null);
  const misses: Array<{ index: number; path: string; schema_id: string; key: string }> = [];
  for (const [index, item] of items.entries()) {
    const key = `${item.path}\0${item.schema_id}\0${schemaRevision}`;
    const stat = statSync(item.path);
    const entry = validatedYamlCache.get(key);
    if (entry && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size) {
      incrementPerformanceDiagnostic("parse_cache_hits");
      validatedYamlCache.delete(key); validatedYamlCache.set(key, entry);
      results[index] = structuredClone(entry.value);
    } else {
      incrementPerformanceDiagnostic("parse_cache_misses");
      misses.push({ index, ...item, key });
    }
  }
  if (misses.length) {
    incrementPerformanceDiagnostic("yaml_parse_requests", misses.length);
    incrementPerformanceDiagnostic("schema_validations", misses.length);
    const output = runBridge(ENGINE_ROOT, ["parse-validate-yaml-batch", ENGINE_ROOT], misses.map(({ path: filePath, schema_id }) => ({ path: filePath, schema_id })));
    const parsed = JSON.parse(output) as JsonObject[];
    for (const [offset, miss] of misses.entries()) {
      const value = parsed[offset];
      if (!value) throw new PkbError("PYTHON_BRIDGE_FAILED", `Batch validation omitted item ${miss.index}.`);
      const originalStat = statSync(miss.path);
      validatedYamlCache.set(miss.key, { mtimeMs: originalStat.mtimeMs, size: originalStat.size, value: structuredClone(value) });
      while (validatedYamlCache.size > DOCUMENT_CACHE_LIMIT) {
        validatedYamlCache.delete(validatedYamlCache.keys().next().value!);
        incrementPerformanceDiagnostic("parse_cache_evictions");
      }
      results[miss.index] = structuredClone(value);
    }
  }
  return results.map((value, index) => value ?? (() => { throw new PkbError("PYTHON_BRIDGE_FAILED", `Batch validation omitted item ${index}.`); })());
}

export function writeYaml(vaultRoot: string, filePath: string, data: JsonObject): void {
  runBridge(vaultRoot, ["write-yaml", filePath], data);
  invalidate(filePath);
}

export function validateSchema(
  vaultRoot: string,
  schemaId: string,
  data: unknown,
): void {
  incrementPerformanceDiagnostic("schema_validations");
  runBridge(vaultRoot, ["validate", ENGINE_ROOT, schemaId], data);
}
