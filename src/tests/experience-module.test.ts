import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseMarkdown, validateSchema } from "../core/bridge.js";
import { executeOperationPlan } from "../core/operationExecutor.js";
import type { JsonObject, OperationPlan } from "../core/types.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAILY_SCHEMA = "https://pkb.local/schemas/experience-log/daily-log.schema.json";
const WEEKLY_SCHEMA = "https://pkb.local/schemas/experience-log/weekly-summary.schema.json";

async function fixture(name: string): Promise<JsonObject> {
  return JSON.parse(await fs.readFile(path.join(ENGINE_ROOT, "examples", name), "utf8")) as JsonObject;
}

test("experience-log uses the existing Core plan executor for daily and weekly output", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-experience-"));
  try {
    const daily = await fixture("experience-daily-log.json");
    const weekly = await fixture("experience-weekly-summary.json");
    validateSchema(vault, DAILY_SCHEMA, daily);
    validateSchema(vault, WEEKLY_SCHEMA, weekly);
    const dailyPath = "20-Workspace/Experience Log/internship-2026/Daily/2026-07-27.md";
    const weeklyPath = "20-Workspace/Experience Log/internship-2026/Weekly/2026-W31.md";
    const plan: OperationPlan = {
      plan_id: "PLAN-2026-000101",
      task_id: "TASK-2026-000101",
      source_module: "experience-log",
      instance_id: "internship-2026",
      summary: "Create one structured daily log and one weekly summary.",
      operations: [
        {
          operation_id: "OP-001", type: "create-file", target: dailyPath, risk: "green", confidence: 1,
          idempotency_key: "experience:daily:2026-07-27",
          payload: { document: { data: daily, content: "# 2026-07-27 实习日报\n" }, schema_id: DAILY_SCHEMA },
          requires_review_id: null,
        },
        {
          operation_id: "OP-002", type: "create-file", target: weeklyPath, risk: "green", confidence: 1,
          idempotency_key: "experience:weekly:2026-W31",
          payload: { document: { data: weekly, content: "# 2026-W31 实习周报\n" }, schema_id: WEEKLY_SCHEMA },
          requires_review_id: null,
        },
      ],
      review_items: [],
    };
    await executeOperationPlan(vault, plan, {
      allowedTypes: ["create-file"], allowedTargets: [dailyPath, weeklyPath], requiredReviewId: null,
    });
    assert.equal(parseMarkdown(vault, path.join(vault, ...dailyPath.split("/"))).data.type, "experience-daily-log");
    assert.equal(parseMarkdown(vault, path.join(vault, ...weeklyPath.split("/"))).data.type, "experience-weekly-summary");
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});
