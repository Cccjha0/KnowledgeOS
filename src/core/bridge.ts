import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonObject, MarkdownDocument } from "./types.js";
import { PkbError } from "./errors.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOCUMENT_CACHE_LIMIT = 1_000;
const documentCache = new Map<string, { mtimeMs: number; size: number; value: MarkdownDocument }>();
const yamlCache = new Map<string, { mtimeMs: number; size: number; value: JsonObject }>();

function cached<T>(cache: Map<string, { mtimeMs: number; size: number; value: T }>, filePath: string): T | null {
  const stat = statSync(filePath);
  const entry = cache.get(filePath);
  if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) return null;
  cache.delete(filePath); cache.set(filePath, entry);
  return structuredClone(entry.value);
}

function remember<T>(cache: Map<string, { mtimeMs: number; size: number; value: T }>, filePath: string, value: T): T {
  const stat = statSync(filePath);
  cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value: structuredClone(value) });
  while (cache.size > DOCUMENT_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return structuredClone(value);
}

function invalidate(filePath: string): void { documentCache.delete(filePath); yamlCache.delete(filePath); }

function runBridge(
  vaultRoot: string,
  args: string[],
  input?: unknown,
): string {
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
  const hit = cached(documentCache, filePath);
  if (hit) return hit;
  const output = runBridge(vaultRoot, ["parse-markdown", filePath]);
  return remember(documentCache, filePath, JSON.parse(output) as MarkdownDocument);
}

export function parseMarkdownBatch(vaultRoot: string, filePaths: string[]): Map<string, MarkdownDocument | null> {
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
  const output = runBridge(ENGINE_ROOT, ["parse-validate-yaml-batch", ENGINE_ROOT], items);
  return JSON.parse(output) as JsonObject[];
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
  runBridge(vaultRoot, ["validate", ENGINE_ROOT, schemaId], data);
}
