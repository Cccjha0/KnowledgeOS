import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { exists, listFilesRecursive } from "../core/files.js";

const GENERATED_READINESS_ARTIFACTS = new Set([
  "package-metadata.json",
  "validation-report.json",
  "module-test-report.json",
  "sandbox-report.json",
]);

/** Hash only authored module content, never generated readiness evidence. */
export async function moduleContentChecksum(root: string): Promise<string> {
  const digest = createHash("sha256");
  for (const file of (await listFilesRecursive(root)).sort()) {
    const relative = path.relative(root, file).replaceAll(path.sep, "/");
    if (GENERATED_READINESS_ARTIFACTS.has(relative)) continue;
    digest.update(relative);
    digest.update(await fs.readFile(file));
  }
  return `sha256:${digest.digest("hex")}`;
}

export async function fileChecksum(file: string): Promise<string> {
  return `sha256:${createHash("sha256").update(await fs.readFile(file)).digest("hex")}`;
}

export async function fixtureChecksum(moduleRoot: string): Promise<string> {
  const fixtureRoot = path.join(moduleRoot, "fixtures", "sample-instance");
  if (!(await exists(fixtureRoot))) return "missing";
  const digest = createHash("sha256");
  for (const file of (await listFilesRecursive(fixtureRoot)).sort()) {
    digest.update(path.relative(fixtureRoot, file).replaceAll(path.sep, "/"));
    digest.update(await fs.readFile(file));
  }
  return `sha256:${digest.digest("hex")}`;
}

export async function engineProvenance(engineRoot: string): Promise<{ engine_version: string; engine_commit: string | null }> {
  let engineVersion = "unknown";
  try { engineVersion = String((JSON.parse(await fs.readFile(path.join(engineRoot, "package.json"), "utf8")) as { version?: string }).version ?? "unknown"); }
  catch { /* Package metadata still records an explicit unknown value. */ }
  try {
    const commit = execFileSync("git", ["-C", engineRoot, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();
    return { engine_version: engineVersion, engine_commit: commit || null };
  } catch {
    return { engine_version: engineVersion, engine_commit: null };
  }
}
