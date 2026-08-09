import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { COMMAND_API_VERSION, type ClassifyInboxAttachmentParams, type CommandApiMethod, type CommandApiResponse, type CreateCaptureParams, type CreateInstanceParams, type LegacyAccessPolicyMigrationParams, type ManageInstanceParams, type ManageModuleParams, type ProcessInboxBatchParams, type ProcessInboxItemParams, type ResolveReviewParams, type ReviewPartialInboxExtractionParams, type UserFacingError } from "../api/types.js";
import { parseMarkdown, writeYaml } from "../core/bridge.js";
import { writeTodayMarkdown } from "../core/dashboard.js";
import { discoverInstances, discoverModulesForVault, discoverRoutingContext, type DiscoveredDocument } from "../core/discovery.js";
import { PkbError } from "../core/errors.js";
import { fromVaultPath, listFilesRecursive, readJson, toVaultPath, writeJsonAtomic } from "../core/files.js";
import { rollbackTransaction } from "../core/operationExecutor.js";
import type { JsonObject, JsonValue, ReviewItem, RunLog } from "../core/types.js";
import { allocateId } from "../core/ids.js";
import { writeRunLog } from "../core/logs.js";
import { decideReview, reconcileReviews, resolveReviewByUserEdit, retryReview } from "./reviewWorkflow.js";
import { getTodaySnapshot, rebuildTodayDashboard } from "./dashboard.js";
import { createCapture } from "./captureWorkflow.js";
import { buildDiscussionContext, buildReviewView, discussionContextIsCurrent } from "./reviewPresentation.js";
import { locateReviewItem, requeueDueReviews } from "../core/reviews.js";
import { discoverInboxContext, listInbox } from "./inboxDiscovery.js";
import { classifyInboxAttachment, materializeInboxAiTasks, processInboxBatch, processInboxItem, reviewPartialInboxExtraction } from "./inboxWorkflow.js";
import { assessRunRollback, findRun, getRunView, listRunViews } from "./systemPresentation.js";
import { createInstance, manageInstance, manageModule } from "./lifecycleWorkflow.js";
import { dispatchOnce } from "../runtime/dispatcher.js";
import type { TaskStatus } from "../runtime/domain.js";
import { reconcileStartup } from "../runtime/reconciler.js";
import { RuntimeRepository } from "../runtime/repository.js";
import { evaluateScheduler } from "../runtime/scheduler.js";
import { registerDeclaredJobs } from "../runtime/jobRegistry.js";
import { probeRuntimeResources } from "../runtime/resourceMonitor.js";
import { listCodexModels } from "../runtime/codexCli.js";
import { enqueueManualTask, materializeFieldDueJobs, materializeStartupJobs, publishRuntimeEvent } from "../runtime/triggers.js";
import { validateModule } from "../modules/validator.js";
import type { ModuleValidationReport } from "../modules/types.js";
import { runQualityAudit as executeQualityAudit, type AuditFrequency } from "../quality/audit.js";
import { getFieldProvenance, getQualityDashboard, getQualityDashboardFromRuntimeSnapshot } from "../quality/presentation.js";
import { QualityRepository } from "../quality/repository.js";
import { applyQualityBackfill, previewQualityBackfill } from "../quality/backfill.js";
import { resumeTasksAfterObsidianFileClose, syncObsidianOpenFiles } from "./obsidianCoordination.js";
import { readCaptureEnvelope, updateAssetAccessPolicy } from "../core/ingestion.js";
import { applyLegacyAccessPolicyMigration, previewLegacyAccessPolicyMigration, rollbackLegacyAccessPolicyMigration } from "../core/legacyAccessMigration.js";
import type { RepresentationLevel } from "../core/readLevels.js";
import { deriveBlueprintApproval, scaffoldModuleFromBlueprint, validateModuleBlueprint } from "../modules/blueprint.js";
import { analyzeGuidedModuleRequirement } from "../modules/guidedBuilder.js";
import { getModuleBuilderPlatformContract } from "../modules/platformContract.js";
import { getModuleReadiness, runModuleReadinessAction, type ModuleReadinessAction } from "../modules/readiness.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REVIEW_DIRECTORIES = ["Pending", "Deferred", "Closed", "Error"] as const;

async function withTemporaryBlueprint<T>(vaultRoot: string, requestId: string, blueprint: JsonObject, action: (file: string) => Promise<T>): Promise<T> {
  const root = path.join(vaultRoot, "90-System", "Cache", "Module Builder");
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, `${requestId.replace(/[^A-Za-z0-9_-]/g, "-")}.blueprint.yaml`);
  writeYaml(vaultRoot, file, blueprint);
  try { return await action(file); }
  finally { await fs.rm(file, { force: true }); }
}

interface CommandContext {
  vaultRoot: string;
  requestId: string;
  method: CommandApiMethod;
  params: JsonObject;
}

function stringParam(params: JsonObject, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) throw new PkbError("INVALID_REQUEST", `${key} is required.`);
  return value;
}

