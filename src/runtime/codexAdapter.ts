import { randomUUID } from "node:crypto";
import type { JsonObject, JsonValue } from "../core/types.js";
import { RuntimeRepository } from "./repository.js";
import { PkbError } from "../core/errors.js";

export interface CodexExecutionResult {
  output: JsonValue;
  token_usage?: JsonObject;
}

export interface ManagedCodexRequest {
  task_id: string;
  run_id?: string | null;
  prompt_id: string;
  prompt_version: string;
  adapter: string;
  model?: string | null;
  output_schema: string;
  max_format_attempts?: number;
  module?: string;
  instance_id?: string | null;
  workflow_id?: string | null;
  workflow_version?: string | null;
}

export function classifyCodexFailure(message: string): { code: string; retryable: boolean } {
  const normalized = message.toLowerCase();
  if (/auth|unauthorized|login|credential|401/.test(normalized)) return { code: "CODEX_AUTHENTICATION_FAILED", retryable: false };
  if (/rate.?limit|quota|429/.test(normalized)) return { code: "CODEX_RATE_LIMITED", retryable: true };
  if (/model.*(not found|unavailable)|unsupported model/.test(normalized)) return { code: "CODEX_MODEL_UNAVAILABLE", retryable: false };
  if (/timeout|network|connect|socket|dns|econn/.test(normalized)) return { code: "CODEX_CONNECTION_FAILED", retryable: true };
  if (/schema|format|invalid output/.test(normalized)) return { code: "CODEX_OUTPUT_INVALID", retryable: true };
  return { code: "CODEX_INVOCATION_FAILED", retryable: false };
}

export async function runManagedCodexStep(
  vaultRoot: string,
  request: ManagedCodexRequest,
  execute: (context: { attempt: number; repair_format: boolean }) => Promise<CodexExecutionResult>,
  validate: (output: JsonValue) => boolean,
): Promise<CodexExecutionResult> {
  const repository = await RuntimeRepository.open(vaultRoot);
  const maximum = Math.max(1, Math.min(request.max_format_attempts ?? 3, 3));
  try {
    for (let attempt = 1; attempt <= maximum; attempt += 1) {
      const invocationId = `CDX-${randomUUID()}`;
      repository.startCodexInvocation({
        invocation_id: invocationId, task_id: request.task_id, run_id: request.run_id ?? null,
        prompt_id: request.prompt_id, prompt_version: request.prompt_version, adapter: request.adapter,
        model: request.model ?? null, output_schema: request.output_schema, started_at: new Date().toISOString(), attempt_number: attempt,
      });
      try {
        const result = await execute({ attempt, repair_format: attempt > 1 });
        if (!validate(result.output)) {
          repository.finishCodexInvocation({ invocation_id: invocationId, ended_at: new Date().toISOString(), status: "invalid-output", error: { code: "CODEX_OUTPUT_SCHEMA_INVALID", message: "Codex output did not match the declared schema." }, token_usage: result.token_usage ?? {} });
          repository.recordMetricEvent({ idempotency_key: `${invocationId}:schema-failed`, event_type: "codex.schema-failed", module: request.module ?? "core", instance_id: request.instance_id ?? null, workflow_id: request.workflow_id ?? null, workflow_version: request.workflow_version ?? null, prompt_id: request.prompt_id, prompt_version: request.prompt_version, run_id: request.run_id ?? null, occurred_at: new Date().toISOString(), dimensions: { output_schema: request.output_schema, adapter: request.adapter, model: request.model ?? "unknown" }, values: { attempts: 1 } });
          if (attempt === maximum) throw new Error("Codex output remained invalid after format repair attempts.");
          continue;
        }
        repository.finishCodexInvocation({ invocation_id: invocationId, ended_at: new Date().toISOString(), status: "completed", token_usage: result.token_usage ?? {} });
        repository.recordMetricEvent({ idempotency_key: `${invocationId}:completed`, event_type: "codex.completed", module: request.module ?? "core", instance_id: request.instance_id ?? null, workflow_id: request.workflow_id ?? null, workflow_version: request.workflow_version ?? null, prompt_id: request.prompt_id, prompt_version: request.prompt_version, run_id: request.run_id ?? null, occurred_at: new Date().toISOString(), dimensions: { output_schema: request.output_schema, adapter: request.adapter, model: request.model ?? "unknown" }, values: { attempts: attempt, ...(result.token_usage ?? {}) } });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const existing = repository.listCodexInvocations(request.task_id).find((item) => item.invocation_id === invocationId);
        if (existing?.status === "running") repository.finishCodexInvocation({ invocation_id: invocationId, ended_at: new Date().toISOString(), status: "failed", error: { code: "CODEX_INVOCATION_FAILED", message }, token_usage: {} });
        repository.recordMetricEvent({ idempotency_key: `${invocationId}:failed`, event_type: "codex.failed", module: request.module ?? "core", instance_id: request.instance_id ?? null, workflow_id: request.workflow_id ?? null, workflow_version: request.workflow_version ?? null, prompt_id: request.prompt_id, prompt_version: request.prompt_version, run_id: request.run_id ?? null, occurred_at: new Date().toISOString(), dimensions: { error_code: classifyCodexFailure(message).code, adapter: request.adapter, model: request.model ?? "unknown" }, values: { attempts: attempt } });
        if (attempt === maximum || message.includes("remained invalid")) {
          const classified = classifyCodexFailure(message);
          throw new PkbError(classified.code, message, { retryable: classified.retryable });
        }
      }
    }
    throw new Error("Codex invocation exhausted its attempts.");
  } finally { repository.close(); }
}
