import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JsonObject } from "../core/types.js";

export interface CodexContextDocument {
  source_path: string;
  content: string;
  read_level?: number;
  content_mode?: "metadata" | "summary" | "full" | "sensitive";
}

export interface CodexContextBudget {
  max_files: number;
  max_total_bytes: number;
  max_file_bytes: number;
  max_estimated_tokens: number;
  overflow_policy: "truncate-and-review";
}

interface ContextInputManifest {
  source_path: string;
  context_path: string;
  sha256: string;
  bytes: number;
  original_bytes: number;
  truncated: boolean;
  read_level: number;
  content_mode: "metadata" | "summary" | "full" | "sensitive";
}

interface ContextBudgetManifest extends CodexContextBudget {
  candidate_files: number;
  included_files: number;
  excluded_file_count: number;
  excluded_files: Array<{ source_path: string; bytes: number; reason: "max-files" | "max-total-bytes" | "max-estimated-tokens" }>;
  total_bytes: number;
  estimated_tokens: number;
  truncated_file_count: number;
  truncated_files: Array<{ source_path: string; original_bytes: number; included_bytes: number; reason: "max-file-bytes" | "max-total-bytes" | "max-estimated-tokens" }>;
  review_required: boolean;
}

export interface CodexContextManifest {
  version: 3;
  primary_input: ContextInputManifest;
  related_inputs: ContextInputManifest[];
  allowed_read_roots: string[];
  max_read_level: number;
  budget: ContextBudgetManifest;
}

export interface CodexContextWorkspace {
  root: string;
  manifest: CodexContextManifest;
  cleanup(): Promise<void>;
}

function digest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function inputReadLevel(document: CodexContextDocument): number { return document.read_level ?? 0; }
function inputContentMode(document: CodexContextDocument): "metadata" | "summary" | "full" | "sensitive" {
  return document.content_mode ?? (inputReadLevel(document) === 0 ? "metadata" : inputReadLevel(document) === 1 ? "summary" : inputReadLevel(document) === 2 ? "full" : "sensitive");
}

function safeName(value: string, index: number): string {
  const base = path.basename(value).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "document.md";
  return `${String(index).padStart(3, "0")}-${base.endsWith(".md") ? base : `${base}.md`}`;
}

const DEFAULT_BUDGET: CodexContextBudget = {
  max_files: 50,
  max_total_bytes: 500_000,
  max_file_bytes: 50_000,
  max_estimated_tokens: 125_000,
  overflow_policy: "truncate-and-review",
};

function normalizeBudget(value: Partial<CodexContextBudget> | undefined): CodexContextBudget {
  const budget = { ...DEFAULT_BUDGET, ...(value ?? {}) };
  for (const key of ["max_files", "max_total_bytes", "max_file_bytes", "max_estimated_tokens"] as const) {
    if (!Number.isInteger(budget[key]) || budget[key] <= 0) throw new Error(`context_budget.${key} must be a positive integer.`);
  }
  if (budget.overflow_policy !== "truncate-and-review") throw new Error("context_budget.overflow_policy must be truncate-and-review.");
  return budget;
}

function truncateUtf8(content: string, limit: number): { content: string; truncated: boolean } {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length <= limit) return { content, truncated: false };
  if (limit <= 0) return { content: "", truncated: true };
  const marker = "\n\n[Truncated by KnowledgeOS context budget]\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (limit <= markerBytes) return { content: bytes.subarray(0, limit).toString("utf8"), truncated: true };
  let end = limit - markerBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { content: `${bytes.subarray(0, end).toString("utf8")}${marker}`, truncated: true };
}

/** Conservative cross-language estimate used to cap prompt context before Codex runs. */
function estimateTokens(byteCount: number): number {
  return Math.ceil(byteCount / 4);
}

