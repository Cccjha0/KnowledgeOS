import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProcessInboxBatchParams, ProcessInboxItemParams } from "../api/types.js";
import { discoverInstances, discoverModules } from "../core/discovery.js";
import { PkbError } from "../core/errors.js";
import { ensureDir, exists, fromVaultPath, writeJsonAtomic } from "../core/files.js";
import { createGitSnapshot } from "../core/git.js";
import { allocateId } from "../core/ids.js";
import { writeRunLog } from "../core/logs.js";
import { executeOperationPlan } from "../core/operationExecutor.js";
import type { JsonObject, JsonValue, OperationPlan, RunLog } from "../core/types.js";
import { processApplicationReport } from "./applicationWorkflow.js";
import { rebuildTodayDashboard } from "./dashboard.js";
import { discoverInboxItems, type InboxItemView, type InboxStateRecord, writeInboxState } from "./inboxDiscovery.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function normalizedOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

async function findItem(vaultRoot: string, itemId: string): Promise<InboxItemView> {
  const item = (await discoverInboxItems(vaultRoot)).find((candidate) => candidate.item_id === itemId);
  if (!item) throw new PkbError("INBOX_ITEM_NOT_FOUND", `Inbox item ${itemId} was not found in a managed Inbox.`);
  return item;
}

function preview(item: InboxItemView, overrides: { moduleId: string | null; instanceId: string | null } = { moduleId: null, instanceId: null }): JsonObject {
  const moduleId = overrides.moduleId ?? item.suggested_module_id;
  const instanceId = overrides.instanceId ?? item.suggested_instance_id;
  return {
    status: "preview", item_id: item.item_id, path: item.path, current_state: item.state,
    suggested_ownership: { module_id: moduleId, instance_id: instanceId },
    content_type: item.content_type, confidence: item.confidence, reasons: item.reasons,
    required_read_level: item.required_read_level, requires_codex: item.requires_ai,
    can_auto_process: item.confidence >= item.auto_route_threshold && !item.requires_ai,
    processor: item.processor,
    operation_summary: item.processor === "application-research-report"
      ? { kind: "module-processing", estimated_operations: null, target: "Application Record and Research archive" }
      : item.scope === "global" && moduleId
        ? { kind: "route", estimated_operations: 1, target: instanceId ? `${instanceId} Inbox` : `${moduleId} Inbox` }
        : { kind: "handoff", estimated_operations: 0, target: null },
    risk: item.processor === "application-research-report" ? "mixed-by-module-plan" : "green",
  };
}

function stateFor(item: InboxItemView, state: InboxStateRecord["state"], overrides: Partial<InboxStateRecord> = {}): InboxStateRecord {
  return {
    schema_version: 1, item_id: item.item_id, path: item.path, state,
    attempts: Number(overrides.attempts ?? 0), review_after: overrides.review_after ?? null,
    error: overrides.error ?? null, run_id: overrides.run_id ?? null, plan_id: overrides.plan_id ?? null,
    result: overrides.result ?? null, updated_at: new Date().toISOString(),
  };
}

async function acquireItemLock(vaultRoot: string, itemId: string): Promise<FileHandle> {
  const file = path.join(vaultRoot, "90-System", "State", "Locks", `inbox-${itemId}.lock`);
  await ensureDir(path.dirname(file));
  try {
    const handle = await fs.open(file, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, item_id: itemId, acquired_at: new Date().toISOString() }));
    return handle;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      let pid: number | null = null;
      try { pid = Number(JSON.parse(await fs.readFile(file, "utf8")).pid); } catch { pid = null; }
      if (pid && Number.isInteger(pid)) {
        try { process.kill(pid, 0); throw new PkbError("INBOX_ITEM_IN_PROGRESS", `Inbox item ${itemId} is already being processed.`); }
        catch (lockError) { if (lockError instanceof PkbError) throw lockError; }
      }
      await fs.unlink(file).catch(() => undefined);
      const handle = await fs.open(file, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, item_id: itemId, acquired_at: new Date().toISOString(), recovered_stale_lock: true }));
      return handle;
    }
    throw error;
  }
}

async function releaseItemLock(vaultRoot: string, itemId: string, handle: FileHandle): Promise<void> {
  await handle.close().catch(() => undefined);
  await fs.unlink(path.join(vaultRoot, "90-System", "State", "Locks", `inbox-${itemId}.lock`)).catch(() => undefined);
}

