import { promises as fs } from "node:fs";
import path from "node:path";
import type { MarkdownDocument, ReviewItem, ReviewStatus } from "../types.js";
import { parseMarkdown, validateSchema, writeMarkdown } from "./bridge.js";
import { ensureDir, exists } from "./files.js";

const REVIEW_SCHEMA = "https://pkb.local/schemas/core/review-item.schema.json";
const REVIEW_DIRECTORIES = ["Pending", "Deferred", "Closed", "Error"] as const;

export interface LocatedReview {
  filePath: string;
  document: MarkdownDocument;
  item: ReviewItem;
}

function directoryForStatus(status: ReviewStatus): typeof REVIEW_DIRECTORIES[number] {
  if (status === "pending") {
    return "Pending";
  }
  if (status === "deferred") {
    return "Deferred";
  }
  if (status === "error") {
    return "Error";
  }
  return "Closed";
}

function renderReviewContent(item: ReviewItem): string {
  return [
    `# 审核事项 ${item.review_id}`,
    "",
    "## 建议修改",
    "",
    `操作：${item.action}`,
    "",
    "```json",
    JSON.stringify(item.proposed_value, null, 2),
    "```",
    "",
    "## 判断依据",
    "",
    item.reason,
    "",
    "## 用户决定",
    "",
    item.decision
      ? `- ${item.decision.decision}：${item.decision.user_comment || "（无备注）"}`
      : "尚未决定。可通过 `pkb review decide` 处理。",
    "",
    "## 执行结果",
    "",
    item.resolution ?? "尚未执行。",
    "",
  ].join("\n");
}

export async function writeReviewItems(vaultRoot: string, items: ReviewItem[]): Promise<string[]> {
  const paths: string[] = [];
  for (const item of items) {
    validateSchema(vaultRoot, REVIEW_SCHEMA, item);
    const directory = path.join(vaultRoot, "90-System", "Review Queue", directoryForStatus(item.status));
    await ensureDir(directory);
    const filePath = path.join(directory, `${item.review_id}.md`);
    writeMarkdown(vaultRoot, filePath, { data: item, content: renderReviewContent(item) });
    paths.push(filePath);
  }
  return paths;
}

export async function locateReviewItem(vaultRoot: string, reviewId: string): Promise<LocatedReview> {
  const matches: string[] = [];
  for (const directory of REVIEW_DIRECTORIES) {
    const candidate = path.join(vaultRoot, "90-System", "Review Queue", directory, `${reviewId}.md`);
    if (await exists(candidate)) {
      matches.push(candidate);
    }
  }
  if (matches.length === 0) {
    throw new Error(`找不到审核项：${reviewId}`);
  }
  if (matches.length > 1) {
    throw new Error(`审核项存在重复文件：${reviewId}`);
  }
  const document = parseMarkdown(vaultRoot, matches[0]!);
  validateSchema(vaultRoot, REVIEW_SCHEMA, document.data);
  return { filePath: matches[0]!, document, item: document.data as unknown as ReviewItem };
}

export async function persistReviewItem(
  vaultRoot: string,
  located: LocatedReview,
  item: ReviewItem,
): Promise<string> {
  validateSchema(vaultRoot, REVIEW_SCHEMA, item);
  const destinationDirectory = path.join(
    vaultRoot,
    "90-System",
    "Review Queue",
    directoryForStatus(item.status),
  );
  await ensureDir(destinationDirectory);
  const destination = path.join(destinationDirectory, `${item.review_id}.md`);
  writeMarkdown(vaultRoot, destination, { data: item, content: renderReviewContent(item) });
  if (path.resolve(destination) !== path.resolve(located.filePath)) {
    await fs.unlink(located.filePath);
  }
  return destination;
}

export async function requeueDueReviews(vaultRoot: string, now = new Date()): Promise<string[]> {
  const deferredDirectory = path.join(vaultRoot, "90-System", "Review Queue", "Deferred");
  if (!(await exists(deferredDirectory))) {
    return [];
  }
  const entries = await fs.readdir(deferredDirectory, { withFileTypes: true });
  const requeued: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.startsWith(".")) {
      continue;
    }
    const filePath = path.join(deferredDirectory, entry.name);
    const document = parseMarkdown(vaultRoot, filePath);
    const item = document.data as unknown as ReviewItem;
    if (item.status !== "deferred" || !item.review_after || Date.parse(item.review_after) > now.getTime()) {
      continue;
    }
    const updated: ReviewItem = {
      ...item,
      status: "pending",
      decision: null,
      review_after: null,
      resolution: "延后期限已到，系统重新打开审核项。",
    };
    await persistReviewItem(vaultRoot, { filePath, document, item }, updated);
    requeued.push(item.review_id);
  }
  return requeued;
}