async function moduleViews(
  vaultRoot: string,
  instances?: Awaited<ReturnType<typeof discoverInstances>>,
  discoveredModules?: DiscoveredDocument[],
): Promise<JsonValue> {
  const discoveredInstances = instances ?? await discoverInstances(vaultRoot);
  const modules = discoveredModules ?? await discoverModulesForVault(ENGINE_ROOT, vaultRoot);
  const moduleLock = await readJson<{ modules?: Record<string, JsonObject> }>(path.join(vaultRoot, "90-System", "Modules", "module-lock.json"), { modules: {} });
  return await Promise.all(modules.map(async (module) => {
    const moduleId = String(module.data.id);
    const lockEntry = moduleLock.modules?.[moduleId];
    const configuredReport = typeof lockEntry?.validation_report === "string"
      ? path.join(vaultRoot, ...lockEntry.validation_report.split("/"))
      : path.join(path.dirname(module.path), "validation-report.json");
    const cachedReport = await readJson<ModuleValidationReport | null>(configuredReport, null);
    const report = cachedReport?.module_id === moduleId && cachedReport.module_version === String(module.data.version)
      ? cachedReport
      : null;
    return {
      id: module.data.id,
      name: module.data.name,
      version: module.data.version,
      status: module.data.status,
      description: module.data.description,
      ui: module.data.ui ?? null,
      maturity: module.data.maturity,
      schema_version: (module.data.data as JsonObject)?.schema_version ?? null,
      engine_api_version: (module.data.engine as JsonObject)?.api_version ?? null,
      health: report?.overall ?? "NOT_VALIDATED",
      validation_counts: report?.counts ?? { pass: 0, warning: 0, fail: 0 },
      beta_eligible: report?.beta_eligible ?? false,
      stable_eligible: report?.stable_eligible ?? false,
      prompt_versions: {},
      last_test_at: report?.generated_at ?? null,
      checksum: lockEntry?.checksum ?? null,
      previous_version: lockEntry?.previous_version ?? null,
      active_instance_count: discoveredInstances.filter((instance) => instance.data.module_id === module.data.id && instance.data.status === "active").length,
      instance_form: module.data.instance_form ?? null,
      available_actions: [module.data.status === "enabled" ? "disable" : "enable", "validate", "upgrade", ...(lockEntry?.previous_version ? ["rollback"] : []), ...(module.data.status === "enabled" && module.data.instance_form ? ["create-instance"] : [])],
    };
  })) as JsonValue;
}

function instanceViews(
  instances: Awaited<ReturnType<typeof discoverInstances>>,
  params: JsonObject,
): JsonValue {
  const moduleId = typeof params.module_id === "string" ? params.module_id : null;
  return instances.filter((instance) => !moduleId || instance.data.module_id === moduleId).map((instance) => ({
    ...instance.data,
    available_actions: instance.data.status === "active" ? ["pause", "complete", "archive"]
      : instance.data.status === "paused" ? ["resume", "complete", "archive"]
        : instance.data.status === "planned" ? ["activate", "archive"]
          : instance.data.status === "completed" || instance.data.status === "error" ? ["archive"] : [],
  })) as JsonValue;
}

async function listReviews(vaultRoot: string, params: JsonObject): Promise<JsonValue> {
  await requeueDueReviews(vaultRoot);
  const requested = Array.isArray(params.statuses)
    ? new Set(params.statuses.filter((value): value is string => typeof value === "string"))
    : new Set(["pending", "error"]);
  const moduleId = typeof params.module_id === "string" ? params.module_id : null;
  const instanceId = typeof params.instance_id === "string" ? params.instance_id : null;
  const priority = typeof params.priority === "string" ? params.priority : null;
  const action = typeof params.action === "string" ? params.action : null;
  const createdFrom = typeof params.created_from === "string" ? Date.parse(params.created_from) : null;
  const createdTo = typeof params.created_to === "string" ? Date.parse(params.created_to) : null;
  const reviewAfterFrom = typeof params.review_after_from === "string" ? Date.parse(params.review_after_from) : null;
  const reviewAfterTo = typeof params.review_after_to === "string" ? Date.parse(params.review_after_to) : null;
  const result: Array<Awaited<ReturnType<typeof buildReviewView>>> = [];
  for (const directory of REVIEW_DIRECTORIES) {
    for (const file of await listFilesRecursive(path.join(vaultRoot, "90-System", "Review Queue", directory), ".md")) {
      const item = parseMarkdown(vaultRoot, file).data as unknown as ReviewItem;
      if (!requested.has(item.status)) continue;
      if (moduleId && item.source_module !== moduleId) continue;
      if (instanceId && item.instance_id !== instanceId) continue;
      if (priority && item.priority !== priority) continue;
      if (action && item.action !== action) continue;
      const created = Date.parse(item.created);
      if (createdFrom !== null && created < createdFrom) continue;
      if (createdTo !== null && created > createdTo) continue;
      const reviewAfter = item.review_after ? Date.parse(item.review_after) : null;
      if (reviewAfterFrom !== null && (reviewAfter === null || reviewAfter < reviewAfterFrom)) continue;
      if (reviewAfterTo !== null && (reviewAfter === null || reviewAfter > reviewAfterTo)) continue;
      result.push(await buildReviewView(vaultRoot, item, toVaultPath(vaultRoot, file)));
    }
  }
  const priorityWeight: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return result.sort((a, b) =>
    (priorityWeight[a.priority] ?? 9) - (priorityWeight[b.priority] ?? 9) ||
    Date.parse(a.created_at) - Date.parse(b.created_at),
  );
}

