import assert from "node:assert/strict";
import test from "node:test";
import type { DiscoveredDocument } from "../core/discovery.js";
import type { RuntimeTask } from "../runtime/domain.js";
import { createTaskPresentationCatalog, taskPresentation } from "../platform/taskDashboardPresentation.js";

const moduleDocument = {
  path: "module.yaml",
  data: { id: "demo-module", name: "Demo", ui: { display_name: "示例模块", field_labels: { deadline: "截止日期" }, job_labels: { sync: "同步资料" } } },
} as unknown as DiscoveredDocument;

function task(patch: Partial<RuntimeTask>): RuntimeTask {
  return {
    task_id: "TASK-1", job_id: "demo-module.sync", module: "demo-module", instance_id: "demo-1", task_type: "workflow", workflow: "sync",
    status: "waiting-for-user", priority: "normal", scheduled_for: new Date().toISOString(), available_after: new Date().toISOString(), deadline: null,
    defer_until: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), completed_at: null,
    resources: { filesystem: "required", network: "not-required", codex: "not-required", user: "required" }, trigger: { type: "manual" },
    catch_up_policy: "none", idempotency_key: "demo", max_attempts: 3, attempt_count: 0, next_retry_at: null, payload: {},
    parent_task_id: null, dependency_task_ids: [], dependency_policy: "all-success", concurrency_key: null, concurrency_policy: "allow", cancel_requested: false,
    last_error: null, completion_reason: null, ...patch,
  };
}

test("task dashboard presentation uses module UI metadata without business-specific platform labels", () => {
  const catalog = createTaskPresentationCatalog([moduleDocument]);
  assert.equal(taskPresentation(task({}), catalog).title, "同步资料 · waiting-for-user");
  const stale = taskPresentation(task({
    job_id: "quality.stale-field-followup", payload: { target: { field: "deadline" } },
  }), catalog);
  assert.equal(stale.title, "示例模块信息需要重新核验");
  assert.match(stale.description, /截止日期/);
});
