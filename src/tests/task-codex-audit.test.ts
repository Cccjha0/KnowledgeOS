import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyCodexFailure, runManagedCodexStep } from "../runtime/codexAdapter.js";
import { resolveCodexReasoningEffort } from "../runtime/codexCli.js";
import { RuntimeRepository } from "../runtime/repository.js";

test("managed Codex step repairs invalid structured output and audits each attempt", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-codex-audit-"));
  try {
    const repository = await RuntimeRepository.open(vault);
    const task = repository.createTask({ job_id: "ai", module: "core", task_type: "workflow", workflow: "ai:test", resources: { filesystem: "required", network: "not-required", codex: "required", user: "not-required" }, trigger: { type: "manual" }, catch_up_policy: "none", idempotency_key: "ai:1" }).task;
    repository.close();
    const result = await runManagedCodexStep(vault, { task_id: task.task_id, prompt_id: "weekly-summary", prompt_version: "1", adapter: "test", model: "test-model", output_schema: "summary-v1" }, async ({ attempt }) => ({ output: attempt === 1 ? { wrong: true } : { summary: "ok" } as Record<string, string>, token_usage: { total: 12 } }), (output) => Boolean(output && typeof output === "object" && !Array.isArray(output) && typeof output.summary === "string"));
    assert.deepEqual(result.output, { summary: "ok" });
    const repo2 = await RuntimeRepository.open(vault); const invocations = repo2.listCodexInvocations(task.task_id);
    assert.deepEqual(invocations.map((item) => item.status), ["invalid-output", "completed"]);
    assert.equal(invocations[0]?.prompt_id, "weekly-summary");
    repo2.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("Codex failures distinguish authentication, model, limits, connectivity, and format", () => {
  assert.equal(classifyCodexFailure("401 authentication expired").code, "CODEX_AUTHENTICATION_FAILED");
  assert.equal(classifyCodexFailure("429 rate limit").code, "CODEX_RATE_LIMITED");
  assert.equal(classifyCodexFailure("model unavailable").code, "CODEX_MODEL_UNAVAILABLE");
  assert.equal(classifyCodexFailure("connection timeout").code, "CODEX_CONNECTION_FAILED");
  assert.equal(classifyCodexFailure("schema invalid output").code, "CODEX_OUTPUT_INVALID");
});

test("Codex reasoning effort accepts catalog values and rejects unsafe custom values", () => {
  assert.equal(resolveCodexReasoningEffort("high"), "high");
  assert.equal(resolveCodexReasoningEffort(" ultra "), "ultra");
  assert.throws(() => resolveCodexReasoningEffort("high; delete-all"), /Unsupported Codex reasoning effort/);
});