async function resolveReviewCommand(vaultRoot: string, params: JsonObject): Promise<JsonValue> {
  const input = params as unknown as ResolveReviewParams;
  const reviewId = stringParam(params, "review_id");
  const mode = input.mode ?? "decide";
  if (mode === "prepare-discussion") {
    const located = await locateReviewItem(vaultRoot, reviewId);
    if (located.item.status !== "pending") throw new PkbError("REVIEW_ALREADY_PROCESSED", "Only pending reviews can enter discussion.");
    return buildDiscussionContext(vaultRoot, located.item, toVaultPath(vaultRoot, located.filePath));
  }
  if (mode === "reconcile") return reconcileReviews(vaultRoot, reviewId) as unknown as JsonValue;
  if (mode === "retry") return retryReview(vaultRoot, reviewId) as unknown as JsonValue;
  if (mode === "mark-resolved-by-user-edit") {
    return resolveReviewByUserEdit(vaultRoot, reviewId, input.user_comment) as unknown as JsonValue;
  }
  if (mode === "apply-discussion-result") {
    if (!input.context_token || !input.discussion_result) {
      throw new PkbError("INVALID_REQUEST", "context_token and discussion_result are required.");
    }
    const located = await locateReviewItem(vaultRoot, reviewId);
    const current = await buildDiscussionContext(vaultRoot, located.item, toVaultPath(vaultRoot, located.filePath));
    if (!discussionContextIsCurrent(input.context_token, current)) {
      throw new PkbError("DISCUSSION_CONTEXT_STALE", "The Review or target field changed during discussion.");
    }
    const discussion = input.discussion_result;
    const allowed = new Set(["approve", "approve-with-modification", "reject", "continue-waiting", "needs-more-information"]);
    if (!allowed.has(discussion.outcome) || !discussion.user_comment?.trim()) {
      throw new PkbError("INVALID_DISCUSSION_RESULT", "Discussion outcome and user_comment are required.");
    }
    if (discussion.outcome === "approve-with-modification" && discussion.modified_value === undefined) {
      throw new PkbError("MODIFIED_VALUE_REQUIRED", "The discussion result requires modified_value.");
    }
    const receivedAt = new Date().toISOString();
    const recordPath = path.join(
      vaultRoot, "90-System", "State", "Review Discussions", reviewId,
      `${receivedAt.replace(/[:.]/g, "-")}.json`,
    );
    const mappedDecision = discussion.outcome === "continue-waiting" || discussion.outcome === "needs-more-information"
      ? "discuss"
      : discussion.outcome;
    const record: JsonObject = {
      protocol_version: 1,
      review_id: reviewId,
      context_token: input.context_token,
      outcome: discussion.outcome,
      user_comment: discussion.user_comment,
      modified_value: discussion.modified_value ?? null,
      received_at: receivedAt,
      execution_result: null,
    };
    await writeJsonAtomic(recordPath, record);
    const result = await decideReview({
      vaultRoot,
      reviewId,
      decision: mappedDecision,
      userComment: `${discussion.outcome}: ${discussion.user_comment}`,
      modifiedValue: discussion.modified_value,
    });
    record.execution_result = result as unknown as JsonValue;
    await writeJsonAtomic(recordPath, record);
    return { ...result, discussion_record: toVaultPath(vaultRoot, recordPath) } as unknown as JsonValue;
  }
  if (!["approve", "approve-with-modification", "reject", "defer", "discuss"].includes(input.decision ?? "")) {
    throw new PkbError("INVALID_REQUEST", "decision is invalid.");
  }
  return decideReview({
    vaultRoot,
    reviewId,
    decision: input.decision!,
    userComment: input.user_comment,
    reviewAfter: input.review_after,
    modifiedValue: input.modified_value,
  }) as unknown as JsonValue;
}

function runtimeView(runtimeData: JsonObject): JsonObject {
  const tasks = (runtimeData.tasks as JsonValue[] | undefined) ?? [];
  const counts: JsonObject = {};
  for (const task of tasks) {
    if (!task || typeof task !== "object" || Array.isArray(task) || typeof task.status !== "string") continue;
    counts[task.status] = Number(counts[task.status] ?? 0) + 1;
  }
  return {
    integrity: runtimeData.integrity ?? "unknown",
    schema_version: runtimeData.schema_version ?? null,
    counts,
    resources: runtimeData.resources ?? [],
    jobs: runtimeData.jobs ?? [],
    checkpoints: runtimeData.checkpoints ?? [],
    observability: runtimeData.runtime_stats ?? {},
  };
}

function qualityOverview(runtimeData: JsonObject): JsonObject {
  const active = (runtimeData.quality_active as JsonObject[] | undefined) ?? [];
  const resolved = (runtimeData.quality_resolved as JsonObject[] | undefined) ?? [];
  const tasks = (runtimeData.tasks as JsonObject[] | undefined) ?? [];
  const sevenDays = Date.now() - 7 * 86_400_000;
  return {
    active_issues: active.length,
    critical: active.filter((issue) => issue.severity === "critical").length,
    high: active.filter((issue) => issue.severity === "high").length,
    new_this_week: active.filter((issue) => Date.parse(String(issue.first_seen ?? 0)) >= sevenDays).length,
    resolved_this_week: resolved.filter((issue) => Date.parse(String((issue.resolution as JsonObject | undefined)?.resolved_at ?? 0)) >= sevenDays).length,
    failed_tasks: tasks.filter((task) => task.status === "failed").length,
  };
}

async function systemRuntimeData(vaultRoot: string): Promise<JsonObject> {
  const repository = await RuntimeRepository.open(vaultRoot);
  try { return repository.systemCenterData(new Date(Date.now() - 7 * 86_400_000).toISOString()); }
  finally { repository.close(); }
}

