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
    maxSensitivityClass: 0,
  });
  try {
    assert.match(await fs.readFile(`${context.root}/primary-input.md`, "utf8"), /Approved input/);
    assert.match(await fs.readFile(`${context.root}/related/001-record.md`, "utf8"), /Approved related record/);
    const manifest = JSON.parse(await fs.readFile(`${context.root}/context-manifest.json`, "utf8")) as { primary_input: { source_path: string; sensitivity_class: number; requested_representation: string; representation: string }; related_inputs: unknown[]; };
    assert.equal(manifest.primary_input.source_path, "20-Workspace/Demo/Inbox/input.md");
    assert.equal(manifest.primary_input.sensitivity_class, 0);
    assert.equal(manifest.primary_input.requested_representation, "metadata");
    assert.equal(manifest.primary_input.representation, "metadata");
    assert.equal(manifest.related_inputs.length, 1);
  } finally {
    await context.cleanup();
  }
  await assert.rejects(fs.access(context.root));
});

test("Codex context budgets cap copied data and surface overflow for review", async () => {
  const context = await createCodexContextWorkspace({
    modulePrompt: "Return a JSON object.", instanceContext: {}, runtimeContext: {},
    primary: { source_path: "Inbox/primary.md", content: "P".repeat(40) },
    related: [
      { source_path: "Daily/one.md", content: "A".repeat(40) },
      { source_path: "Daily/two.md", content: "B".repeat(40) },
    ],
    allowedReadRoots: ["Inbox"], maxSensitivityClass: 0,
    budget: { max_files: 2, max_total_bytes: 30, max_file_bytes: 20, max_estimated_tokens: 8, overflow_policy: "truncate-and-review" },
  });
  try {
    assert.equal(context.manifest.version, 4);
    assert.equal(context.manifest.budget.candidate_files, 3);
    assert.equal(context.manifest.budget.included_files, 2);
    assert.equal(context.manifest.budget.excluded_file_count, 1);
    assert.equal(context.manifest.budget.truncated_file_count, 2);
    assert.equal(context.manifest.budget.total_bytes <= 30, true);
    assert.equal(context.manifest.budget.estimated_tokens <= 8, true);
    assert.equal(context.manifest.budget.review_required, true);
    assert.equal(context.manifest.related_inputs.length, 1);
  } finally {
    await context.cleanup();
  }
});
