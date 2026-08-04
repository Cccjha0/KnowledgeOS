import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ApplicationRecord,
  JsonObject,
  MarkdownDocument,
  OperationPlan,
  ProcessedReportsFile,
  ResearchReport,
  ResearchRequest,
  UpdateResult,
} from "../types.js";
import { parseMarkdown, parseYaml, validateSchema } from "../core/bridge.js";
import { rebuildTodayDashboard } from "./dashboard.js";
import { PkbError } from "../core/errors.js";
import {
  ensureDir,
  exists,
  fromVaultPath,
  listFilesRecursive,
  readJson,
  sha256File,
  toVaultPath,
  writeJsonAtomic,
} from "../core/files.js";
import { createGitSnapshot } from "../core/git.js";
import { allocateId } from "../core/ids.js";
import { writeRunLog as writeCoreRunLog } from "../core/logs.js";
import { executeOperationPlan } from "../core/operationExecutor.js";
import { writeReviewItems } from "../core/reviews.js";
import { DeterministicComparisonAdapter, type ComparisonAdapter } from "../application/adapter.js";
import { buildOperationPlan } from "../application/plan.js";
import { applyReportToResearchRequest } from "../application/researchRequest.js";
import { discoverModulesForVault } from "../core/discovery.js";
import { assertMoveSourceNotOpen } from "./obsidianCoordination.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SCHEMAS = {
  instance: "https://pkb.local/schemas/application-tracker/application-instance.schema.json",
  record: "https://pkb.local/schemas/application-tracker/application-record.schema.json",
  report: "https://pkb.local/schemas/application-tracker/research-report.schema.json",
  update: "https://pkb.local/schemas/application-tracker/update-result.schema.json",
  plan: "https://pkb.local/schemas/core/operation-plan.schema.json",
  review: "https://pkb.local/schemas/core/review-item.schema.json",
  request: "https://pkb.local/schemas/application-tracker/research-request.schema.json",
} as const;

export interface ProcessReportOptions {
  vaultRoot: string;
  reportPath: string;
  dryRun?: boolean;
  comparisonAdapter?: ComparisonAdapter;
}

export interface ProcessReportResult {
  status: "processed" | "already-processed" | "dry-run";
  runId: string | null;
  reportId: string;
  recordPath: string | null;
  destination: string | null;
  reviewCount: number;
  snapshot: string | null;
  planPath: string | null;
  todayPath: string | null;
}

function asResearchReport(value: JsonObject): ResearchReport {
  return value as unknown as ResearchReport;
}