async function routeDestination(vaultRoot: string, item: InboxItemView, moduleId: string, instanceId: string | null): Promise<string> {
  const modules = (await discoverModules(ENGINE_ROOT)).filter((entry) => entry.data.status === "enabled");
  const module = modules.find((entry) => entry.data.id === moduleId);
  if (!module) throw new PkbError("INBOX_ROUTE_INVALID", `Module ${moduleId} is not enabled.`);
  if (instanceId) {
    const instance = (await discoverInstances(vaultRoot)).find((entry) => entry.data.instance_id === instanceId && entry.data.status === "active");
    if (!instance || instance.data.module_id !== moduleId || typeof instance.data.inbox_path !== "string") {
      throw new PkbError("INBOX_ROUTE_INVALID", `Instance ${instanceId} is not an active ${moduleId} instance.`);
    }
    return `${String(instance.data.inbox_path).replace(/\/$/, "")}/${item.filename}`;
  }
  const inbox = module.data.inbox as JsonObject | undefined;
  const level = inbox?.module_level as JsonObject | undefined;
  if (level?.enabled !== true || typeof level.path !== "string") throw new PkbError("INBOX_ROUTE_INVALID", `Module ${moduleId} has no module Inbox.`);
  return `${level.path.replace(/\/$/, "")}/${item.filename}`;
}

async function executeRoute(vaultRoot: string, item: InboxItemView, moduleId: string, instanceId: string | null): Promise<JsonObject> {
  const destination = await routeDestination(vaultRoot, item, moduleId, instanceId);
  if (destination === item.path) return { status: "waiting-for-ai", ui_state: "waiting-for-ai", item_id: item.item_id, path: item.path, reason: "Item is already in the selected module Inbox; its module workflow requires Codex." };
  if (await exists(fromVaultPath(vaultRoot, destination))) throw new PkbError("DESTINATION_EXISTS", `Inbox destination already exists: ${destination}`);
  const runId = await allocateId(vaultRoot, "RUN");
  const taskId = await allocateId(vaultRoot, "TASK");
  const planId = await allocateId(vaultRoot, "PLAN");
  const plan: OperationPlan = {
    plan_id: planId, task_id: taskId, source_module: moduleId, instance_id: instanceId,
    summary: `Route Inbox item to ${instanceId ?? moduleId}`,
    operations: [{
      operation_id: "OP-001", type: "move-file", target: item.path, risk: "green", confidence: item.confidence,
      idempotency_key: `inbox-route:${createHash("sha256").update(`${item.item_id}:${destination}`).digest("hex")}`,
      payload: { destination }, requires_review_id: null,
    }], review_items: [],
  };
  await writeJsonAtomic(path.join(vaultRoot, "90-System", "State", "Plans", `${planId}.json`), plan);
  const startedAt = new Date().toISOString();
  const snapshot = await createGitSnapshot(vaultRoot, runId);
  await executeOperationPlan(vaultRoot, plan, { allowedTypes: ["move-file"], allowedTargets: [item.path], requiredReviewId: null, gitSnapshot: snapshot });
  const run: RunLog = {
    run_id: runId, task_id: taskId, plan_id: planId, source_module: moduleId, instance_id: instanceId,
    review_id: null, status: "completed", git_snapshot: snapshot, started_at: startedAt, completed_at: new Date().toISOString(), schema_version: 1,
  };
  await writeRunLog(vaultRoot, run, `# ${runId}\n\nRouted Inbox item.\n\n- From: ${item.path}\n- To: ${destination}\n`);
  await writeInboxState(vaultRoot, stateFor(item, "processed", { attempts: 1, run_id: runId, plan_id: planId, result: { destination } }));
  await rebuildTodayDashboard(vaultRoot);
  return { status: "routed", item_id: item.item_id, source: item.path, destination, module_id: moduleId, instance_id: instanceId, run_id: runId, plan_id: planId, snapshot };
}