async function writeText(root: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(root, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

const GLOBAL_RULES = `# KnowledgeOS context rules

You are running inside an isolated, read-only context workspace. Only files in this workspace are authorized inputs.

- Read only the files named below; do not look for other user files or infer facts that are not in these inputs.
- Treat primary-input.md as the task input and related/ as explicitly approved supporting context.
- Preserve uncertainty. Do not invent facts, dates, identifiers, or sources.
- Follow module-prompt.md and return only the required structured JSON result.
`;

export async function createCodexContextWorkspace(input: {
  modulePrompt: string;
  instanceContext: JsonObject;
  runtimeContext: JsonObject;
  primary: CodexContextDocument;
  related: CodexContextDocument[];
  allowedReadRoots: string[];
  maxReadLevel: number;
  budget?: Partial<CodexContextBudget>;
}): Promise<CodexContextWorkspace> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `knowledgeos-run-context-${process.pid}-${randomUUID()}-`));
  const primaryPath = "primary-input.md";
  const relatedManifest: CodexContextManifest["related_inputs"] = [];
  const budget = normalizeBudget(input.budget);
  const candidates = [input.primary, ...input.related];
  const included: Array<{ document: CodexContextDocument; content: string; originalBytes: number; truncated: boolean; reason: "max-file-bytes" | "max-total-bytes" | "max-estimated-tokens" | null }> = [];
  const excluded: ContextBudgetManifest["excluded_files"] = [];
  let totalBytes = 0;
  let estimatedTokens = 0;
  for (const document of candidates) {
    const originalBytes = Buffer.byteLength(document.content, "utf8");
    if (included.length >= budget.max_files) {
      excluded.push({ source_path: document.source_path, bytes: originalBytes, reason: "max-files" });
      continue;
    }
    const remaining = budget.max_total_bytes - totalBytes;
    if (remaining <= 0) {
      excluded.push({ source_path: document.source_path, bytes: originalBytes, reason: "max-total-bytes" });
      continue;
    }
    if (estimatedTokens >= budget.max_estimated_tokens) {
      excluded.push({ source_path: document.source_path, bytes: originalBytes, reason: "max-estimated-tokens" });
      continue;
    }
    const remainingTokenBytes = (budget.max_estimated_tokens - estimatedTokens) * 4;
    const perFileLimit = Math.min(budget.max_file_bytes, remaining, remainingTokenBytes);
    const truncated = truncateUtf8(document.content, perFileLimit);
    const includedBytes = Buffer.byteLength(truncated.content, "utf8");
    const reason = truncated.truncated
      ? perFileLimit === budget.max_file_bytes ? "max-file-bytes"
        : perFileLimit === remainingTokenBytes ? "max-estimated-tokens"
          : "max-total-bytes"
      : null;
    included.push({ document, content: truncated.content, originalBytes, truncated: truncated.truncated, reason });
    totalBytes += includedBytes;
    estimatedTokens += estimateTokens(includedBytes);
  }
  const primary = included.shift();
  if (!primary) throw new Error("context_budget excluded the primary input; increase max_total_bytes.");
  try {
    await writeText(root, "global-rules.md", GLOBAL_RULES);
    await writeText(root, "module-prompt.md", input.modulePrompt);
    // JSON is valid YAML; this keeps the documented context filename while
    // avoiding a second YAML serializer in the runtime path.
    await writeText(root, "instance-context.yaml", `${JSON.stringify(input.instanceContext, null, 2)}\n`);
    await writeText(root, "runtime-context.json", `${JSON.stringify(input.runtimeContext, null, 2)}\n`);
    await writeText(root, primaryPath, primary.content);
    for (const [index, item] of included.entries()) {
      const contextPath = `related/${safeName(item.document.source_path, index + 1)}`;
      await writeText(root, contextPath, item.content);
      relatedManifest.push({
        source_path: item.document.source_path,
        context_path: contextPath,
        sha256: digest(item.content),
        bytes: Buffer.byteLength(item.content, "utf8"),
        original_bytes: item.originalBytes,
        truncated: item.truncated,
        read_level: inputReadLevel(item.document),
        content_mode: inputContentMode(item.document),
      });
    }
    const truncatedFiles = [primary, ...included].flatMap((item) => item.truncated && item.reason
      ? [{ source_path: item.document.source_path, original_bytes: item.originalBytes, included_bytes: Buffer.byteLength(item.content, "utf8"), reason: item.reason }]
      : []);
    const manifest: CodexContextManifest = {
      version: 3,
      primary_input: {
        source_path: primary.document.source_path,
        context_path: primaryPath,
        sha256: digest(primary.content),
        bytes: Buffer.byteLength(primary.content, "utf8"),
        original_bytes: primary.originalBytes,
        truncated: primary.truncated,
        read_level: inputReadLevel(primary.document),
        content_mode: inputContentMode(primary.document),
      },
      related_inputs: relatedManifest,
      allowed_read_roots: [...input.allowedReadRoots],
      max_read_level: input.maxReadLevel,
      budget: {
        ...budget,
        candidate_files: candidates.length,
        included_files: 1 + included.length,
        excluded_file_count: excluded.length,
        excluded_files: excluded,
        total_bytes: totalBytes,
        estimated_tokens: estimatedTokens,
        truncated_file_count: truncatedFiles.length,
        truncated_files: truncatedFiles,
        review_required: excluded.length > 0 || truncatedFiles.length > 0,
      },
    };
    await writeText(root, "context-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
    return { root, manifest, cleanup: async () => { await fs.rm(root, { recursive: true, force: true }); } };
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
