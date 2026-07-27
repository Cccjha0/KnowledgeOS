import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  ApplicationRecord,
  JsonObject,
  MarkdownDocument,
  OperationPlan,
  ProcessedReportsFile,
  ResearchReport,
  UpdateResult,
} from "../types.js";
import { parseMarkdown, parseYaml, validateSchema, writeMarkdown } from "../core/bridge.js";
import { buildTodayDashboard } from "../core/dashboard.js";
import { PkbError } from "../core/errors.js";
import {
  deepMerge,
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
import { appendToSection } from "../core/markdown.js";
import { writeReviewItems } from "../core/reviews.js";
import { DeterministicComparisonAdapter, type ComparisonAdapter } from "./adapter.js";
import { buildOperationPlan } from "./plan.js";

const SCHEMAS = {
  instance: "https://pkb.local/schemas/application-tracker/application-instance.schema.json",
  record: "https://pkb.local/schemas/application-tracker/application-record.schema.json",
  report: "https://pkb.local/schemas/application-tracker/research-report.schema.json",
  update: "https://pkb.local/schemas/application-tracker/update-result.schema.json",
  plan: "https://pkb.local/schemas/core/operation-plan.schema.json",
  review: "https://pkb.local/schemas/core/review-item.schema.json",
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
    if (sameInstitution && sameIntake && sameProgram) {
      matches.push({
        absolute: candidate,
        relative: toVaultPath(vaultRoot, candidate),
        document,
        record,
      });
    }
  }

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

async function writeRunLog(
  vaultRoot: string,
  runId: string,
  report: ResearchReport,
  plan: OperationPlan,
  snapshot: string,
  destination: string,
  reviewPaths: string[],
): Promise<string> {
  const logsRoot = path.join(vaultRoot, "90-System", "Logs");
  await ensureDir(logsRoot);
  const filePath = path.join(logsRoot, `${runId}.md`);
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

  writeMarkdown(vaultRoot, filePath, {
    data: {
      run_id: runId,
      task_id: plan.task_id,
      plan_id: plan.plan_id,
      module: "application-tracker",
      instance: report.instance_id,
      status: "completed",
      git_snapshot: snapshot,
      started_at: now,
      completed_at: new Date().toISOString(),
      schema_version: 1,
    },
    content,
  });
  return filePath;
}

async function executePlan(
  vaultRoot: string,
  recordAbsolute: string,
  recordDocument: MarkdownDocument,
  sourceReport: string,
  destinationReport: string,
  plan: OperationPlan,
): Promise<void> {
  const transactionRoot = path.join(vaultRoot, "90-System", "State", ".transactions", plan.plan_id);
  await ensureDir(transactionRoot);
  const recordBackup = path.join(transactionRoot, "record.md.bak");
  const reportBackup = path.join(transactionRoot, "report.md.bak");
  await fs.copyFile(recordAbsolute, recordBackup);
  await fs.copyFile(sourceReport, reportBackup);

  try {
    const updateOperation = plan.operations.find((operation) => operation.type === "update-frontmatter");
    const appendOperation = plan.operations.find((operation) => operation.type === "append-section");
    if (!updateOperation || !appendOperation) {
      throw new PkbError("INVALID_PLAN", "Operation Plan 缺少更新档案所需的操作。", plan);
    }

    const patch = updateOperation.payload.patch;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new PkbError("INVALID_PLAN", "update-frontmatter patch 无效。", updateOperation);
    }

    const section = String(appendOperation.payload.section ?? "变更记录");
    const entry = String(appendOperation.payload.content ?? "");
    const marker = String(appendOperation.payload.marker ?? "");
    const updatedDocument: MarkdownDocument = {
      data: deepMerge(recordDocument.data, patch as JsonObject),
      content: appendToSection(recordDocument.content, section, entry, marker),
    };
    validateSchema(vaultRoot, SCHEMAS.record, updatedDocument.data);
    writeMarkdown(vaultRoot, recordAbsolute, updatedDocument);

    await ensureDir(path.dirname(destinationReport));
    if (path.resolve(sourceReport) !== path.resolve(destinationReport)) {
      if (await exists(destinationReport)) {
        const same = (await sha256File(destinationReport)) === (await sha256File(sourceReport));
        if (!same) {
          throw new PkbError("REPORT_DESTINATION_EXISTS", "研究报告归档目标已存在且内容不同。", destinationReport);
        }
        await fs.unlink(sourceReport);
      } else {
        await fs.rename(sourceReport, destinationReport);
      }
    }
  } catch (error) {
    await fs.copyFile(recordBackup, recordAbsolute);
    if (!(await exists(sourceReport))) {
      await fs.copyFile(reportBackup, sourceReport);
    }
    if (await exists(destinationReport)) {
      const destinationHash = await sha256File(destinationReport);
      const backupHash = await sha256File(reportBackup);
      if (destinationHash === backupHash && path.resolve(destinationReport) !== path.resolve(sourceReport)) {
        await fs.unlink(destinationReport);
      }
    }
    throw error;
  } finally {
    await fs.rm(transactionRoot, { recursive: true, force: true });
  }
}

export async function processApplicationReport(
  options: ProcessReportOptions,
): Promise<ProcessReportResult> {
  const vaultRoot = path.resolve(options.vaultRoot);
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
  const reportReference = reportWikiReference(vaultRoot, destination);
  const now = new Date().toISOString();

  const comparisonAdapter = options.comparisonAdapter ?? new DeterministicComparisonAdapter();
  const update: UpdateResult = await comparisonAdapter.compare(target.record, report, {
    targetRecordPath: target.relative,
    reportReference,
    now,
    allocateReviewId: () => allocateId(vaultRoot, "REV"),
  });
  for (const review of update.review_items) {
    validateSchema(vaultRoot, SCHEMAS.review, review);
  }
  validateSchema(vaultRoot, SCHEMAS.update, update);

  const taskId = await allocateId(vaultRoot, "TASK");
  const planId = await allocateId(vaultRoot, "PLAN");
  const runId = await allocateId(vaultRoot, "RUN");
  const plan = buildOperationPlan(vaultRoot, reportAbsolute, destination, report, update, {
    taskId,
    planId,
  });
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
  await executePlan(
    vaultRoot,
    target.absolute,
    target.document,
    reportAbsolute,
    destination,
    plan,
  );
  const reviewPaths = await writeReviewItems(vaultRoot, update.review_items);

  processed.reports[report.report_id] = {
    hash: reportHash,
    processed_at: new Date().toISOString(),
    run_id: runId,
    destination: toVaultPath(vaultRoot, destination),
  };
  await writeJsonAtomic(processedPath, processed);
  await writeRunLog(vaultRoot, runId, report, plan, snapshot, destination, reviewPaths);
  const todayPath = await buildTodayDashboard(vaultRoot);

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
