import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseMarkdown, parseMarkdownBatch, validateSchemaBatch } from "../core/bridge.js";
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

test("batch Schema validation reuses only content-identical results", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-schema-cache-"));
  try {
    enablePerformanceDiagnostics();
    const valid = { item_id: "DSH-CACHE-1", source_module: "core", instance_id: null, category: "status", priority: "low", title: "Cache test", description: "Content-addressed validation fixture.", target: null, due_at: null, actions: ["open"], created_at: null, blocks_count: 0, active_context: false };
    const schemaId = "https://pkb.local/schemas/core/dashboard-item.schema.json";
    assert.equal(validateSchemaBatch(vault, [{ schemaId, data: valid }])[0]?.ok, true);
    resetPerformanceDiagnostics();
    assert.equal(validateSchemaBatch(vault, [{ schemaId, data: structuredClone(valid) }])[0]?.ok, true);
    assert.equal(performanceDiagnosticsSnapshot().python_subprocesses, 0);
    resetPerformanceDiagnostics();
    assert.equal(validateSchemaBatch(vault, [{ schemaId, data: { ...valid, title: "Changed" } }])[0]?.ok, true);
    assert.equal(performanceDiagnosticsSnapshot().python_subprocesses, 1);
  } finally {
    enablePerformanceDiagnostics(false);
    await fs.rm(vault, { recursive: true, force: true });
  }
});