async function execute(context: CommandContext): Promise<JsonValue> {
  const { vaultRoot, requestId, method, params } = context;
  const obsidianOpenPaths = Array.isArray(params.obsidian_open_paths) ? params.obsidian_open_paths : null;
  if (obsidianOpenPaths !== null) await syncObsidianOpenFiles(vaultRoot, obsidianOpenPaths);
  if (method === "analyzeModuleRequirement") {
    const brief = stringParam(params, "brief");
    const analysis = await analyzeGuidedModuleRequirement({
      brief,
      engineRoot: ENGINE_ROOT,
      codexModel: typeof params.codex_model === "string" ? params.codex_model : undefined,
      codexReasoningEffort: typeof params.codex_reasoning_effort === "string" ? params.codex_reasoning_effort : undefined,
    });
    if (!analysis.proposed_blueprint) return analysis;
    const preview = await withTemporaryBlueprint(vaultRoot, requestId, analysis.proposed_blueprint, (file) => validateModuleBlueprint(ENGINE_ROOT, file));
    return { ...analysis, blueprint_preview: { report: preview.report, scaffold_template: preview.scaffoldTemplate, approval: deriveBlueprintApproval(analysis.proposed_blueprint) } } as unknown as JsonValue;
  }
  if (method === "getModuleBuilderPlatformContract") return getModuleBuilderPlatformContract(ENGINE_ROOT);
  if (method === "previewModuleBlueprint") {
    const blueprint = params.blueprint && typeof params.blueprint === "object" && !Array.isArray(params.blueprint) ? params.blueprint as JsonObject : null;
    if (!blueprint) throw new PkbError("INVALID_REQUEST", "blueprint must be an object.");
    const result = await withTemporaryBlueprint(vaultRoot, requestId, blueprint, (file) => validateModuleBlueprint(ENGINE_ROOT, file));
    return { report: result.report, scaffold_template: result.scaffoldTemplate, approval: deriveBlueprintApproval(blueprint) } as unknown as JsonValue;
  }
  if (method === "createModuleFromBlueprint") {
    if (params.confirm !== true) throw new PkbError("CONFIRMATION_REQUIRED", "Module generation requires explicit confirmation.");
    const blueprint = params.blueprint && typeof params.blueprint === "object" && !Array.isArray(params.blueprint) ? params.blueprint as JsonObject : null;
    if (!blueprint) throw new PkbError("INVALID_REQUEST", "blueprint must be an object.");
    const expectedApproval = deriveBlueprintApproval(blueprint);
    const approval = params.approval && typeof params.approval === "object" && !Array.isArray(params.approval) ? params.approval as JsonObject : null;
    if (approval?.blueprint_hash !== expectedApproval.blueprint_hash) throw new PkbError("BLUEPRINT_APPROVAL_STALE", "The Blueprint changed or no matching approval was supplied. Preview the exact Blueprint again before creating it.", { expected_hash: expectedApproval.blueprint_hash, requirements: expectedApproval.requirements });
    const approved = Array.isArray(approval.approved_requirement_ids) ? approval.approved_requirement_ids.filter((item): item is string => typeof item === "string") : [];
    const missing = expectedApproval.requirements.filter((requirement) => !approved.includes(requirement.id));
    if (missing.length) throw new PkbError("BLUEPRINT_APPROVAL_REQUIRED", "The Blueprint has unapproved high-risk requirements.", { blueprint_hash: expectedApproval.blueprint_hash, missing_requirements: missing, requirements: expectedApproval.requirements });
    const moduleId = typeof blueprint.module === "object" && blueprint.module && !Array.isArray(blueprint.module) && typeof (blueprint.module as JsonObject).id === "string"
      ? String((blueprint.module as JsonObject).id) : null;
    if (!moduleId) throw new PkbError("INVALID_REQUEST", "blueprint.module.id is required.");
    const modulesRoot = path.join(vaultRoot, "90-System", "Module Development");
    return withTemporaryBlueprint(vaultRoot, requestId, blueprint, async (file) => ({
      ...await scaffoldModuleFromBlueprint(ENGINE_ROOT, file, { modulesRoot }),
      workspace_path: `90-System/Module Development/${moduleId}`,
      next_state: "implementation-required",
    })) as Promise<JsonValue>;
  }
  if (method === "getModuleReadiness") {
    return getModuleReadiness(ENGINE_ROOT, vaultRoot, stringParam(params, "module_id"));
  }
  if (method === "runModuleReadinessAction") {
    const action = typeof params.action === "string" ? params.action : "";
    if (!(["validate", "test", "sandbox", "pack", "install"] as string[]).includes(action)) {
      throw new PkbError("INVALID_REQUEST", "action must be validate, test, sandbox, pack, or install.");
    }
    return runModuleReadinessAction(ENGINE_ROOT, vaultRoot, stringParam(params, "module_id"), action as ModuleReadinessAction, { confirmBreaking: params.confirm_breaking === true });
  }
  if (method === "getSystemCenterSnapshot") {
    const section = typeof params.section === "string" ? params.section : "full";
    if (!["full", "overview", "tasks", "quality", "modules", "history"].includes(section)) {
      throw new PkbError("INVALID_REQUEST", `Unknown System Center section: ${section}`);
    }
    if (section === "history") {
      return { section, runs: await listRunViews(vaultRoot, { limit: 20, include_rollback: false }) } as unknown as JsonValue;
    }
    const runtimeData = ["full", "overview", "tasks", "quality"].includes(section) ? await systemRuntimeData(vaultRoot) : {};
    const runtime = runtimeView(runtimeData);
    const tasks = ((runtimeData.tasks as JsonValue[] | undefined) ?? []).slice(0, 200);
    if (section === "tasks") return { section, tasks, runtime } as unknown as JsonValue;
    if (section === "quality") {
      return { section, quality: await getQualityDashboardFromRuntimeSnapshot(vaultRoot, runtimeData) } as unknown as JsonValue;
    }

    const routing = await discoverRoutingContext(ENGINE_ROOT, vaultRoot);
    const inboxContext = await discoverInboxContext(vaultRoot, routing);
    const instances = instanceViews(routing.instances, {});
    if (section === "overview") {
      const [inbox, reviews, runs] = await Promise.all([
        listInbox(vaultRoot, {}, inboxContext),
        listReviews(vaultRoot, { statuses: ["pending", "error"] }),
        listRunViews(vaultRoot, { limit: 1, include_rollback: false }),
      ]);
      return {
        section,
        modules: routing.modules.map((module) => ({ id: module.data.id, status: module.data.status })),
        instances,
        inbox,
        reviews,
        runs,
        tasks,
        runtime,
        quality: { overview: qualityOverview(runtimeData) },
      } as unknown as JsonValue;
    }

    const [modules, inbox, reviews, runs] = await Promise.all([
      moduleViews(vaultRoot, routing.instances, routing.modules),
      listInbox(vaultRoot, {}, inboxContext),
      listReviews(vaultRoot, { statuses: ["pending", "error"] }),
      listRunViews(vaultRoot, { limit: 20, include_rollback: false }),
    ]);
    if (section === "modules") return { section, modules, instances, inbox, reviews, runs } as unknown as JsonValue;
    return {
      section: "full",
      modules,
      instances,
      inbox,
      reviews,
      runs,
      tasks,
      runtime,
      quality: await getQualityDashboardFromRuntimeSnapshot(vaultRoot, runtimeData),
    } as unknown as JsonValue;
  }
  if (method === "getTodayItems") {
    const snapshot = await getTodaySnapshot(vaultRoot);
    if (params.refresh_markdown !== false) await writeTodayMarkdown(vaultRoot, snapshot);
    return snapshot;
  }
  if (method === "getQualityDashboard") return getQualityDashboard(vaultRoot);
  if (method === "migrateLegacyAccessPolicies") {
    const migration = params as unknown as LegacyAccessPolicyMigrationParams;
    if (migration.action === "preview") return previewLegacyAccessPolicyMigration(vaultRoot);
    if (migration.action === "apply") return applyLegacyAccessPolicyMigration(vaultRoot, migration);
    if (migration.action === "rollback") return rollbackLegacyAccessPolicyMigration(vaultRoot, String(migration.preview_id ?? ""), migration.confirm === true);
    throw new PkbError("INVALID_REQUEST", "action must be preview, apply, or rollback.");
  }
  if (method === "getFieldProvenance") return getFieldProvenance(vaultRoot, stringParam(params, "target"), stringParam(params, "field"));
  if (method === "updateAssetAccessPolicy") {
    const capturePath = stringParam(params, "capture_path");
    if (typeof params.sensitivity_class !== "number" || typeof params.max_representation !== "string") throw new PkbError("INVALID_REQUEST", "sensitivity_class and max_representation are required.");
    const before = await readCaptureEnvelope(vaultRoot, capturePath);
    const updated = await updateAssetAccessPolicy(vaultRoot, capturePath, { sensitivity_class: params.sensitivity_class, max_representation: params.max_representation as RepresentationLevel });
    const quality = await QualityRepository.open(vaultRoot);
    try {
      quality.recordChange({
        entity_ref: `[[${updated.companion_note_path}]]`, field: "access_policy",
        old_value: { sensitivity_class: before.sensitivity_class, max_representation: before.access_policy.max_representation },
        new_value: { sensitivity_class: updated.sensitivity_class, max_representation: updated.access_policy.max_representation },
        reason: "User updated attachment access policy through the Core API.", evidence_refs: [], generation: null,
        review: { status: "user-direct", reviewed_by: "user", reviewed_at: new Date().toISOString() }, changed_at: new Date().toISOString(),
      });
    } finally { quality.close(); }
    return { status: "updated", source_of_truth: "sidecar", sidecar_path: updated.sidecar_path, companion_note_path: updated.companion_note_path, sensitivity_class: updated.sensitivity_class, access_policy: updated.access_policy } as unknown as JsonValue;
  }
  if (method === "backfillQualityMetadata") {
    if (params.confirm === true) return applyQualityBackfill(vaultRoot);
    return previewQualityBackfill(vaultRoot);
  }
  if (method === "runQualityAudit") {
    const frequency = String(params.frequency ?? "daily");
    if (!["daily", "weekly", "monthly"].includes(frequency)) throw new PkbError("INVALID_REQUEST", "frequency must be daily, weekly, or monthly.");
    return executeQualityAudit(vaultRoot, frequency as AuditFrequency);
  }
  if (method === "listQualityIssues") {
    const repository = await QualityRepository.open(vaultRoot);
    try { return repository.listIssues({ statuses: Array.isArray(params.statuses) ? params.statuses as never[] : undefined, severities: Array.isArray(params.severities) ? params.severities.filter((item): item is string => typeof item === "string") : undefined, modules: Array.isArray(params.modules) ? params.modules.filter((item): item is string => typeof item === "string") : undefined, instanceId: typeof params.instance_id === "string" ? params.instance_id : undefined, limit: typeof params.limit === "number" ? params.limit : 500 }) as unknown as JsonValue; }
    finally { repository.close(); }
  }
  if (method === "manageQualityIssue") {
    const issueId = stringParam(params, "issue_id"); const action = String(params.action);
    const statuses: Record<string, "acknowledged" | "scheduled" | "resolved" | "ignored" | "suppressed" | "open"> = { acknowledge: "acknowledged", schedule: "scheduled", resolve: "resolved", ignore: "ignored", suppress: "suppressed", reopen: "open" };
    if (!statuses[action]) throw new PkbError("INVALID_REQUEST", "Unknown Quality Issue action.");
    const repository = await QualityRepository.open(vaultRoot);
    try { return repository.updateIssue(issueId, statuses[action], { suppressed_until: typeof params.suppressed_until === "string" ? params.suppressed_until : null, resolution: action === "resolve" ? { type: "user-resolved", resolved_at: new Date().toISOString(), comment: typeof params.comment === "string" ? params.comment : "" } : null }) as unknown as JsonValue; }
    finally { repository.close(); }
  }
  if (method === "listInboxItems") {
    return listInbox(vaultRoot, params);
  }
  if (method === "getInboxCenterSnapshot") {
    const context = await discoverInboxContext(vaultRoot);
    const inbox = await listInbox(vaultRoot, params, context);
    return {
      inbox,
      modules: context.modules.map((module) => ({
        id: module.data.id,
        name: module.data.name,
        status: module.data.status,
      })),
      instances: context.instances.map((instance) => ({
        instance_id: instance.data.instance_id,
        module_id: instance.data.module_id,
        display_name: instance.data.display_name,
        status: instance.data.status,
      })),
    } as unknown as JsonValue;
  }
  if (method === "listReviewItems") return listReviews(vaultRoot, params);
  if (method === "resolveReview") {
    const before = await locateReviewItem(vaultRoot, stringParam(params, "review_id"));
    const result = await resolveReviewCommand(vaultRoot, params);
    const resultObject = result && typeof result === "object" && !Array.isArray(result) ? result : {};
    const status = typeof resultObject.status === "string" ? resultObject.status : before.item.status;
    if (["approved", "approved-with-modification", "rejected", "resolved-by-user-edit"].includes(status)) {
      const originTaskId = before.item.origin_task_id;
      if (typeof originTaskId === "string") {
        const repository = await RuntimeRepository.open(vaultRoot);
        try {
          const task = repository.getTask(originTaskId);
          if (task?.status === "waiting-for-user") repository.retryTask(originTaskId);
        } finally { repository.close(); }
      }
      await publishRuntimeEvent(vaultRoot, { type: "review.resolved", event_id: `EVT-review-${before.item.review_id}-${status}`, module: before.item.source_module, instance_id: before.item.instance_id, payload: { review_id: before.item.review_id, status } });
    }
    return result;
  }
  if (["listTasks", "getTaskDetails", "manageTask", "getTaskRuntimeStatus"].includes(method)) {
    const repository = await RuntimeRepository.open(vaultRoot);
    try {
      if (method === "listTasks") {
        const statuses = Array.isArray(params.statuses) ? params.statuses.filter((item): item is TaskStatus => typeof item === "string") : undefined;
        return repository.listTasks(statuses).slice(0, typeof params.limit === "number" ? params.limit : 200);
      }
      if (method === "getTaskDetails") {
        const task = repository.getTask(stringParam(params, "task_id"));
        if (!task) throw new PkbError("TASK_NOT_FOUND", `Task ${String(params.task_id)} was not found.`);
        return { task, runs: repository.getRuns(task.task_id), codex_invocations: repository.listCodexInvocations(task.task_id) };
      }
      if (method === "getTaskRuntimeStatus") {
        const tasks = repository.listTasks();
        const counts: Record<string, number> = {};
        for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
        return { integrity: repository.integrityCheck(), schema_version: repository.schemaVersion(), counts, resources: repository.getResourceStatuses(), jobs: repository.listJobs(), checkpoints: repository.getCheckpoints(), observability: repository.runtimeStats() };
      }
      const taskId = stringParam(params, "task_id");
      const action = stringParam(params, "action");
      if (action === "retry" || action === "run-now") return repository.retryTask(taskId);
      if (action === "cancel") return repository.cancelTask(taskId);
      if (action === "set-priority") {
        const priority = stringParam(params, "priority");
        if (!["critical", "high", "normal", "low"].includes(priority)) throw new PkbError("INVALID_REQUEST", "priority is invalid.");
        return repository.setTaskPriority(taskId, priority as "critical" | "high" | "normal" | "low");
      }
      if (action === "defer") {
        const until = stringParam(params, "defer_until");
        if (!Number.isFinite(Date.parse(until)) || Date.parse(until) <= Date.now()) throw new PkbError("INVALID_REQUEST", "defer_until must be a future date-time.");
        let task = repository.getTask(taskId);
        if (!task) throw new PkbError("TASK_NOT_FOUND", `Task ${taskId} was not found.`);
        if (task.status !== "queued") task = repository.retryTask(taskId);
        return repository.transitionTask(task.task_id, "deferred", { deferUntil: until });
      }
      throw new PkbError("INVALID_REQUEST", `Unknown task action: ${action}`);
    } finally { repository.close(); }
  }
  if (method === "enqueueTask") {
    await registerDeclaredJobs(vaultRoot);
    return enqueueManualTask(vaultRoot, stringParam(params, "job_id"), (params.payload && typeof params.payload === "object" && !Array.isArray(params.payload) ? params.payload : {}) as JsonObject, params.force === true);
  }
  if (method === "runTaskCycle") {
    const jobs = await registerDeclaredJobs(vaultRoot);
    const resumed_after_file_close = await resumeTasksAfterObsidianFileClose(vaultRoot);
    const inbox = await materializeInboxAiTasks(
      vaultRoot,
      typeof params.codex_model === "string" ? params.codex_model : undefined,
      typeof params.codex_reasoning_effort === "string" ? params.codex_reasoning_effort : undefined,
    );
    const resources = await probeRuntimeResources(vaultRoot, {
      networkProbeUrl: typeof params.network_probe_url === "string" ? params.network_probe_url : undefined,
      codexExecutable: typeof params.codex_executable === "string" ? params.codex_executable : undefined,
    });
    const startupTask = params.startup === true ? await materializeStartupJobs(vaultRoot) : null;
    const fields = await materializeFieldDueJobs(vaultRoot);
    const startup = params.startup === true ? await reconcileStartup(vaultRoot) : { scheduler: await evaluateScheduler(vaultRoot) };
    const dispatch = await dispatchOnce({ vaultRoot, limit: typeof params.limit === "number" ? params.limit : 2 });
    return { jobs_registered: jobs.length, inbox, resources, startup_task: startupTask, field_due: fields, startup, resumed_after_file_close, dispatch } as unknown as JsonValue;
  }
  if (method === "listCodexModels") {
    const models = await listCodexModels(typeof params.codex_executable === "string" ? params.codex_executable : undefined);
    return { models, detected_at: new Date().toISOString(), source: "codex-app-server" } as unknown as JsonValue;
  }
  if (method === "getModules") {
    const routing = await discoverRoutingContext(ENGINE_ROOT, vaultRoot);
    return moduleViews(vaultRoot, routing.instances, routing.modules);
  }
  if (method === "getInstances") {
    return instanceViews(await discoverInstances(vaultRoot), params);
  }
  if (method === "getRecentRuns") return listRunViews(vaultRoot, params);
  if (method === "getRunDetails") {
    const runId = stringParam(params, "run_id");
    const view = await getRunView(vaultRoot, runId, params.developer_mode === true);
    if (!view) throw new PkbError("RUN_NOT_FOUND", `Run ${runId} was not found.`);
    return view;
  }
  if (method === "rollbackRun") {
    const runId = stringParam(params, "run_id");
    const found = await findRun(vaultRoot, runId);
    if (!found) throw new PkbError("RUN_NOT_FOUND", `Run ${runId} was not found.`);
    const assessment = await assessRunRollback(vaultRoot, found.log);
    if (!assessment.can_rollback) throw new PkbError("RUN_NOT_ROLLBACKABLE", assessment.reasons.join(" "), assessment);
    if (assessment.requires_confirmation && params.confirm !== true) {
      throw new PkbError("ROLLBACK_CONFIRMATION_REQUIRED", "This rollback may affect later dependent runs and requires explicit confirmation.", assessment);
    }
    if (!found.log.plan_id) throw new PkbError("RUN_NOT_ROLLBACKABLE", "This run has no Operation Plan snapshot.");
    const status = await rollbackTransaction(vaultRoot, found.log.plan_id);
    let rollbackRunId: string | null = null;
    const warnings: string[] = [];
    try {
      rollbackRunId = await allocateId(vaultRoot, "RUN");
      const now = new Date().toISOString();
      const rollbackLog: RunLog = {
        run_id: rollbackRunId, task_id: null, plan_id: null, source_module: "core", instance_id: found.log.instance_id,
        review_id: null, status: "completed", git_snapshot: found.log.git_snapshot,
        started_at: now, completed_at: new Date().toISOString(), schema_version: 1,
      };
      await writeRunLog(vaultRoot, rollbackLog, `# ${rollbackRunId}\n\nRolled back ${found.log.run_id}.\n\n- Plan: ${found.log.plan_id}\n- Status: ${status}\n`);
    } catch (error) {
      warnings.push(`Rollback completed, but the audit Run could not be written: ${error instanceof Error ? error.message : String(error)}`);
    }
    try { await rebuildTodayDashboard(vaultRoot); }
    catch (error) { warnings.push(`Rollback completed, but Today could not be refreshed: ${error instanceof Error ? error.message : String(error)}`); }
    return { run_id: found.log.run_id, rollback_run_id: rollbackRunId, plan_id: found.log.plan_id, status, assessment, warnings };
  }
  if (method === "createCapture") {
    const result = await createCapture({
      vaultRoot,
      requestId,
      params: params as unknown as CreateCaptureParams,
    });
    await publishRuntimeEvent(vaultRoot, { type: "capture.created", event_id: `EVT-capture-${requestId}`, module: typeof result.source_module === "string" ? result.source_module : "core", instance_id: typeof result.instance_id === "string" ? result.instance_id : null, payload: { capture_id: result.capture_id ?? null, path: result.path ?? null } });
    return result;
  }
  if (method === "processInboxItem") return processInboxItem(vaultRoot, params as unknown as ProcessInboxItemParams);
  if (method === "processInboxBatch") return processInboxBatch(vaultRoot, params as unknown as ProcessInboxBatchParams);
  if (method === "classifyInboxAttachment") return classifyInboxAttachment(vaultRoot, params as unknown as ClassifyInboxAttachmentParams);
  if (method === "reviewPartialInboxExtraction") return reviewPartialInboxExtraction(vaultRoot, params as unknown as ReviewPartialInboxExtractionParams);
  if (method === "manageModule") return manageModule(vaultRoot, params as unknown as ManageModuleParams);
  if (method === "createInstance") return createInstance(vaultRoot, params as unknown as CreateInstanceParams);
  if (method === "manageInstance") return manageInstance(vaultRoot, params as unknown as ManageInstanceParams);
  throw new PkbError("METHOD_NOT_FOUND", `Unknown Core Command API method: ${method}`);
}

