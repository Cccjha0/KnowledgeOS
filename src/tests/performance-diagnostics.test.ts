import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseMarkdown, parseMarkdownBatch } from "../core/bridge.js";
import { listFilesRecursive } from "../core/files.js";
import { enablePerformanceDiagnostics, performanceDiagnosticsSnapshot, resetPerformanceDiagnostics } from "../core/performanceDiagnostics.js";

test("performance diagnostics count structure without recording paths or content", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-perf-diagnostics-"));
  try {
    const first = path.join(root, "first.md"); const second = path.join(root, "second.md");
    await fs.writeFile(first, "---\ntitle: Synthetic secret marker\n---\nbody", "utf8");
    await fs.writeFile(second, "---\ntitle: Second\n---\nbody", "utf8");
    enablePerformanceDiagnostics(); resetPerformanceDiagnostics();
    parseMarkdown(root, first);
    parseMarkdown(root, first);
    parseMarkdownBatch(root, [first, second]);
    await listFilesRecursive(root, ".md");
    const snapshot = performanceDiagnosticsSnapshot();
    assert.equal(snapshot.python_subprocesses, 2);
    assert.equal(snapshot.markdown_parse_requests, 3);
    assert.equal(snapshot.markdown_files_parsed, 2);
    assert.equal(snapshot.parse_cache_hits, 2);
    assert.equal(snapshot.parse_cache_misses, 2);
    assert.equal(snapshot.files_discovered, 2);
    assert.doesNotMatch(JSON.stringify(snapshot), /Synthetic secret marker|first\.md/);
  } finally { enablePerformanceDiagnostics(false); await fs.rm(root, { recursive: true, force: true }); }
});
