import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseMarkdown, parseYaml, validateSchema, validateSchemaBatch } from "../core/bridge.js";

test("Python bridge normalizes implicit YAML dates and datetimes to ISO strings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-bridge-date-"));
  try {
    const markdownPath = path.join(root, "dated.md");
    await fs.writeFile(markdownPath, [
      "---",
      "created: 2026-08-04",
      "checked_at: 2026-08-04T09:30:00+08:00",
      "history:",
      "  - 2026-08-03",
      "---",
      "",
      "# Dated note",
      "",
    ].join("\n"), "utf8");
    const markdown = parseMarkdown(root, markdownPath);
    assert.equal(markdown.data.created, "2026-08-04");
    assert.equal(markdown.data.checked_at, "2026-08-04T09:30:00+08:00");
    assert.deepEqual(markdown.data.history, ["2026-08-03"]);

    const yamlPath = path.join(root, "dated.yaml");
    await fs.writeFile(yamlPath, "next_check: 2026-08-05\n", "utf8");
    assert.equal(parseYaml(root, yamlPath).next_check, "2026-08-05");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("batch schema validation preserves per-item Draft 2020-12 results", () => {
  const schema = "https://pkb.local/schemas/core/dashboard-item.schema.json";
  const valid = { item_id: "DSH-TEST-1", source_module: "core", instance_id: null, category: "action", priority: "medium",
    title: "Valid", description: "Synthetic", target: null, due_at: null, actions: ["open"], created_at: null, blocks_count: 0, active_context: true };
  const invalid = { ...valid, item_id: "invalid", priority: "unknown" };
  assert.doesNotThrow(() => validateSchema(path.resolve("."), schema, valid));
  assert.throws(() => validateSchema(path.resolve("."), schema, invalid));
  const batch = validateSchemaBatch(path.resolve("."), [{ schemaId: schema, data: valid }, { schemaId: schema, data: invalid }]);
  assert.equal(batch[0]?.ok, true);
  assert.equal(batch[1]?.ok, false);
  assert.equal(batch[1]?.errors.some((error) => error.path === "item_id" || error.path === "priority"), true);
});
