import { promises as fs } from "node:fs";
import path from "node:path";
import type { JsonObject, MarkdownDocument, Operation, OperationPlan } from "./types.js";
import { parseMarkdown, validateSchema, writeMarkdown } from "./bridge.js";
import { PkbError } from "./errors.js";
import { deepMerge, ensureDir, exists, fromVaultPath } from "./files.js";
import { appendToSection } from "./markdown.js";

const PLAN_SCHEMA = "https://pkb.local/schemas/core/operation-plan.schema.json";
const SUPPORTED_TYPES = new Set(["create-file", "update-frontmatter", "append-section", "move-file"]);

export interface ExecutionPolicy {
  allowedTypes?: readonly string[];
  allowedTargets?: readonly string[];
  requiredReviewId?: string | null;
}

interface FileSnapshot {
  path: string;
  existed: boolean;
  content: Buffer | null;
}

function resolveVaultPath(vaultRoot: string, vaultPath: string): string {
  const absolute = fromVaultPath(vaultRoot, vaultPath);
  const relative = path.relative(vaultRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PkbError("PERMISSION_DENIED", "Operation Plan 指向 Vault 之外。", vaultPath);
  }
  return absolute;
}

function checkPermissions(plan: OperationPlan, policy: ExecutionPolicy): void {
  const allowedTypes = new Set(policy.allowedTypes ?? [...SUPPORTED_TYPES]);
  const allowedTargets = policy.allowedTargets ? new Set(policy.allowedTargets) : null;
  for (const operation of plan.operations) {
    if (!SUPPORTED_TYPES.has(operation.type) || !allowedTypes.has(operation.type)) {
      throw new PkbError("OPERATION_NOT_ALLOWED", `不允许执行操作：${operation.type}`, operation);
    }
    if (!operation.target || (allowedTargets && !allowedTargets.has(operation.target))) {
      throw new PkbError("TARGET_NOT_ALLOWED", "Operation Plan 目标不在授权范围内。", operation);
    }
    if (policy.requiredReviewId !== undefined && operation.requires_review_id !== policy.requiredReviewId) {
      throw new PkbError("REVIEW_AUTHORIZATION_MISMATCH", "操作的审核授权不匹配。", operation);
    }
  }
}

async function snapshotFile(filePath: string): Promise<FileSnapshot> {
  const present = await exists(filePath);
  return { path: filePath, existed: present, content: present ? await fs.readFile(filePath) : null };
}

async function restoreSnapshots(snapshots: Map<string, FileSnapshot>): Promise<void> {
  for (const snapshot of [...snapshots.values()].reverse()) {
    if (snapshot.existed && snapshot.content) {
      await ensureDir(path.dirname(snapshot.path));
      await fs.writeFile(snapshot.path, snapshot.content);
    } else if (await exists(snapshot.path)) {
      await fs.unlink(snapshot.path);
    }
  }
}

async function capture(
  snapshots: Map<string, FileSnapshot>,
  filePath: string,
): Promise<void> {
  if (!snapshots.has(filePath)) {
    snapshots.set(filePath, await snapshotFile(filePath));
  }
}

function requireObject(value: unknown, operation: Operation, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PkbError("INVALID_OPERATION", `${label} 必须是对象。`, operation);
  }
  return value as JsonObject;
}

async function executeOperation(
  vaultRoot: string,
  operation: Operation,
  snapshots: Map<string, FileSnapshot>,
): Promise<void> {
  const target = resolveVaultPath(vaultRoot, operation.target!);
  await capture(snapshots, target);

  if (operation.type === "create-file") {
    if (await exists(target)) {
      throw new PkbError("TARGET_EXISTS", "create-file target already exists.", operation.target);
    }
    const document = requireObject(operation.payload.document, operation, "document");
    const data = requireObject(document.data, operation, "document.data");
    const content = document.content;
    if (typeof content !== "string") {
      throw new PkbError("INVALID_OPERATION", "document.content must be a string.", operation);
    }
    const schemaId = operation.payload.schema_id;
    if (typeof schemaId === "string") validateSchema(vaultRoot, schemaId, data);
    await ensureDir(path.dirname(target));
    writeMarkdown(vaultRoot, target, { data, content });
    return;
  }

  if (operation.type === "update-frontmatter") {
    const document = parseMarkdown(vaultRoot, target);
    const patch = requireObject(operation.payload.patch, operation, "patch");
    const updated: MarkdownDocument = {
      data: deepMerge(document.data, patch),
      content: document.content,
    };
    const schemaId = operation.payload.schema_id;
    if (typeof schemaId === "string") {
      validateSchema(vaultRoot, schemaId, updated.data);
    }
    writeMarkdown(vaultRoot, target, updated);
    return;
  }

  if (operation.type === "append-section") {
    const document = parseMarkdown(vaultRoot, target);
    const updated: MarkdownDocument = {
      data: document.data,
      content: appendToSection(
        document.content,
        String(operation.payload.section ?? "Changes"),
        String(operation.payload.content ?? ""),
        String(operation.payload.marker ?? operation.idempotency_key),
      ),
    };
    writeMarkdown(vaultRoot, target, updated);
    return;
  }

  if (operation.type === "move-file") {
    const destinationValue = operation.payload.destination;
    if (typeof destinationValue !== "string") {
      throw new PkbError("INVALID_OPERATION", "move-file 缺少 Vault 相对 destination。", operation);
    }
    const destination = resolveVaultPath(vaultRoot, destinationValue);
    await capture(snapshots, destination);
    if (await exists(destination)) {
      throw new PkbError("DESTINATION_EXISTS", "移动目标已存在。", destinationValue);
    }
    await ensureDir(path.dirname(destination));
    await fs.rename(target, destination);
    return;
  }
}

export async function executeOperationPlan(
  vaultRoot: string,
  plan: OperationPlan,
  policy: ExecutionPolicy = {},
): Promise<void> {
  validateSchema(vaultRoot, PLAN_SCHEMA, plan);
  checkPermissions(plan, policy);
  const snapshots = new Map<string, FileSnapshot>();
  try {
    for (const operation of plan.operations) {
      await executeOperation(vaultRoot, operation, snapshots);
    }
  } catch (error) {
    await restoreSnapshots(snapshots);
    throw error;
  }
}
