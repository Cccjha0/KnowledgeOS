import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverInstances, discoverModules } from "../core/discovery.js";
import { executeOperationPlan } from "../core/operationExecutor.js";
import type { OperationPlan } from "../core/types.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("Core discovers module manifests and generic instances", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-discovery-"));
  try {
    const instanceRoot = path.join(vault, "90-System", "Instances", "demo-instance");
    await fs.mkdir(instanceRoot, { recursive: true });
    await fs.writeFile(path.join(instanceRoot, "instance.yaml"), [
      "instance_id: demo-instance",
      "module_id: application-tracker",
      "status: active",
      "display_name: Demo",
      "content_root: 20-Workspace/Demo",
      'created: "2026-07-27T00:00:00Z"',
      'updated: "2026-07-27T00:00:00Z"',
      "",
    ].join("\n"), "utf8");

    const modules = await discoverModules(ENGINE_ROOT);
    const instances = await discoverInstances(vault);
    assert.ok(modules.some((item) => item.data.id === "application-tracker"));
    assert.ok(modules.some((item) => item.data.id === "experience-log"));
    assert.deepEqual(instances.map((item) => item.data.instance_id), ["demo-instance"]);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test("Core executes an authorized plan and rolls back a failed plan", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-plan-"));
  const target = path.join(vault, "record.md");
  const original = "---\nstatus: old\n---\n\n# Record\n";
  try {
    await fs.writeFile(target, original, "utf8");
    const plan: OperationPlan = {
      plan_id: "PLAN-2026-000001",
      task_id: "TASK-2026-000001",
      source_module: "application-tracker",
      instance_id: "demo-instance",
      summary: "Update a record",
      operations: [{
        operation_id: "OP-001",
        type: "update-frontmatter",
        target: "record.md",
        risk: "green",
        confidence: 1,
        idempotency_key: "demo:update-frontmatter",
        payload: { patch: { status: "new" } },
        requires_review_id: null,
      }],
      review_items: [],
    };
    await executeOperationPlan(vault, plan, {
      allowedTypes: ["update-frontmatter"],
      allowedTargets: ["record.md"],
      requiredReviewId: null,
    });
    assert.match(await fs.readFile(target, "utf8"), /status: new/);
    const completedJournal = JSON.parse(await fs.readFile(path.join(vault, "90-System", "State", "Transactions", plan.plan_id, "transaction.json"), "utf8")) as { status: string };
    assert.equal(completedJournal.status, "completed");
    assert.equal((await fs.stat(path.join(vault, "90-System", "Logs", "Transactions", `${plan.plan_id}.json`))).isFile(), true);

    await fs.writeFile(target, original, "utf8");
    await fs.writeFile(path.join(vault, "occupied.md"), "occupied", "utf8");
    const failing: OperationPlan = {
      ...plan,
      plan_id: "PLAN-2026-000002",
      operations: [
        ...plan.operations,
        {
          operation_id: "OP-002",
          type: "move-file",
          target: "record.md",
          risk: "green",
          confidence: 1,
          idempotency_key: "demo:move-file",
          payload: { destination: "occupied.md" },
          requires_review_id: null,
        },
      ],
    };
    await assert.rejects(() => executeOperationPlan(vault, failing, {
      allowedTypes: ["update-frontmatter", "move-file"],
      allowedTargets: ["record.md"],
      requiredReviewId: null,
    }));
    assert.equal(await fs.readFile(target, "utf8"), original);
    const failedJournal = JSON.parse(await fs.readFile(path.join(vault, "90-System", "State", "Transactions", failing.plan_id, "transaction.json"), "utf8")) as { status: string };
    assert.equal(failedJournal.status, "rolled-back");
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});