function userFacingError(error: unknown): UserFacingError {
  const code = error instanceof PkbError ? error.code : "UNEXPECTED_ERROR";
  const technical = error instanceof PkbError ? error.details : error instanceof Error ? error.stack ?? error.message : String(error);
  const messages: Record<string, { impact: string; actions: string[]; retryable: boolean }> = {
    INVALID_REQUEST: { impact: "请求未执行。", actions: ["检查输入后重试"], retryable: true },
    INBOX_ITEM_NOT_FOUND: { impact: "没有处理任何文件。", actions: ["刷新 Inbox Center", "确认条目仍位于受管 Inbox"], retryable: true },
    INBOX_ITEM_IN_PROGRESS: { impact: "系统拒绝重复执行当前条目。", actions: ["等待当前处理完成", "刷新 Inbox Center"], retryable: true },
    INBOX_ROUTE_INVALID: { impact: "条目仍保留在原路径。", actions: ["重新选择已启用模块或活跃实例", "再次预览后处理"], retryable: true },
    INBOX_RETRY_REQUIRED: { impact: "失败条目没有被静默重复执行。", actions: ["查看失败原因", "点击重试"], retryable: true },
    OBSIDIAN_FILE_OPEN: { impact: "未移动或更新该笔记。", actions: ["保存并关闭正在打开的笔记", "等待下一次自动检查或在 Inbox 中点击“已关闭，继续”"], retryable: true },
    DESTINATION_EXISTS: { impact: "系统没有覆盖同名文件。", actions: ["打开目标 Inbox 处理同名冲突", "刷新后重试"], retryable: true },
    RUN_NOT_FOUND: { impact: "没有执行撤销或读取操作。", actions: ["刷新运行历史", "确认 Run ID"], retryable: true },
    RUN_NOT_ROLLBACKABLE: { impact: "现有文件保持不变。", actions: ["查看 Run 详情", "使用 Git 历史人工恢复"], retryable: false },
    ROLLBACK_CONFIRMATION_REQUIRED: { impact: "尚未执行撤销。", actions: ["查看后续依赖 Run", "确认影响后再次撤销"], retryable: true },
    ROLLBACK_CONFLICT: { impact: "系统拒绝覆盖 Run 之后的用户修改。", actions: ["打开冲突文件", "使用 Git 历史人工比较"], retryable: false },
    MODULE_CONFIRMATION_REQUIRED: { impact: "模块状态尚未改变。", actions: ["查看停用影响", "确认后再次提交"], retryable: true },
    MODULE_DISABLED: { impact: "没有创建或处理实例数据。", actions: ["先启用模块", "刷新 System Center"], retryable: true },
    INSTANCE_CONFIRMATION_REQUIRED: { impact: "实例尚未归档。", actions: ["检查未处理 Inbox 和审核", "确认保留这些事项后归档"], retryable: true },
    INSTANCE_TRANSITION_INVALID: { impact: "实例状态保持不变。", actions: ["刷新实例状态", "选择当前状态允许的操作"], retryable: true },
    INSTANCE_EXISTS: { impact: "没有覆盖现有实例。", actions: ["使用新的实例 ID", "打开已有实例"], retryable: true },
    INSTANCE_FIELD_REQUIRED: { impact: "实例尚未创建。", actions: ["补充必填字段", "重新预览"], retryable: true },
    INVALID_INSTANCE_ID: { impact: "实例尚未创建。", actions: ["使用 3–128 位字母、数字、点、下划线或连字符", "重新预览"], retryable: true },
    INSTANCE_FIELD_UNKNOWN: { impact: "实例尚未创建。", actions: ["刷新模块表单", "移除模块未声明的字段"], retryable: true },
    INVALID_INSTANCE_PATH: { impact: "没有创建目录或实例配置。", actions: ["确保 Inbox 位于实例内容目录内", "重新预览"], retryable: true },
    MODULE_NOT_FOUND: { impact: "没有修改模块或实例。", actions: ["刷新 System Center", "同步或安装模块配置"], retryable: true },
    CAPTURE_CONTENT_REQUIRED: { impact: "没有创建 Capture 文件。", actions: ["输入内容后重新保存"], retryable: true },
    CAPTURE_IN_PROGRESS: { impact: "系统没有创建重复文件。", actions: ["稍后刷新 Today", "若未出现则重试"], retryable: true },
    IDEMPOTENCY_CONFLICT: { impact: "系统拒绝覆盖先前的 Capture 请求。", actions: ["保留输入并重新打开 Capture"], retryable: false },
    ATTACHMENT_NOT_FOUND: { impact: "Capture 和附件均未修改。", actions: ["移除无效附件", "确认附件路径后重试"], retryable: true },
    GIT_WORKTREE_DIRTY: { impact: "Capture 尚未写入，输入仍保留在表单中。", actions: ["提交或暂存现有 Vault 修改", "然后重试保存"], retryable: true },
    DISCUSSION_CONTEXT_STALE: { impact: "没有执行讨论结论，也没有修改目标文件。", actions: ["重新加载审核详情", "重新生成讨论上下文"], retryable: true },
    REVIEW_ALREADY_PROCESSED: { impact: "没有重复执行审核决定。", actions: ["刷新审核列表", "查看审核历史"], retryable: false },
    REVIEW_IN_PROGRESS: { impact: "系统拒绝了重复执行，现有请求仍在继续。", actions: ["等待当前处理完成", "刷新审核列表"], retryable: true },
    MODIFIED_VALUE_REQUIRED: { impact: "审核决定尚未执行。", actions: ["填写修改后的值", "重新提交决定"], retryable: true },
  };
  const guidance = messages[code] ?? { impact: "操作未能完整完成，请查看详情确认文件状态。", actions: ["刷新页面", "查看运行日志", "修复问题后重试"], retryable: true };
  const message = error instanceof Error ? error.message : String(error);
  return {
    code,
    message,
    what_happened: message,
    impact: guidance.impact,
    recovery_actions: guidance.actions,
    retryable: guidance.retryable,
    technical_details: technical === undefined ? null : technical as JsonValue,
  };
}

export async function invokeCommandApi(options: {
  vaultRoot: string;
  requestId: string;
  method: CommandApiMethod;
  params?: JsonObject;
}): Promise<CommandApiResponse> {
  try {
    const data = await execute({ vaultRoot: options.vaultRoot, requestId: options.requestId, method: options.method, params: options.params ?? {} });
    const requestedState = data && typeof data === "object" && !Array.isArray(data) ? data.ui_state : null;
    const state = requestedState === "waiting-for-ai" || requestedState === "waiting-for-user" ? requestedState : "completed";
    return {
      api_version: COMMAND_API_VERSION,
      request_id: options.requestId,
      method: options.method,
      state,
      ok: true,
      data,
      error: null,
    };
  } catch (error) {
    return {
      api_version: COMMAND_API_VERSION,
      request_id: options.requestId,
      method: options.method,
      state: "failed",
      ok: false,
      data: null,
      error: userFacingError(error),
    };
  }
}
