import { promises as fs } from "node:fs";
import path from "node:path";
import type { JsonObject, OperationPlan } from "./types.js";
import { parseMarkdown, parseYaml, validateSchema } from "./bridge.js";
import { PkbError } from "./errors.js";
import { listFilesRecursive, readJson, toVaultPath, writeJsonAtomic } from "./files.js";
import { createGitSnapshot } from "./git.js";
import { allocateId } from "./ids.js";
import { executeOperationPlan, rollbackTransaction } from "./operationExecutor.js";
import { writeRunLog } from "./logs.js";

export interface MigrationDefinition extends JsonObject {
  migration_id: string;
  module_id: string;
  entity_type: string;
  schema_id: string;
  from_version: number;
  to_version: number;
  roots: string[];
  steps: JsonObject[];
  reversible: boolean;
  requires: JsonObject;
}

export interface MigrationRun {
  migration_run_id: string;
  run_id: string | null;
  definition_id: string;
  module_id: string;
  from_version: number;
  to_version: number;
  status: "not-started" | "in-progress" | "completed" | "partially-failed" | "rolled-back" | "manual-action-required";
  targets: string[];
  plan: OperationPlan;
  git_snapshot: string | null;
  created_at: string;
  updated_at: string;
  error: string | null;
}

function assertDefinition(value: JsonObject, source: string): MigrationDefinition {
  const required = ["migration_id", "module_id", "entity_type", "schema_id"];
  for (const field of required) if (typeof value[field] !== "string" || value[field] === "") throw new PkbError("INVALID_MIGRATION", `${source} is missing ${field}.`);
  if (!Number.isInteger(value.from_version) || !Number.isInteger(value.to_version) || Number(value.to_version) !== Number(value.from_version) + 1) {
    throw new PkbError("INVALID_MIGRATION", `${source} must migrate exactly one schema version.`);
  }
  if (!Array.isArray(value.roots) || !Array.isArray(value.steps)) throw new PkbError("INVALID_MIGRATION", `${source} requires roots and steps arrays.`);
  if (value.reversible !== true && value.reversible !== false) value.reversible = false;
  if (!value.requires || typeof value.requires !== "object" || Array.isArray(value.requires)) value.requires = { git_snapshot: true, user_confirmation: !value.reversible };
  return value as MigrationDefinition;
}

export async function discoverMigrationDefinitions(engineRoot: string): Promise<MigrationDefinition[]> {
  const definitions: MigrationDefinition[] = [];
  for (const file of await listFilesRecursive(path.join(engineRoot, "modules"), ".yaml")) {
    const parts = file.split(path.sep); const migrationsIndex = parts.lastIndexOf("migrations");
    if (migrationsIndex < 0) continue;
    const belowMigrations = parts.slice(migrationsIndex + 1);
    if (belowMigrations.length > 2) continue;
    if (path.basename(file) !== "migration.yaml" && !path.basename(file).match(/v\d+-to-v\d+\.yaml$/)) continue;
    definitions.push(assertDefinition(parseYaml(engineRoot, file), toVaultPath(engineRoot, file)));
  }
  definitions.sort((a, b) => a.migration_id.localeCompare(b.migration_id));
  return definitions;
}

export async function rollbackMigration(vaultRoot: string, migrationRunId: string): Promise<MigrationRun> {
  const file = path.join(vaultRoot, "90-System", "State", "Migrations", `${migrationRunId}.json`);
  const run = await readJson<MigrationRun | null>(file, null);
  if (!run) throw new PkbError("MIGRATION_NOT_FOUND", `Migration run ${migrationRunId} was not found.`);
  if (run.status !== "completed") throw new PkbError("MIGRATION_ROLLBACK_INVALID", `Migration run is ${run.status}.`);
  await rollbackTransaction(vaultRoot, run.plan.plan_id);
  run.status = "rolled-back"; run.updated_at = new Date().toISOString(); run.error = null;
  await writeJsonAtomic(file, run);
  return run;
}

