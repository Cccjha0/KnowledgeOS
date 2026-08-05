import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseMarkdown, writeMarkdown } from "../core/bridge.js";
import { executeOperationPlan } from "../core/operationExecutor.js";
import { initializeVault } from "../core/vault.js";
import { prepareIndexMaterialization } from "../components/indexMaterializer.js";
import { prepareLinkReconciliation } from "../components/linkReconciliation.js";
import { getWorkflowStepDefinition } from "../modules/workflowStepRegistry.js";

test("link-reconciliation merges Frontmatter links without duplicate operations or body edits", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-link-reconciliation-"));
  try {
    await initializeVault(vault, "disabled");
    const root = "20-Workspace/Experience Log/demo"; const target = `${root}/Daily/2026-08-05.md`;
    const file = path.join(vault, ...target.split("/")); await fs.mkdir(path.dirname(file), { recursive: true });
    writeMarkdown(vault, file, { data: { related_links: ["[[Existing]]"] }, content: "# Daily\n\nUser-authored body remains unchanged.\n" });
    const prepared = await prepareLinkReconciliation({ vaultRoot: vault, planId: "PLAN-2026-000001", taskId: "TASK-2026-000001", moduleId: "experience-log", instanceId: "demo", instanceRoot: root, target, links: ["Existing", "New Reference"] });
    assert.deepEqual(prepared.added, ["[[New Reference]]"]);
    await executeOperationPlan(vault, prepared.plan, { allowedTypes: ["update-frontmatter"], allowedTargets: [target], requiredReviewId: null });
    const after = parseMarkdown(vault, file);
    assert.deepEqual(after.data.related_links, ["[[Existing]]", "[[New Reference]]"]);
    assert.match(after.content, /User-authored body remains unchanged/);
    const repeated = await prepareLinkReconciliation({ vaultRoot: vault, planId: "PLAN-2026-000002", taskId: "TASK-2026-000002", moduleId: "experience-log", instanceId: "demo", instanceRoot: root, target, links: ["Existing", "New Reference"] });
    assert.equal(repeated.plan.operations.length, 0);
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("index-materializer only writes a system-owned section and preserves user notes", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-index-materializer-"));
  try {
    await initializeVault(vault, "disabled");
    const root = "20-Workspace/Reading Log/demo"; const target = `${root}/Index.md`;
    const first = await prepareIndexMaterialization({ vaultRoot: vault, planId: "PLAN-2026-000003", taskId: "TASK-2026-000003", moduleId: "reading-log", instanceId: "demo", instanceRoot: root, target, title: "Reading Index", entries: [{ title: "One", target: "Notes/One" }] });
    assert.equal(first.created, true);
    await executeOperationPlan(vault, first.plan, { allowedTypes: ["create-file"], allowedTargets: [target], requiredReviewId: null });
    const file = path.join(vault, ...target.split("/")); const before = parseMarkdown(vault, file);
    writeMarkdown(vault, file, { data: before.data, content: `${before.content}\nMy user note\n` });
    const second = await prepareIndexMaterialization({ vaultRoot: vault, planId: "PLAN-2026-000004", taskId: "TASK-2026-000004", moduleId: "reading-log", instanceId: "demo", instanceRoot: root, target, title: "Reading Index", entries: [{ title: "One", target: "Notes/One" }, { title: "Two", target: "Notes/Two" }] });
    assert.equal(second.plan.operations.length, 1, "Only the missing entry needs an append operation.");
    await executeOperationPlan(vault, second.plan, { allowedTypes: ["append-section"], allowedTargets: [target], requiredReviewId: null });
    const after = parseMarkdown(vault, file);
    assert.match(after.content, /\[\[Notes\/One\]\]/); assert.match(after.content, /\[\[Notes\/Two\]\]/); assert.match(after.content, /My user note/);
    await assert.rejects(prepareIndexMaterialization({ vaultRoot: vault, planId: "PLAN-2026-000005", taskId: "TASK-2026-000005", moduleId: "reading-log", instanceId: "demo", instanceRoot: root, target: "30-Knowledge/Index.md", title: "Invalid", entries: [] }), /inside its instance/);
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("link and index Components are registered as reusable Workflow steps", () => {
  assert.equal(getWorkflowStepDefinition("component.link-reconciliation")?.componentId, "link-reconciliation");
  assert.equal(getWorkflowStepDefinition("component.index-materializer")?.componentId, "index-materializer");
});
