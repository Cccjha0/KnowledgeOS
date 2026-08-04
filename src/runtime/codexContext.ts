import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JsonObject } from "../core/types.js";

export interface CodexContextDocument {
  source_path: string;
  content: string;
}

export interface CodexContextManifest {
  version: 1;
  primary_input: { source_path: string; context_path: string; sha256: string; bytes: number };
  related_inputs: Array<{ source_path: string; context_path: string; sha256: string; bytes: number }>;
  allowed_read_roots: string[];
  max_read_level: number;
}

export interface CodexContextWorkspace {
  root: string;
  manifest: CodexContextManifest;
  cleanup(): Promise<void>;
}

function digest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function safeName(value: string, index: number): string {
  const base = path.basename(value).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "document.md";
  return `${String(index).padStart(3, "0")}-${base.endsWith(".md") ? base : `${base}.md`}`;
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
}): Promise<CodexContextWorkspace> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `knowledgeos-run-context-${process.pid}-${randomUUID()}-`));
  const primaryPath = "primary-input.md";
  const relatedManifest: CodexContextManifest["related_inputs"] = [];
  try {
    await writeText(root, "global-rules.md", GLOBAL_RULES);
    await writeText(root, "module-prompt.md", input.modulePrompt);
    // JSON is valid YAML; this keeps the documented context filename while
    // avoiding a second YAML serializer in the runtime path.
    await writeText(root, "instance-context.yaml", `${JSON.stringify(input.instanceContext, null, 2)}\n`);
    await writeText(root, "runtime-context.json", `${JSON.stringify(input.runtimeContext, null, 2)}\n`);
    await writeText(root, primaryPath, input.primary.content);
    for (const [index, document] of input.related.entries()) {
      const contextPath = `related/${safeName(document.source_path, index + 1)}`;
      await writeText(root, contextPath, document.content);
      relatedManifest.push({
        source_path: document.source_path,
        context_path: contextPath,
        sha256: digest(document.content),
        bytes: Buffer.byteLength(document.content, "utf8"),
      });
    }
    const manifest: CodexContextManifest = {
      version: 1,
      primary_input: {
        source_path: input.primary.source_path,
        context_path: primaryPath,
        sha256: digest(input.primary.content),
        bytes: Buffer.byteLength(input.primary.content, "utf8"),
      },
      related_inputs: relatedManifest,
      allowed_read_roots: [...input.allowedReadRoots],
      max_read_level: input.maxReadLevel,
    };
    await writeText(root, "context-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
    return { root, manifest, cleanup: async () => { await fs.rm(root, { recursive: true, force: true }); } };
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
