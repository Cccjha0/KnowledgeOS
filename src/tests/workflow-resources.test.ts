import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DiscoveredDocument } from "../core/discovery.js";
import type { JsonObject } from "../core/types.js";
import { resolveWorkflowResourceRequirements } from "../modules/workflowResources.js";

async function fixtureModule(): Promise<{ root: string; module: DiscoveredDocument }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-workflow-resources-"));
  await fs.mkdir(path.join(root, "workflows"), { recursive: true });
  await fs.writeFile(path.join(root, "workflows", "index.yaml"), [
    "workflows:", "  capture: { active_version: 1.0.0, path: capture.yaml }", "  local: { active_version: 1.0.0, path: local.yaml }", "",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(root, "workflows", "capture.yaml"), [
    "workflow_id: capture", "workflow_version: 1.0.0", "steps:", "  - id: ask-codex", "    uses: codex.prompt", "",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(root, "workflows", "local.yaml"), [
    "workflow_id: local", "workflow_version: 1.0.0", "resources: { codex: not-required, user: required }", "steps:", "  - id: local", "    uses: core.build-operation-plan", "",
  ].join("\n"), "utf8");
  const data: JsonObject = {
    id: "fixture", resources: { network: "required" }, workflows: { registry: "workflows/index.yaml" },
    entry_workflows: { capture: "workflows/capture.yaml" },
  };
  return { root, module: { path: path.join(root, "module.yaml"), data } };
}

test("Workflow resources are resolved from one precedence chain for Inbox and Jobs", async () => {
  const fixture = await fixtureModule();
  try {
    const capture = resolveWorkflowResourceRequirements(fixture.module, null, "capture");
    assert.deepEqual(capture, { filesystem: "required", network: "required", codex: "required", user: "not-required" });

    const local = resolveWorkflowResourceRequirements(fixture.module, "local");
    assert.deepEqual(local, { filesystem: "required", network: "required", codex: "not-required", user: "required" });
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
