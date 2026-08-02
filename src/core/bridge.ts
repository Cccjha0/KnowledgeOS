import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonObject, MarkdownDocument } from "./types.js";
import { PkbError } from "./errors.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

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
  const output = runBridge(vaultRoot, ["parse-markdown", filePath]);
  return JSON.parse(output) as MarkdownDocument;
}

export function writeMarkdown(
  vaultRoot: string,
  filePath: string,
  document: MarkdownDocument,
): void {
  runBridge(vaultRoot, ["write-markdown", filePath], document);
}

export function parseYaml(vaultRoot: string, filePath: string): JsonObject {
  const output = runBridge(vaultRoot, ["parse-yaml", filePath]);
  return JSON.parse(output) as JsonObject;
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
}

export function validateSchema(
  vaultRoot: string,
  schemaId: string,
  data: unknown,
): void {
  runBridge(vaultRoot, ["validate", ENGINE_ROOT, schemaId], data);
}
