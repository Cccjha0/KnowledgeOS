import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CreateCaptureParams } from "../api/types.js";
import { inferCaptureContext, type CaptureContext } from "../core/capture.js";
import { parseMarkdown, validateSchema } from "../core/bridge.js";
import { PkbError } from "../core/errors.js";
import { exists, fromVaultPath, sha256File, toVaultPath, writeJsonAtomic, readJson } from "../core/files.js";
import { createGitSnapshot } from "../core/git.js";
import { allocateId } from "../core/ids.js";
import { writeRunLog } from "../core/logs.js";
import { executeOperationPlan } from "../core/operationExecutor.js";
import type { JsonObject, JsonValue, OperationPlan, RunLog } from "../core/types.js";
import { rebuildTodayDashboard } from "./dashboard.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CAPTURE_SCHEMA = "https://pkb.local/schemas/core/capture.schema.json";

export interface CaptureResult extends JsonObject {
  status: "saved" | "preview";
  capture_id: string | null;
  path: string | null;
  destination_scope: "global" | "module" | "instance";
  destination_label: string;
  module_id: string | null;
  instance_id: string | null;
  route_reason: CaptureContext["reason"];
  run_id: string | null;
  plan_id: string | null;
  snapshot: string | null;
  created_at: string | null;
  today_path: string | null;
  actions: string[];
}

interface CaptureReceipt {
  request_id: string;
  params_hash: string;
  status: "prepared" | "failed" | "completed";
  attempt: number;
  capture_id: string;
  target: string;
  created_at: string;
  context: CaptureContext;
  run_id: string | null;
  task_id: string | null;
  plan_id: string | null;
  snapshot: string | null;
  result: CaptureResult | null;
  error: string | null;
  updated_at: string;
}

function normalizeOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizedParams(params: CreateCaptureParams): CreateCaptureParams {
  return {
    content: params.content ?? "",
    title: normalizeOptional(params.title),
    module_id: normalizeOptional(params.module_id),
    instance_id: normalizeOptional(params.instance_id),
    content_type: normalizeOptional(params.content_type) ?? "note",
    attachments: Array.isArray(params.attachments) ? params.attachments.map((item) => item.trim()).filter(Boolean) : [],
    active_path: normalizeOptional(params.active_path),
    preview_only: params.preview_only === true,
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function receiptPath(vaultRoot: string, requestId: string): string {
  return path.join(vaultRoot, "90-System", "State", "Requests", `capture-${digest(requestId)}.json`);
}

function displayTitle(params: CreateCaptureParams): string {
  if (params.title) return params.title;
  const first = (params.content ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "Quick Capture";
  return first.replace(/^#+\s*/, "").slice(0, 80) || "Quick Capture";
}

function safeFilenamePart(value: string): string {
  let safe = value.normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[. -]+|[. -]+$/g, "")
    .slice(0, 60);
  if (!safe) safe = "capture";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safe)) safe = `capture-${safe}`;
  return safe;
}

function targetPath(context: CaptureContext, title: string, createdAt: string, requestId: string): string {
  const stamp = createdAt.replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${context.destination.replace(/\/$/, "")}/${stamp}-${safeFilenamePart(title)}-${digest(requestId).slice(0, 8)}.md`;
}

function preview(context: CaptureContext): CaptureResult {
  return {
    status: "preview", capture_id: null, path: null,
    destination_scope: context.scope, destination_label: context.destinationLabel,
    module_id: context.moduleId, instance_id: context.instanceId, route_reason: context.reason,
    run_id: null, plan_id: null, snapshot: null, created_at: null, today_path: null, actions: [],
  };
}

function resultFromReceipt(receipt: CaptureReceipt, todayPath: string | null): CaptureResult {
  return {
    status: "saved", capture_id: receipt.capture_id, path: receipt.target,
    destination_scope: receipt.context.scope, destination_label: receipt.context.destinationLabel,
    module_id: receipt.context.moduleId, instance_id: receipt.context.instanceId, route_reason: receipt.context.reason,
    run_id: receipt.run_id, plan_id: receipt.plan_id, snapshot: receipt.snapshot,
    created_at: receipt.created_at, today_path: todayPath, actions: ["open", "capture-another"],
  };
}

async function validateAttachments(vaultRoot: string, attachments: string[]): Promise<void> {
  for (const attachment of attachments) {
    const normalized = attachment.replace(/\\/g, "/");
    const absolute = fromVaultPath(vaultRoot, normalized);
    const relative = path.relative(vaultRoot, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new PkbError("INVALID_ATTACHMENT", `Attachment is outside the Vault: ${attachment}`);
    }
    if (!(await exists(absolute))) throw new PkbError("ATTACHMENT_NOT_FOUND", `Attachment was not found: ${attachment}`);
  }
}

function markdownContent(title: string, params: CreateCaptureParams): string {
  let output = params.title ? `# ${title}\n\n${params.content ?? ""}` : params.content ?? "";
  const attachments = params.attachments ?? [];
  if (attachments.length > 0) {
    output = `${output.replace(/\n*$/, "")}\n\n## Attachments\n\n${attachments
      .map((item) => `- [[${item.replace(/\.md$/i, "")}]]`).join("\n")}`;
  }
  return output.endsWith("\n") ? output : `${output}\n`;
}

async function finalizeCapture(
  vaultRoot: string,
  receipt: CaptureReceipt,
  params: CreateCaptureParams,
  data: JsonObject,
): Promise<CaptureResult> {
  const target = fromVaultPath(vaultRoot, receipt.target);
  const envelope: JsonObject = {
    capture_id: receipt.capture_id,
    path: receipt.target,
    filename: path.posix.basename(receipt.target),
    extension: ".md",
    source_level: receipt.context.scope === "global" ? "global-inbox" : `${receipt.context.scope}-inbox`,
    module_id_hint: receipt.context.moduleId,
    instance_id_hint: receipt.context.instanceId,
    created_at: receipt.created_at,
    modified_at: receipt.created_at,
    file_hash: `sha256:${await sha256File(target)}`,
    frontmatter: data,
    text_preview: (params.content ?? "").slice(0, 500),
    content_read_level: 0,
    attachment_metadata: { count: (params.attachments ?? []).length, paths: params.attachments ?? [] },
  };
  validateSchema(vaultRoot, CAPTURE_SCHEMA, envelope);
  await writeJsonAtomic(path.join(vaultRoot, "90-System", "State", "Captures", `${receipt.capture_id}.json`), envelope);

  const run: RunLog = {
    run_id: receipt.run_id!, task_id: receipt.task_id, plan_id: receipt.plan_id,
    source_module: receipt.context.moduleId ?? "core", instance_id: receipt.context.instanceId,
    review_id: null, status: "completed", git_snapshot: receipt.snapshot,
    started_at: receipt.created_at, completed_at: new Date().toISOString(), schema_version: 1,
  };
  await writeRunLog(vaultRoot, run, [
    `# ${receipt.run_id}`, "", "Quick Capture 已保存。", "",
    `- Capture: ${receipt.capture_id}`, `- 目标: ${receipt.target}`, `- 路由: ${receipt.context.reason}`, "",
  ].join("\n"));
  const today = await rebuildTodayDashboard(vaultRoot);
  const result = resultFromReceipt(receipt, toVaultPath(vaultRoot, today));
  receipt.status = "completed";
  receipt.result = result;
  receipt.error = null;
  receipt.updated_at = new Date().toISOString();
  await writeJsonAtomic(receiptPath(vaultRoot, receipt.request_id), receipt);
  return result;
}

export async function createCapture(options: {
  vaultRoot: string;
  requestId: string;
  params: CreateCaptureParams;
}): Promise<CaptureResult> {
  const params = normalizedParams(options.params);
  const context = await inferCaptureContext({
    vaultRoot: options.vaultRoot, engineRoot: ENGINE_ROOT,
    moduleId: params.module_id, instanceId: params.instance_id, activePath: params.active_path,
  });
  if (params.preview_only) return preview(context);
  if (!(params.content ?? "").trim()) throw new PkbError("CAPTURE_CONTENT_REQUIRED", "Capture content cannot be empty.");
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(params.content_type ?? "")) {
    throw new PkbError("INVALID_CONTENT_TYPE", "content_type must be a short lowercase identifier.");
  }
  await validateAttachments(options.vaultRoot, params.attachments ?? []);

  const requestPath = receiptPath(options.vaultRoot, options.requestId);
  const paramsHash = digest(JSON.stringify(params));
  let receipt = await readJson<CaptureReceipt | null>(requestPath, null);
  if (receipt && receipt.params_hash !== paramsHash) {
    throw new PkbError("IDEMPOTENCY_CONFLICT", "This request ID was already used with different Capture content.");
  }
  if (receipt?.status === "completed" && receipt.result) return receipt.result;
  if (receipt?.status === "prepared") {
    const age = Date.now() - Date.parse(receipt.updated_at);
    if (age < 120_000) throw new PkbError("CAPTURE_IN_PROGRESS", "This Capture request is already running.");
    receipt.status = "failed";
  }

  if (!receipt) {
    const createdAt = new Date().toISOString();
    const captureId = await allocateId(options.vaultRoot, "CAP");
    receipt = {
      request_id: options.requestId, params_hash: paramsHash, status: "failed", attempt: 0,
      capture_id: captureId, target: targetPath(context, displayTitle(params), createdAt, options.requestId),
      created_at: createdAt, context, run_id: null, task_id: null, plan_id: null, snapshot: null,
      result: null, error: null, updated_at: createdAt,
    };
  }

  const absoluteTarget = fromVaultPath(options.vaultRoot, receipt.target);
  if (await exists(absoluteTarget)) {
    const document = parseMarkdown(options.vaultRoot, absoluteTarget);
    if (document.data.capture_id !== receipt.capture_id) {
      throw new PkbError("CAPTURE_TARGET_CONFLICT", `Capture target is occupied by another file: ${receipt.target}`);
    }
    return finalizeCapture(options.vaultRoot, receipt, params, document.data);
  }

  const title = displayTitle(params);
  const data: JsonObject = {
    type: "capture", capture_id: receipt.capture_id, status: "new", title,
    source_module: receipt.context.moduleId, instance_id: receipt.context.instanceId,
    content_type: params.content_type ?? "note", attachments: params.attachments ?? [],
    created: receipt.created_at, captured_via: "plugin-core-api", request_id: options.requestId,
  };
  receipt.attempt += 1;
  receipt.run_id = await allocateId(options.vaultRoot, "RUN");
  receipt.task_id = await allocateId(options.vaultRoot, "TASK");
  receipt.plan_id = await allocateId(options.vaultRoot, "PLAN");
  receipt.status = "prepared";
  receipt.updated_at = new Date().toISOString();
  await writeJsonAtomic(requestPath, receipt);

  const plan: OperationPlan = {
    plan_id: receipt.plan_id, task_id: receipt.task_id,
    source_module: receipt.context.moduleId ?? "core", instance_id: receipt.context.instanceId,
    summary: `Save Quick Capture to ${receipt.context.destinationLabel}`,
    operations: [{
      operation_id: "OP-001", type: "create-file", target: receipt.target, risk: "green", confidence: 1,
      idempotency_key: `capture:${digest(options.requestId)}`, requires_review_id: null,
      payload: { document: { data, content: markdownContent(title, params) } },
    }],
    review_items: [],
  };
  await writeJsonAtomic(path.join(options.vaultRoot, "90-System", "State", "Plans", `${receipt.plan_id}.json`), plan);

  try {
    receipt.snapshot = await createGitSnapshot(options.vaultRoot, receipt.run_id);
    receipt.updated_at = new Date().toISOString();
    await writeJsonAtomic(requestPath, receipt);
    await executeOperationPlan(options.vaultRoot, plan, {
      allowedTypes: ["create-file"], allowedTargets: [receipt.target], requiredReviewId: null, gitSnapshot: receipt.snapshot,
    });
    return await finalizeCapture(options.vaultRoot, receipt, params, data);
  } catch (error) {
    receipt.status = "failed";
    receipt.error = error instanceof Error ? error.message : String(error);
    receipt.updated_at = new Date().toISOString();
    await writeJsonAtomic(requestPath, receipt);
    throw error;
  }
}