export async function planMigrations(vaultRoot: string, engineRoot: string): Promise<MigrationRun[]> {
  const runs: MigrationRun[] = [];
  const existingRuns: MigrationRun[] = [];
  const migrationRoot = path.join(vaultRoot, "90-System", "State", "Migrations");
  for (const file of await listFilesRecursive(migrationRoot, ".json")) {
    const existing = await readJson<MigrationRun | null>(file, null);
    if (existing) existingRuns.push(existing);
  }
  for (const definition of await discoverMigrationDefinitions(engineRoot)) {
    const targets: string[] = [];
    for (const root of definition.roots) {
      for (const file of await listFilesRecursive(path.join(vaultRoot, ...root.split("/")), ".md")) {
        const document = parseMarkdown(vaultRoot, file);
        if (document.data.type === definition.entity_type && document.data.schema_version === definition.from_version) {
          targets.push(toVaultPath(vaultRoot, file));
        }
      }
    }
    if (targets.length === 0) continue;
    targets.sort();
    const active = existingRuns.find((candidate) =>
      candidate.definition_id === definition.migration_id &&
      ["not-started", "in-progress", "partially-failed", "manual-action-required"].includes(candidate.status) &&
      JSON.stringify([...candidate.targets].sort()) === JSON.stringify(targets),
    );
    if (active) {
      runs.push(active);
      continue;
    }
    const migrationRunId = await allocateId(vaultRoot, "MIG");
    const taskId = await allocateId(vaultRoot, "TASK");
    const planId = await allocateId(vaultRoot, "PLAN");
    const runId = await allocateId(vaultRoot, "RUN");
    const now = new Date().toISOString();
    const plan: OperationPlan = {
      plan_id: planId, task_id: taskId, source_module: definition.module_id, instance_id: null,
      summary: `Migrate ${definition.entity_type} from schema ${definition.from_version} to ${definition.to_version}.`,
      operations: targets.map((target, index) => ({
        operation_id: `OP-${String(index + 1).padStart(3, "0")}`,
        type: "migrate-frontmatter", target, risk: "yellow", confidence: 1,
        idempotency_key: `${definition.migration_id}:${target}`,
        payload: { from_version: definition.from_version, to_version: definition.to_version, steps: definition.steps, schema_id: definition.schema_id },
        requires_review_id: null,
      })),
      review_items: [],
    };
    const run: MigrationRun = {
      migration_run_id: migrationRunId, run_id: runId, definition_id: definition.migration_id, module_id: definition.module_id,
      from_version: definition.from_version, to_version: definition.to_version, status: "not-started", targets,
      plan, git_snapshot: null, created_at: now, updated_at: now, error: null,
    };
    await writeJsonAtomic(path.join(vaultRoot, "90-System", "State", "Migrations", `${migrationRunId}.json`), run);
    runs.push(run);
  }
  return runs;
}

export async function applyMigration(vaultRoot: string, migrationRunId: string): Promise<MigrationRun> {
  const file = path.join(vaultRoot, "90-System", "State", "Migrations", `${migrationRunId}.json`);
  const run = await readJson<MigrationRun | null>(file, null);
  if (!run) throw new PkbError("MIGRATION_NOT_FOUND", `Migration run ${migrationRunId} was not found.`);
  if (run.run_id === undefined || run.run_id === null) run.run_id = await allocateId(vaultRoot, "RUN");
  if (run.status === "completed") {
    await writeRunLog(vaultRoot, {
      run_id: run.run_id, task_id: run.plan.task_id, plan_id: run.plan.plan_id, source_module: run.module_id,
      instance_id: null, review_id: null, status: "completed", git_snapshot: run.git_snapshot,
      started_at: run.created_at, completed_at: run.updated_at, schema_version: 1,
    }, `# ${run.run_id}\n\nMigration ${run.definition_id} completed for ${run.targets.length} file(s).\n`);
    await writeJsonAtomic(file, run);
    return run;
  }
  if (run.status !== "not-started") throw new PkbError("MIGRATION_NOT_STARTABLE", `Migration run is ${run.status}.`);
  run.status = "in-progress";
  run.updated_at = new Date().toISOString();
  await writeJsonAtomic(file, run);
  try {
    run.git_snapshot = await createGitSnapshot(vaultRoot, migrationRunId);
    await writeJsonAtomic(path.join(vaultRoot, "90-System", "State", "Plans", `${run.plan.plan_id}.json`), run.plan);
    await executeOperationPlan(vaultRoot, run.plan, {
      allowedTypes: ["migrate-frontmatter"], allowedTargets: run.targets, requiredReviewId: null, gitSnapshot: run.git_snapshot,
    });
    for (const target of run.targets) {
      const data = parseMarkdown(vaultRoot, path.join(vaultRoot, ...target.split("/"))).data;
      if (data.schema_version !== run.to_version) throw new PkbError("MIGRATION_VALIDATION_FAILED", `${target} has the wrong schema_version.`);
      const schemaId = String(run.plan.operations[0]?.payload.schema_id ?? "");
      validateSchema(vaultRoot, schemaId, data);
    }
    run.status = "completed";
  } catch (error) {
    let transaction = await readJson<{ status?: string } | null>(
      path.join(vaultRoot, "90-System", "State", "Transactions", run.plan.plan_id, "transaction.json"),
      null,
    );
    if (transaction?.status === "completed") {
      try {
        await rollbackTransaction(vaultRoot, run.plan.plan_id);
        transaction = { status: "rolled-back" };
      } catch {
        transaction = { status: "manual-action-required" };
      }
    }
    run.status = transaction?.status === "manual-action-required"
      ? "manual-action-required"
      : transaction?.status === "rolled-back"
        ? "rolled-back"
        : transaction
          ? "partially-failed"
          : "not-started";
    run.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    run.updated_at = new Date().toISOString();
    await writeJsonAtomic(file, run);
    await writeRunLog(vaultRoot, {
      run_id: run.run_id!, task_id: run.plan.task_id, plan_id: run.plan.plan_id, source_module: run.module_id,
      instance_id: null, review_id: null, status: run.status === "completed" ? "completed" : "failed",
      git_snapshot: run.git_snapshot, started_at: run.created_at, completed_at: run.updated_at, schema_version: 1,
    }, `# ${run.run_id}\n\nMigration ${run.definition_id}: ${run.status}.\n`);
  }
  return run;
}