function asApplicationRecord(value: JsonObject): ApplicationRecord {
  return value as unknown as ApplicationRecord;
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

async function locateRecord(
  vaultRoot: string,
  instanceRoot: string,
  report: ResearchReport,
): Promise<{ absolute: string; relative: string; document: MarkdownDocument; record: ApplicationRecord }> {
  const recordsRoot = path.join(instanceRoot, "Records");
  const candidates = await listFilesRecursive(recordsRoot, ".md");
  const matches: Array<{
    absolute: string;
    relative: string;
    document: MarkdownDocument;
    record: ApplicationRecord;
  }> = [];
  const identityMatches: typeof matches = [];

  for (const candidate of candidates) {
    const document = parseMarkdown(vaultRoot, candidate);
    if (document.data.type !== "application-record") {
      continue;
    }
    validateSchema(vaultRoot, SCHEMAS.record, document.data);
    const record = asApplicationRecord(document.data);
    const sameInstitution = record.institution.trim().toLowerCase() === report.institution.trim().toLowerCase();
    const sameIntake = record.intake === report.intake;
    const sameProgram = report.program_code
      ? record.program_code === report.program_code
      : record.program_name.trim().toLowerCase() === report.program_name.trim().toLowerCase();
    if (sameInstitution && sameProgram) {
      identityMatches.push({
        absolute: candidate,
        relative: toVaultPath(vaultRoot, candidate),
        document,
        record,
      });
    }
    if (sameInstitution && sameIntake && sameProgram) {
      matches.push({
        absolute: candidate,
        relative: toVaultPath(vaultRoot, candidate),
        document,
        record,
      });
    }
  }

  if (matches.length === 0 && identityMatches.length === 1) return identityMatches[0]!;

  if (matches.length === 0) {
    throw new PkbError(
      "APPLICATION_RECORD_NOT_FOUND",
      `找不到 ${report.institution} ${report.program_name} ${report.intake} 对应的 application-record。`,
    );
  }
  if (matches.length > 1) {
    throw new PkbError(
      "APPLICATION_RECORD_AMBIGUOUS",
      "找到多个匹配的 application-record，需要先人工消除重复。",
      matches.map((match) => match.relative),
    );
  }
  return matches[0]!;
}

async function determineDestination(
  vaultRoot: string,
  instanceRoot: string,
  reportAbsolute: string,
  report: ResearchReport,
): Promise<string> {
  const researchRoot = path.join(instanceRoot, "Research");
  await ensureDir(researchRoot);
  let destination = path.join(researchRoot, path.basename(reportAbsolute));
  if (!(await exists(destination))) {
    return destination;
  }
  if ((await sha256File(destination)) === (await sha256File(reportAbsolute))) {
    return destination;
  }
  const extension = path.extname(reportAbsolute);
  const base = path.basename(reportAbsolute, extension);
  destination = path.join(
    researchRoot,
    `${safeFilename(base)}-${safeFilename(report.report_id)}${extension}`,
  );
  return destination;
}

function reportWikiReference(vaultRoot: string, destination: string): string {
  return `[[${toVaultPath(vaultRoot, destination).replace(/\.md$/i, "")}]]`;
}

async function attachResearchRequestOperation(
  vaultRoot: string,
  plan: OperationPlan,
  report: ResearchReport,
  record: ApplicationRecord,
  recordPath: string,
  now: string,
): Promise<string | null> {
  if (report.request_id === null) return null;
  const candidates = (await listFilesRecursive(path.join(vaultRoot, "20-Workspace", "Applications"), ".md"))
    .filter((file) => file.split(path.sep).includes("Research Requests") && path.basename(file, ".md") === report.request_id);
  if (candidates.length !== 1) {
    throw new PkbError("RESEARCH_REQUEST_NOT_FOUND", `Expected exactly one Research Request ${report.request_id}.`, candidates);
  }
  const requestDocument = parseMarkdown(vaultRoot, candidates[0]!);
  validateSchema(vaultRoot, SCHEMAS.request, requestDocument.data);
  const request = requestDocument.data as unknown as ResearchRequest;
  if (request.application_id !== record.id || request.record_path !== recordPath) {
    throw new PkbError("RESEARCH_REQUEST_TARGET_MISMATCH", "Research Request does not belong to the matched Application Record.");
  }
  const updated = applyReportToResearchRequest(request, report, now);
  const target = toVaultPath(vaultRoot, candidates[0]!);
  plan.operations.push({
    operation_id: `OP-${String(plan.operations.length + 1).padStart(3, "0")}`,
    type: "update-frontmatter",
    target,
    risk: "green",
    confidence: 1,
    idempotency_key: `${request.request_id}:${report.report_id}:lifecycle`,
    payload: { patch: updated, schema_id: SCHEMAS.request },
    requires_review_id: null,
  });
  return target;
}

async function writeRunLog(
  vaultRoot: string,
  runId: string,
  report: ResearchReport,
  plan: OperationPlan,
  snapshot: string,
  destination: string,
  reviewPaths: string[],
): Promise<string> {
  const now = new Date().toISOString();
  const content = [
    `# ${runId}`,
    "",
    "## 输入",
    "",
    `- 报告：${report.report_id}`,
    `- 实例：${report.instance_id}`,
    "",
    "## 执行",
    "",
    ...plan.operations.map((operation) => `- ${operation.type}: ${operation.target ?? ""}`),
    "",
    "## 审核",
    "",
    ...(reviewPaths.length > 0
      ? reviewPaths.map((item) => `- [[${toVaultPath(vaultRoot, item).replace(/\.md$/i, "")}]]`)
      : ["- 无。"]),
    "",
    "## 归档",
    "",
    `- [[${toVaultPath(vaultRoot, destination).replace(/\.md$/i, "")}]]`,
    "",
  ].join("\n");

  return writeCoreRunLog(vaultRoot, {
    run_id: runId,
    task_id: plan.task_id,
    plan_id: plan.plan_id,
    source_module: "application-tracker",
    instance_id: report.instance_id,
    review_id: null,
    status: "completed",
    git_snapshot: snapshot,
    started_at: now,
    completed_at: new Date().toISOString(),
    schema_version: 1,
  }, content);
}

export async function processApplicationReport(
  options: ProcessReportOptions,
): Promise<ProcessReportResult> {
  const vaultRoot = path.resolve(options.vaultRoot);
  const applicationModule = (await discoverModulesForVault(ENGINE_ROOT, vaultRoot)).find((module) => module.data.id === "application-tracker");
  if (!applicationModule || applicationModule.data.status !== "enabled") throw new PkbError("MODULE_DISABLED", "application-tracker is disabled for this Vault.");
  const reportAbsolute = path.isAbsolute(options.reportPath)
    ? options.reportPath
    : path.resolve(vaultRoot, options.reportPath);

  if (!(await exists(reportAbsolute))) {
    throw new PkbError("REPORT_NOT_FOUND", `找不到研究报告：${reportAbsolute}`);
  }

  const reportHash = await sha256File(reportAbsolute);
  const reportDocument = parseMarkdown(vaultRoot, reportAbsolute);
  validateSchema(vaultRoot, SCHEMAS.report, reportDocument.data);
  const report = asResearchReport(reportDocument.data);

  const processedPath = path.join(vaultRoot, "90-System", "State", "processed-reports.json");
  const processed = await readJson<ProcessedReportsFile>(processedPath, { reports: {} });
  const previous = processed.reports[report.report_id];
  if (previous && previous.hash === reportHash) {
    const source = toVaultPath(vaultRoot, reportAbsolute);
    const destination = fromVaultPath(vaultRoot, previous.destination);
    if (source !== previous.destination && !(await exists(destination))) {
      await assertMoveSourceNotOpen(vaultRoot, source);
      const taskId = await allocateId(vaultRoot, "TASK");
      const planId = await allocateId(vaultRoot, "PLAN");
      const runId = await allocateId(vaultRoot, "RUN");
      const plan: OperationPlan = {
        plan_id: planId,
        task_id: taskId,
        source_module: "application-tracker",
        instance_id: report.instance_id,
        summary: "Restore an already processed application report to its archive",
        operations: [{
          operation_id: "OP-001",
          type: "move-file",
          target: source,
          risk: "green",
          confidence: 1,
          idempotency_key: `restore-processed-report:${report.report_id}:${reportHash}`,
          payload: { destination: previous.destination },
          requires_review_id: null,
        }],
        review_items: [],
      };
      validateSchema(vaultRoot, SCHEMAS.plan, plan);
      const planPath = path.join(vaultRoot, "90-System", "State", "Plans", `${planId}.json`);
      await writeJsonAtomic(planPath, plan);
      if (options.dryRun) {
        return {
          status: "dry-run", runId, reportId: report.report_id, recordPath: null,
          destination: previous.destination, reviewCount: 0, snapshot: null,
          planPath: toVaultPath(vaultRoot, planPath), todayPath: null,
        };
      }
      const snapshot = await createGitSnapshot(vaultRoot, runId);
      await executeOperationPlan(vaultRoot, plan, {
        allowedTypes: ["move-file"], allowedTargets: [source], requiredReviewId: null, gitSnapshot: snapshot,
      });
      await writeRunLog(vaultRoot, runId, report, plan, snapshot, destination, []);
      const todayPath = await rebuildTodayDashboard(vaultRoot);
      return {
        status: "already-processed", runId, reportId: report.report_id, recordPath: null,
        destination: previous.destination, reviewCount: 0, snapshot,
        planPath: toVaultPath(vaultRoot, planPath), todayPath: toVaultPath(vaultRoot, todayPath),
      };
    }
    return {
      status: "already-processed",
      runId: previous.run_id,
      reportId: report.report_id,
      recordPath: null,
      destination: previous.destination,
      reviewCount: 0,
      snapshot: null,
      planPath: null,
      todayPath: null,
    };
  }

  const instancePath = path.join(
    vaultRoot,
    "90-System",
    "Instances",
    report.instance_id,
    "instance.yaml",
  );
  if (!(await exists(instancePath))) {
    throw new PkbError("INSTANCE_NOT_FOUND", `找不到实例配置：${report.instance_id}`);
  }
  const instance = parseYaml(vaultRoot, instancePath);
  validateSchema(vaultRoot, SCHEMAS.instance, instance);
  const contentRootValue = instance.content_root;
  if (typeof contentRootValue !== "string") {
    throw new PkbError("INVALID_INSTANCE", "实例缺少 content_root。", instance);
  }
  const instanceRoot = fromVaultPath(vaultRoot, contentRootValue);

  const target = await locateRecord(vaultRoot, instanceRoot, report);
  const destination = await determineDestination(vaultRoot, instanceRoot, reportAbsolute, report);
  if (toVaultPath(vaultRoot, reportAbsolute) !== toVaultPath(vaultRoot, destination)) {
    await assertMoveSourceNotOpen(vaultRoot, toVaultPath(vaultRoot, reportAbsolute));
  }
  const reportReference = reportWikiReference(vaultRoot, destination);
  const now = new Date().toISOString();

  const comparisonAdapter = options.comparisonAdapter ?? new DeterministicComparisonAdapter();
  const update: UpdateResult = await comparisonAdapter.compare(target.record, report, {
    targetRecordPath: target.relative,
    reportReference,
    now,
    allocateReviewId: () => allocateId(vaultRoot, "REV"),
  });
  const taskId = await allocateId(vaultRoot, "TASK");
  const planId = await allocateId(vaultRoot, "PLAN");
  const runId = await allocateId(vaultRoot, "RUN");
  for (const review of update.review_items) {
    review.generation = { run_id: runId, module: { id: "application-tracker", version: "0.2.0" }, workflow: { id: "compare-research-update", version: "1.0.0" }, prompt: null, processor: { id: "application-compare", version: "1.0.0" }, generated_at: now };
    validateSchema(vaultRoot, SCHEMAS.review, review);
  }
  validateSchema(vaultRoot, SCHEMAS.update, update);
  const plan = buildOperationPlan(vaultRoot, reportAbsolute, destination, report, update, {
    taskId,
    planId,
  });
  const requestTarget = await attachResearchRequestOperation(
    vaultRoot, plan, report, target.record, target.relative, now,
  );
  validateSchema(vaultRoot, SCHEMAS.plan, plan);

  const planPath = path.join(vaultRoot, "90-System", "State", "Plans", `${planId}.json`);
  await writeJsonAtomic(planPath, plan);

  if (options.dryRun) {
    return {
      status: "dry-run",
      runId,
      reportId: report.report_id,
      recordPath: target.relative,
      destination: toVaultPath(vaultRoot, destination),
      reviewCount: update.review_items.length,
      snapshot: null,
      planPath: toVaultPath(vaultRoot, planPath),
      todayPath: null,
    };
  }

  const snapshot = await createGitSnapshot(vaultRoot, runId);
  await executeOperationPlan(vaultRoot, plan, {
    allowedTypes: ["update-frontmatter", "append-section", "move-file"],
    allowedTargets: [target.relative, toVaultPath(vaultRoot, reportAbsolute), ...(requestTarget ? [requestTarget] : [])],
    requiredReviewId: null,
    gitSnapshot: snapshot,
  });
  const reviewPaths = await writeReviewItems(vaultRoot, update.review_items);

  processed.reports[report.report_id] = {
    hash: reportHash,
    processed_at: new Date().toISOString(),
    run_id: runId,
    destination: toVaultPath(vaultRoot, destination),
  };
  await writeJsonAtomic(processedPath, processed);
  await writeRunLog(vaultRoot, runId, report, plan, snapshot, destination, reviewPaths);
  const todayPath = await rebuildTodayDashboard(vaultRoot);

  return {
    status: "processed",
    runId,
    reportId: report.report_id,
    recordPath: target.relative,
    destination: toVaultPath(vaultRoot, destination),
    reviewCount: update.review_items.length,
    snapshot,
    planPath: toVaultPath(vaultRoot, planPath),
    todayPath: toVaultPath(vaultRoot, todayPath),
  };
}
