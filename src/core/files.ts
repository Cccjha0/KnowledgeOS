import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { JsonObject, JsonValue } from "./types.js";
import { incrementPerformanceDiagnostic } from "./performanceDiagnostics.js";

export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function sha256File(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  if (!(await exists(filePath))) {
    return fallback;
  }
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const temp = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(temp, filePath);
}

export async function listFilesRecursive(root: string, suffix?: string): Promise<string[]> {
  if (!(await exists(root))) {
    return [];
  }
  const output: string[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await listFilesRecursive(absolute, suffix)));
    } else if (!suffix || entry.name.endsWith(suffix)) {
      incrementPerformanceDiagnostic("files_discovered");
      output.push(absolute);
    }
  }
  return output;
}

export function toVaultPath(vaultRoot: string, absolutePath: string): string {
  return path.relative(vaultRoot, absolutePath).split(path.sep).join("/");
}

export function fromVaultPath(vaultRoot: string, vaultPath: string): string {
  return path.resolve(vaultRoot, ...vaultPath.split("/"));
}

export function deepEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function deepMerge(base: JsonObject, patch: JsonObject): JsonObject {
  const result: JsonObject = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    const current = result[key];
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === "object" &&
      !Array.isArray(current)
    ) {
      result[key] = deepMerge(current as JsonObject, value as JsonObject);
    } else {
      result[key] = structuredClone(value);
    }
  }
  return result;
}

export function uniqueJsonValues(values: JsonValue[]): JsonValue[] {
  const seen = new Set<string>();
  const output: JsonValue[] = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (!seen.has(key)) {
      seen.add(key);
      output.push(value);
    }
  }
  return output;
}
