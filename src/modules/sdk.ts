import { promises as fs } from "node:fs";
import path from "node:path";
import type { CreateTaskInput, TaskResources } from "../runtime/domain.js";
import type { DashboardItem, JsonObject, JsonValue, Operation, OperationPlan, ReviewItem } from "../core/types.js";
import { PkbError } from "../core/errors.js";
import { assertReadLevel, type ReadLevel } from "../core/readLevels.js";

export interface ModuleContext {
  vaultRoot: string;
  moduleId: string;
  moduleVersion: string;
  instanceId: string | null;
  allowedReadRoots: string[];
  ownedWriteRoots: string[];
  /** 0 = metadata, 1 = summary, 2 = full, 3 = sensitive original. */
  maxReadLevel: ReadLevel;
}

export type { ReadLevel } from "../core/readLevels.js";

export interface ModuleAdapter {
  match(input: JsonObject): Promise<JsonObject>;
  process(input: JsonObject): Promise<JsonObject>;
  resolveReview(input: JsonObject): Promise<JsonObject>;
  getDashboardItems(input: JsonObject): Promise<JsonObject>;
  archive(input: JsonObject): Promise<JsonObject>;
  createInstance?(input: JsonObject): Promise<JsonObject>;
  validateInstance?(input: JsonObject): Promise<JsonObject>;
  migrate?(input: JsonObject): Promise<JsonObject>;
  getScheduledJobs?(input: JsonObject): Promise<JsonObject>;
  handleEvent?(input: JsonObject): Promise<JsonObject>;
  healthCheck?(input: JsonObject): Promise<JsonObject>;
}

function normalize(relative: string): string {
  const value = relative.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!value || value.split("/").includes("..") || /^[A-Za-z]:/.test(value)) throw new PkbError("MODULE_PATH_INVALID", "Module paths must be Vault-relative.");
  return value;
}

function within(target: string, roots: string[]): boolean { return roots.some((root) => target === normalize(root) || target.startsWith(`${normalize(root)}/`)); }

export class ModuleSdk {
  constructor(readonly context: ModuleContext) {}

  canRead(relativePath: string, readLevel: number = 0): boolean {
    try {
      const target = normalize(relativePath);
      return assertReadLevel(readLevel) <= this.context.maxReadLevel && within(target, this.context.allowedReadRoots);
    } catch { return false; }
  }

  assertReadable(relativePath: string, readLevel: number = 0): string {
    const target = normalize(relativePath);
    const requested = assertReadLevel(readLevel);
    if (!this.canRead(target, requested)) throw new PkbError("MODULE_READ_DENIED", `Module ${this.context.moduleId} cannot read ${target} at level ${requested}.`, {
      source_path: target, requested_read_level: requested, module_max_read_level: this.context.maxReadLevel,
    });
    return target;
  }

  async readText(relativePath: string, readLevel: number): Promise<string> {
    const target = this.assertReadable(relativePath, readLevel);
    return fs.readFile(path.join(this.context.vaultRoot, ...target.split("/")), "utf8");
  }

  buildOperationPlan(input: { planId: string; taskId: string; summary: string; operations: Operation[]; reviews?: ReviewItem[] }): OperationPlan {
    for (const operation of input.operations) {
      if (operation.target && !within(normalize(operation.target), this.context.ownedWriteRoots)) throw new PkbError("MODULE_WRITE_DENIED", `Module ${this.context.moduleId} cannot propose a write to ${operation.target}.`);
      if (operation.type === "delete-file") throw new PkbError("MODULE_RED_OPERATION_DENIED", "Module SDK cannot propose delete operations without a Core-owned confirmation flow.");
    }
    return { plan_id: input.planId, task_id: input.taskId, source_module: this.context.moduleId, instance_id: this.context.instanceId, summary: input.summary, operations: structuredClone(input.operations), review_items: structuredClone(input.reviews ?? []) };
  }

  buildReview(input: Omit<ReviewItem, "source_module" | "instance_id">): ReviewItem {
    return { ...structuredClone(input), source_module: this.context.moduleId, instance_id: this.context.instanceId } as ReviewItem;
  }

  buildDashboardItem(input: Omit<DashboardItem, "source_module" | "instance_id">): DashboardItem {
    return { ...structuredClone(input), source_module: this.context.moduleId, instance_id: this.context.instanceId } as DashboardItem;
  }

  buildEvent(input: JsonObject): JsonObject {
    return { ...structuredClone(input), source_module: this.context.moduleId, instance_id: this.context.instanceId };
  }

  declareTask(input: { jobId: string; workflow: string; idempotencyKey: string; resources: TaskResources; payload?: JsonObject }): CreateTaskInput {
    return { job_id: input.jobId, module: this.context.moduleId, instance_id: this.context.instanceId, task_type: "workflow", workflow: input.workflow, resources: input.resources, trigger: { type: "module-sdk" }, catch_up_policy: "none", idempotency_key: input.idempotencyKey, payload: structuredClone(input.payload ?? {}) };
  }

  static assertStructuredResult(value: JsonValue, label: string): JsonObject {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new PkbError("MODULE_CONTRACT_INVALID", `${label} must return a structured object.`);
    return value;
  }
}
