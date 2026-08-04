import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";
import { createCodexContextWorkspace } from "../runtime/codexContext.js";

test("Codex context workspace copies only approved inputs and is removed after the run", async () => {
  const context = await createCodexContextWorkspace({
    modulePrompt: "Return a JSON object.",
    instanceContext: { instance_id: "demo" },
    runtimeContext: { task_id: "TASK-2026-000001" },
    primary: { source_path: "20-Workspace/Demo/Inbox/input.md", content: "# Approved input\n" },
    related: [{ source_path: "20-Workspace/Demo/Records/record.md", content: "# Approved related record\n" }],
    allowedReadRoots: ["20-Workspace/Demo"],
    maxReadLevel: 0,
  });
  try {
    assert.match(await fs.readFile(`${context.root}/primary-input.md`, "utf8"), /Approved input/);
    assert.match(await fs.readFile(`${context.root}/related/001-record.md`, "utf8"), /Approved related record/);
    const manifest = JSON.parse(await fs.readFile(`${context.root}/context-manifest.json`, "utf8")) as { primary_input: { source_path: string }; related_inputs: unknown[]; };
    assert.equal(manifest.primary_input.source_path, "20-Workspace/Demo/Inbox/input.md");
    assert.equal(manifest.related_inputs.length, 1);
  } finally {
    await context.cleanup();
  }
  await assert.rejects(fs.access(context.root));
});
