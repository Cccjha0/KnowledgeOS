import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseMarkdown, parseYaml } from "../core/bridge.js";

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
