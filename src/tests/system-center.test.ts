import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseMarkdown } from "../core/bridge.js";
import { writeRunLog } from "../core/logs.js";
import { executeOperationPlan } from "../core/operationExecutor.js";
import type { JsonObject, OperationPlan, RunLog } from "../core/types.js";
import { initializeVault } from "../core/vault.js";
import { invokeCommandApi } from "../platform/commandApi.js";
import { enablePerformanceDiagnostics, performanceDiagnosticsSnapshot, resetPerformanceDiagnostics } from "../core/performanceDiagnostics.js";

async function executeLoggedPlan(vault: string, sequence: number, value: string): Promise<{ runId: string; plan: OperationPlan }> {
  const suffix = String(sequence).padStart(6, "0");
  const runId = `RUN-2026-${suffix}`;
  const plan: OperationPlan = {
    plan_id: `PLAN-2026-${suffix}`, task_id: `TASK-2026-${suffix}`,
    source_module: "experience-log", instance_id: null, summary: `Set record value to ${value}`,
    review_items: [], operations: [{
      operation_id: "OP-001", type: "update-frontmatter", target: "record.md", risk: "green", confidence: 1,
      idempotency_key: `system-center:${suffix}`, payload: { patch: { value } }, requires_review_id: null,
    }],
  };
  const started = new Date(Date.now() + sequence * 1000).toISOString();
  await fs.writeFile(path.join(vault, "90-System", "State", "Plans", `${plan.plan_id}.json`), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  await executeOperationPlan(vault, plan, { gitSnapshot: "disabled" });
  const log: RunLog = {
    run_id: runId, task_id: plan.task_id, plan_id: plan.plan_id, source_module: "experience-log", instance_id: null,
    review_id: null, status: "completed", git_snapshot: "disabled", started_at: started,
    completed_at: new Date(Date.parse(started) + 100).toISOString(), schema_version: 1,
  };
  await writeRunLog(vault, log, `# ${runId}\n\n${plan.summary}.\n`);
  return { runId, plan };
}

test("System Center run models are user-readable and expose safe rollback", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-system-run-"));
  try {
    await initializeVault(vault, "disabled");
    await fs.writeFile(path.join(vault, "record.md"), "---\nvalue: old\n---\n", "utf8");
    const { runId } = await executeLoggedPlan(vault, 1, "new");
    await fs.writeFile(path.join(vault, "90-System", "Logs", "RUN-2026-999999.md"), [
      "---", "run_id: RUN-2026-999999", "task_id: null", "plan_id: null",
      "module: application-tracker", "instance: legacy-instance", "status: completed",
      "git_snapshot: null", "started_at: '2025-01-01T00:00:00Z'", "completed_at: '2025-01-01T00:00:00Z'",
      "schema_version: 1", "---", "", "# Legacy run", "",
    ].join("\n"), "utf8");

    const recent = await invokeCommandApi({ vaultRoot: vault, requestId: "SYS-RUNS", method: "getRecentRuns", params: {} });
    assert.equal(recent.ok, true);
    const summaries = recent.data as JsonObject[];
    const summary = summaries.find((candidate) => candidate.run_id === runId)!;
    assert.equal(summary.run_id, runId);
    assert.equal(summary.modified_file_count, 1);
    assert.equal((summary.rollback as JsonObject).level, "safe");
    const legacy = summaries.find((candidate) => candidate.run_id === "RUN-2026-999999")!;
    assert.equal(legacy.source_module, "application-tracker");
    assert.equal(legacy.instance_id, "legacy-instance");
    const history = await invokeCommandApi({ vaultRoot: vault, requestId: "SYS-HISTORY", method: "getSystemCenterSnapshot", params: { section: "history" } });
    assert.equal(history.ok, true);
    const historyRun = ((history.data as JsonObject).runs as JsonObject[]).find((candidate) => candidate.run_id === runId)!;
    assert.equal(historyRun.rollback, null);

    const details = await invokeCommandApi({ vaultRoot: vault, requestId: "SYS-DETAIL", method: "getRunDetails", params: { run_id: runId } });
    assert.equal(details.ok, true);
    const view = details.data as JsonObject;
    assert.equal((view.operations as JsonObject[])[0]?.type, "update-frontmatter");
    assert.equal((view.affected_files as JsonObject[])[0]?.path, "record.md");
    assert.equal(view.developer, null);

    const rolledBack = await invokeCommandApi({ vaultRoot: vault, requestId: "SYS-ROLLBACK", method: "rollbackRun", params: { run_id: runId } });
    assert.equal(rolledBack.ok, true);
    assert.equal((rolledBack.data as JsonObject).status, "rolled-back");
    assert.match(String(parseMarkdown(vault, path.join(vault, "record.md")).data.value), /old/);
    assert.equal(typeof (rolledBack.data as JsonObject).rollback_run_id, "string");
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("System Center snapshot consolidates all read models into one API response", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-system-snapshot-"));
  try {
    await initializeVault(vault, "disabled");
    const response = await invokeCommandApi({
      vaultRoot: vault,
      requestId: "SYS-SNAPSHOT",
      method: "getSystemCenterSnapshot",
      params: {},
    });
    assert.equal(response.ok, true, JSON.stringify(response.error));
    const snapshot = response.data as JsonObject;
    for (const key of ["modules", "instances", "inbox", "reviews", "runs", "tasks", "runtime", "quality"]) {
      assert.equal(key in snapshot, true, `snapshot should include ${key}`);
    }
    assert.equal((snapshot.runtime as JsonObject).integrity, "ok");
    assert.equal(Array.isArray(snapshot.tasks), true);
    assert.equal(typeof ((snapshot.quality as JsonObject).overview as JsonObject).active_issues, "number");

    const overview = await invokeCommandApi({ vaultRoot: vault, requestId: "SYS-OVERVIEW", method: "getSystemCenterSnapshot", params: { section: "overview" } });
    assert.equal(overview.ok, true);
    assert.equal((overview.data as JsonObject).section, "overview");
    assert.equal("freshness" in ((overview.data as JsonObject).quality as JsonObject), false);
    const tasks = await invokeCommandApi({ vaultRoot: vault, requestId: "SYS-TASKS", method: "getSystemCenterSnapshot", params: { section: "tasks" } });
    assert.equal(tasks.ok, true);
    assert.equal("modules" in (tasks.data as JsonObject), false);
    assert.equal(typeof (((tasks.data as JsonObject).runtime as JsonObject).counts as JsonObject).completed, "number");
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("Recent Runs uses a rebuildable bounded index after the first safe fallback", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-run-index-"));
  try {
    await initializeVault(vault, "disabled");
    const logRoot = path.join(vault, "90-System", "Logs");
    for (let index = 0; index < 200; index += 1) {
      const number = index + 1; const runId = `RUN-2026-${String(number).padStart(6, "0")}`;
      const completed = new Date(Date.parse("2026-01-01T00:00:00Z") + index * 1000).toISOString();
      await fs.writeFile(path.join(logRoot, `${runId}.md`), ["---", `run_id: ${runId}`, "task_id: null", "plan_id: null", "source_module: core",
        "instance_id: null", "review_id: null", "status: completed", "git_snapshot: null", `started_at: '${completed}'`, `completed_at: '${completed}'`,
        "schema_version: 1", "---", "", `# ${runId}`, "", "Synthetic run.", ""].join("\n"), "utf8");
    }
    enablePerformanceDiagnostics(); resetPerformanceDiagnostics();
    const fallback = await invokeCommandApi({ vaultRoot: vault, requestId: "RUN-INDEX-1", method: "getRecentRuns", params: { limit: 20, include_rollback: false } });
    assert.equal(fallback.ok, true);
    assert.equal((fallback.data as JsonObject[]).length, 20);
    assert.equal(performanceDiagnosticsSnapshot().markdown_files_parsed, 200);
    resetPerformanceDiagnostics();
    const indexed = await invokeCommandApi({ vaultRoot: vault, requestId: "RUN-INDEX-2", method: "getRecentRuns", params: { limit: 20, include_rollback: false } });
    assert.equal((indexed.data as JsonObject[])[0]?.run_id, "RUN-2026-000200");
    assert.equal(performanceDiagnosticsSnapshot().files_discovered, 0);
    assert.equal(performanceDiagnosticsSnapshot().markdown_files_parsed, 0);
    assert.equal(performanceDiagnosticsSnapshot().python_subprocesses, 1);
    const firstPage = await invokeCommandApi({ vaultRoot: vault, requestId: "RUN-PAGE-1", method: "getRecentRuns", params: { page_size: 17, include_rollback: false } });
    const firstPageData = firstPage.data as JsonObject;
    assert.equal((firstPageData.items as JsonObject[]).length, 17);
    assert.equal(firstPageData.has_more, true);
    const secondPage = await invokeCommandApi({ vaultRoot: vault, requestId: "RUN-PAGE-2", method: "getRecentRuns", params: { page_size: 17, cursor: firstPageData.next_cursor ?? null, include_rollback: false } });
    const secondPageData = secondPage.data as JsonObject;
    assert.equal((secondPageData.items as JsonObject[]).length, 17);
    assert.equal((secondPageData.items as JsonObject[])[0]?.run_id, "RUN-2026-000183");
    assert.equal(new Set([...(firstPageData.items as JsonObject[]), ...(secondPageData.items as JsonObject[])].map((item) => item.run_id)).size, 34);
    await fs.rm(path.join(vault, "90-System", "Cache", "run-summary-index.sqlite"), { force: true });
    resetPerformanceDiagnostics();
    assert.equal(((await invokeCommandApi({ vaultRoot: vault, requestId: "RUN-INDEX-3", method: "getRecentRuns", params: { limit: 5, include_rollback: false } })).data as JsonObject[]).length, 5);
    assert.equal(performanceDiagnosticsSnapshot().markdown_parse_requests > 0, true);
  } finally { enablePerformanceDiagnostics(false); await fs.rm(vault, { recursive: true, force: true }); }
});

test("Core API server correlates multiple requests over one process", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-api-server-"));
  let server: ReturnType<typeof spawn> | null = null;
  try {
    await initializeVault(vault, "disabled");
    server = spawn(process.execPath, [path.resolve("dist/cli.js"), "api-server", "--vault", vault], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    const responses = await new Promise<JsonObject[]>((resolve, reject) => {
      const result: JsonObject[] = []; let buffer = ""; let stderr = "";
      const timer = setTimeout(() => reject(new Error(`API server timed out: ${stderr}`)), 30_000);
      server!.stderr!.on("data", (chunk) => { stderr += String(chunk); });
      server!.on("error", reject);
      server!.stdout!.on("data", (chunk) => {
        buffer += String(chunk);
        while (buffer.includes("\n")) {
          const newline = buffer.indexOf("\n"); const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
          if (line) result.push(JSON.parse(line) as JsonObject);
          if (result.length === 2) { clearTimeout(timer); resolve(result); }
        }
      });
      for (const requestId of ["SERVER-ONE", "SERVER-TWO"]) {
        server!.stdin!.write(`${JSON.stringify({ request_id: requestId, method: "getInstances", params: {} })}\n`);
      }
    });
    assert.deepEqual(responses.map((response) => response.request_id).sort(), ["SERVER-ONE", "SERVER-TWO"]);
    assert.equal(responses.every((response) => response.ok === true), true);
    server.stdin!.end();
    await new Promise<void>((resolve) => server!.once("exit", () => resolve()));
    server = null;
  } finally {
    if (server && !server.killed) server.kill();
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test("Core API server only treats Today requests without Markdown writes as concurrent", async () => {
  const source = await fs.readFile(path.resolve("src", "cli.ts"), "utf8");
  assert.match(source, /method === "getTodayItems"\) return params\.refresh_markdown === false/);
  assert.match(source, /commandApiRequestCanRunConcurrently\(parsedRequest\.method/);
});

test("rollback refuses changed files and requires confirmation for later overlapping runs", async () => {
  const changedVault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-system-changed-"));
  const dependentVault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-system-dependent-"));
  try {
    await initializeVault(changedVault, "disabled");
    await fs.writeFile(path.join(changedVault, "record.md"), "---\nvalue: old\n---\n", "utf8");
    const changed = await executeLoggedPlan(changedVault, 2, "system");
    await fs.writeFile(path.join(changedVault, "record.md"), "---\nvalue: user-edit\n---\n", "utf8");
    const refused = await invokeCommandApi({ vaultRoot: changedVault, requestId: "SYS-REFUSE", method: "rollbackRun", params: { run_id: changed.runId } });
    assert.equal(refused.ok, false);
    assert.equal(refused.error?.code, "RUN_NOT_ROLLBACKABLE");
    assert.match(await fs.readFile(path.join(changedVault, "record.md"), "utf8"), /user-edit/);

    await initializeVault(dependentVault, "disabled");
    await fs.writeFile(path.join(dependentVault, "record.md"), "---\nvalue: old\n---\n", "utf8");
    const first = await executeLoggedPlan(dependentVault, 3, "same");
    await executeLoggedPlan(dependentVault, 4, "same");
    const needsConfirmation = await invokeCommandApi({ vaultRoot: dependentVault, requestId: "SYS-CONFIRM-1", method: "rollbackRun", params: { run_id: first.runId } });
    assert.equal(needsConfirmation.ok, false);
    assert.equal(needsConfirmation.error?.code, "ROLLBACK_CONFIRMATION_REQUIRED");
    const confirmed = await invokeCommandApi({ vaultRoot: dependentVault, requestId: "SYS-CONFIRM-2", method: "rollbackRun", params: { run_id: first.runId, confirm: true } });
    assert.equal(confirmed.ok, true);
    assert.equal(parseMarkdown(dependentVault, path.join(dependentVault, "record.md")).data.value, "old");
  } finally {
    await fs.rm(changedVault, { recursive: true, force: true });
    await fs.rm(dependentVault, { recursive: true, force: true });
  }
});