export async function processInboxItem(vaultRoot: string, params: ProcessInboxItemParams): Promise<JsonObject> {
  if (!params.item_id?.trim()) throw new PkbError("INVALID_REQUEST", "item_id is required.");
  const action = params.action ?? "process";
  const item = await findItem(vaultRoot, params.item_id);
  const moduleId = normalizedOptional(params.module_id) ?? item.suggested_module_id;
  const instanceId = normalizedOptional(params.instance_id) ?? item.suggested_instance_id;
  if (action === "preview") return preview(item, { moduleId, instanceId });
  if (action === "defer") {
    if (!params.review_after || !Number.isFinite(Date.parse(params.review_after)) || Date.parse(params.review_after) <= Date.now()) throw new PkbError("INVALID_REQUEST", "review_after must be a future ISO date-time.");
    await writeInboxState(vaultRoot, stateFor(item, "deferred", { review_after: new Date(params.review_after).toISOString() }));
    await rebuildTodayDashboard(vaultRoot);
    return { status: "deferred", item_id: item.item_id, review_after: new Date(params.review_after).toISOString() };
  }
  if (action === "ignore" || action === "unmanage") {
    await writeInboxState(vaultRoot, stateFor(item, action === "ignore" ? "ignored" : "unmanaged"));
    await rebuildTodayDashboard(vaultRoot);
    return { status: action === "ignore" ? "ignored" : "unmanaged", item_id: item.item_id, path: item.path };
  }
  if (item.state === "failed" && action !== "retry") throw new PkbError("INBOX_RETRY_REQUIRED", "Failed Inbox items must be retried explicitly.");
  if (!moduleId) return { status: "waiting-for-user", ui_state: "waiting-for-user", item_id: item.item_id, path: item.path, reason: "No reliable module route is available.", preview: preview(item) };

  const lock = await acquireItemLock(vaultRoot, item.item_id);
  try {
    await writeInboxState(vaultRoot, stateFor(item, "processing", { attempts: action === "retry" ? 2 : 1 }));
    if (item.processor === "application-research-report" && moduleId === "application-tracker") {
      const result = await processApplicationReport({ vaultRoot, reportPath: item.path });
      await writeInboxState(vaultRoot, stateFor(item, "processed", { attempts: 1, run_id: result.runId, result: result as unknown as JsonValue }));
      return { status: result.status, item_id: item.item_id, processor: item.processor, result: result as unknown as JsonValue };
    }
    if (item.scope === "global" || action === "route" || moduleId !== item.source_module || instanceId !== item.instance_id) {
      return await executeRoute(vaultRoot, item, moduleId, instanceId);
    }
    const waiting = { status: "waiting-for-ai", ui_state: "waiting-for-ai", item_id: item.item_id, path: item.path, module_id: moduleId, instance_id: instanceId, reason: "This module workflow requires a Codex handoff; no file change was executed." };
    await writeInboxState(vaultRoot, stateFor(item, "waiting-for-ai", { attempts: 1, result: waiting }));
    return waiting;
  } catch (error) {
    await writeInboxState(vaultRoot, stateFor(item, "failed", { attempts: 1, error: error instanceof Error ? error.message : String(error) })).catch(() => undefined);
    throw error;
  } finally {
    await releaseItemLock(vaultRoot, item.item_id, lock);
  }
}

export async function processInboxBatch(vaultRoot: string, params: ProcessInboxBatchParams): Promise<JsonObject> {
  if (params.mode !== "high-confidence") throw new PkbError("INVALID_REQUEST", "Batch mode must be high-confidence.");
  if (!Array.isArray(params.item_ids) || params.item_ids.length === 0) throw new PkbError("INVALID_REQUEST", "An explicit non-empty item_ids list is required.");
  if (params.item_ids.length > 50) throw new PkbError("INVALID_REQUEST", "A batch can contain at most 50 Inbox items.");
  const unique = [...new Set(params.item_ids)];
  const discovered = await discoverInboxItems(vaultRoot);
  const results: JsonObject[] = [];
  for (const id of unique) {
    const item = discovered.find((candidate) => candidate.item_id === id);
    if (!item) { results.push({ item_id: id, status: "skipped", reason: "not-found" }); continue; }
    if (item.confidence < item.auto_route_threshold) { results.push({ item_id: id, status: "skipped", reason: "below-auto-route-threshold" }); continue; }
    if (item.requires_ai) { results.push({ item_id: id, status: "skipped", reason: "requires-ai" }); continue; }
    try { results.push({ item_id: id, status: "completed", result: await processInboxItem(vaultRoot, { item_id: id, action: item.state === "failed" ? "retry" : "process" }) }); }
    catch (error) { results.push({ item_id: id, status: "failed", error: error instanceof Error ? error.message : String(error) }); }
  }
  return {
    status: "batch-completed", requested: unique.length,
    completed: results.filter((entry) => entry.status === "completed").length,
    skipped: results.filter((entry) => entry.status === "skipped").length,
    failed: results.filter((entry) => entry.status === "failed").length,
    results,
  };
}
