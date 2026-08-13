import { promises as fs } from "node:fs";
import path from "node:path";
import type { DashboardItem, RecentRunSummary, TodayInboxGroup, TodaySnapshot } from "./types.js";
import { parseMarkdownBatch, validateSchemaBatch } from "./bridge.js";
import { exists, toVaultPath } from "./files.js";
import { requeueDueReviews } from "./reviews.js";
import { listRecentRunSummaries } from "./runSummaryIndex.js";
import { listReviewSummaryPage } from "./reviewSummaryIndex.js";

const DASHBOARD_SCHEMA = "https://pkb.local/schemas/core/dashboard-item.schema.json";
const PRIORITY_WEIGHT: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const USER_START = "<!-- knowledgeos:user:start -->";
const USER_END = "<!-- knowledgeos:user:end -->";
const TODAY_SECTION_LIMIT = 50;

function wikiLink(vaultPath: string): string {
  return `[[${vaultPath.replace(/\.md$/i, "")}]]`;
}

function itemKey(item: DashboardItem): string {
  return item.target ? `${item.source_module}:${item.target}:${item.category}` : `${item.source_module}:${item.item_id}`;
}

function isInboxTarget(target: string | null): boolean {
  return Boolean(target && /(?:^|\/)(?:00-Inbox|Inbox)\//.test(target));
}

function uniqueItems(items: DashboardItem[]): DashboardItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = itemKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rank(item: DashboardItem, now: number): number {
  let score = (PRIORITY_WEIGHT[item.priority] ?? 4) * 100;
  if (item.due_at) {
    const hours = (Date.parse(item.due_at) - now) / 3_600_000;
    score += hours <= 0 ? -80 : Math.min(hours, 720) / 10;
  } else {
    score += 50;
  }
  score -= Math.min(item.blocks_count ?? 0, 10) * 8;
  if (item.created_at) score += Math.max(-30, (Date.parse(item.created_at) - now) / 86_400_000);
  if (item.active_context) score -= 15;
  if (item.category === "review") score -= 20;
  if (item.category === "system") score -= 30;
  return score;
}

function sortItems(items: DashboardItem[], now = Date.now()): DashboardItem[] {
  return [...items].sort((a, b) => rank(a, now) - rank(b, now) || a.title.localeCompare(b.title));
}

async function collectReviewDashboardItems(
  vaultRoot: string,
  enabledModules: ReadonlySet<string> | null,
): Promise<{ items: DashboardItem[]; total: number }> {
  const items: DashboardItem[] = [];
  const page = await listReviewSummaryPage(vaultRoot, {
    statuses: ["pending", "error"],
    module_ids: enabledModules ? [...enabledModules] : [],
    page_size: TODAY_SECTION_LIMIT,
  });
  const summaries = Array.isArray(page.items) ? page.items as Array<Record<string, unknown>> : [];
  const pendingFiles = summaries
    .filter((entry) => entry.status === "pending")
    .map((entry) => path.join(vaultRoot, ...String(entry.vault_path).split("/")));
  const errorFiles = summaries
    .filter((entry) => entry.status === "error")
    .map((entry) => path.join(vaultRoot, ...String(entry.vault_path).split("/")));
  const parsed = parseMarkdownBatch(vaultRoot, [...pendingFiles, ...errorFiles]);
  for (const file of pendingFiles) {
    const document = parsed.get(file);
    if (!document) continue;
    if (document.data.status !== "pending") continue;
    const observation = document.data.target_observation;
    const warning = Boolean(
      observation && typeof observation === "object" && !Array.isArray(observation) &&
      (observation as Record<string, unknown>).matches === "neither",
    );
    items.push({
      item_id: `DSH-REVIEW-${String(document.data.review_id)}`,
      source_module: String(document.data.source_module),
      instance_id: typeof document.data.instance_id === "string" ? document.data.instance_id : null,
      category: "review",
      priority: String(document.data.priority) as DashboardItem["priority"],
      title: String(document.data.reason ?? path.basename(file, ".md")),
      description: warning
        ? "目标文件已被修改，但关联审核项仍未关闭。"
        : "等待用户决定。",
      target: toVaultPath(vaultRoot, file),
      due_at: null,
      created_at: typeof document.data.created === "string" ? document.data.created : null,
      blocks_count: 0,
      active_context: true,
      actions: warning
        ? ["open", "approve", "reject", "defer", "discuss", "reconcile"]
        : ["open", "approve", "reject", "defer", "discuss"],
    });
  }

  for (const file of errorFiles) {
    const document = parsed.get(file);
    if (!document) continue;
    items.push({
      item_id: `DSH-ERROR-${String(document.data.review_id)}`,
      source_module: String(document.data.source_module),
      instance_id: typeof document.data.instance_id === "string" ? document.data.instance_id : null,
      category: "system",
      priority: "critical",
      title: `审核执行失败：${String(document.data.review_id)}`,
      description: String(document.data.resolution ?? "需要人工检查。"),
      target: toVaultPath(vaultRoot, file),
      due_at: null,
      created_at: typeof document.data.created === "string" ? document.data.created : null,
      blocks_count: 0,
      active_context: true,
      actions: ["open", "retry"],
    });
  }
  return { items, total: typeof page.total === "number" ? page.total : items.length };
}

async function collectRecentRuns(vaultRoot: string): Promise<RecentRunSummary[]> {
  return (await listRecentRunSummaries(vaultRoot, { limit: 10 })).map((entry) => ({
    run_id: entry.run_id, source_module: entry.source_module, instance_id: entry.instance_id, status: entry.status,
    completed_at: entry.completed_at, plan_id: entry.plan_id, review_id: entry.review_id,
    target: entry.vault_path, can_rollback: entry.status === "completed" && entry.plan_id !== null,
  }));
}

function groupInbox(items: DashboardItem[]): TodayInboxGroup[] {
  const groups = new Map<string, TodayInboxGroup>();
  let displayed = 0;
  for (const item of items) {
    const scope = item.instance_id ? "instance" : item.source_module === "core" ? "global" : "module";
    const groupId = item.instance_id ?? (scope === "module" ? item.source_module : "global");
    const key = `${scope}:${groupId}`;
    const current = groups.get(key) ?? {
      group_id: groupId,
      scope,
      label: scope === "global" ? "全局 Inbox" : groupId,
      source_module: scope === "global" ? null : item.source_module,
      instance_id: item.instance_id,
      count: 0,
      oldest_created_at: null,
      unroutable_count: 0,
      failed_count: 0,
      items: [],
    };
    if (displayed < TODAY_SECTION_LIMIT) { current.items.push(item); displayed += 1; }
    current.count += 1;
    if (item.created_at && (!current.oldest_created_at || item.created_at < current.oldest_created_at)) {
      current.oldest_created_at = item.created_at;
    }
    if (item.source_module === "core") current.unroutable_count += 1;
    if (item.category === "system") current.failed_count += 1;
    groups.set(key, current);
  }
  return [...groups.values()].sort((a, b) => a.scope.localeCompare(b.scope) || a.label.localeCompare(b.label));
}

export async function buildTodaySnapshot(
  vaultRoot: string,
  moduleItems: DashboardItem[] = [],
  enabledModules: ReadonlySet<string> | null = null,
  countOverrides: { inbox?: number } = {},
): Promise<TodaySnapshot> {
  await requeueDueReviews(vaultRoot);
  const reviewProjection = await collectReviewDashboardItems(vaultRoot, enabledModules);
  const all = uniqueItems([
    ...reviewProjection.items,
    ...moduleItems,
  ]);
  const validation = validateSchemaBatch(vaultRoot, all.map((item) => ({ schemaId: DASHBOARD_SCHEMA, data: item })));
  const invalid = validation.filter((entry) => !entry.ok);
  const valid = all.filter((_item, index) => validation[index]?.ok === true);
  if (invalid.length) {
    valid.push({
      item_id: "DSH-CORE-DASHBOARD-VALIDATION", source_module: "core", instance_id: null,
      category: "system", priority: "high", title: "Dashboard data needs attention",
      description: `${invalid.length} item(s) failed runtime schema validation. Open System Center for details.`,
      target: null, due_at: null, actions: ["open"], created_at: null, blocks_count: invalid.length, active_context: true,
    });
  }
  const sorted = sortItems(valid);
  const reviews = sorted.filter((item) => item.category === "review");
  const inboxItems = sorted.filter((item) => item.category !== "system" && isInboxTarget(item.target));
  const failures = sorted.filter((item) => item.category === "system");
  const waitingExternal = sorted.filter((item) => item.category === "research" && item.actions.includes("run"));
  const due = sorted.filter((item) => item.category === "deadline" || Boolean(item.due_at));
  const moduleSummaries = sorted.filter((item) => item.category === "status" || item.category === "summary");
  const focusPool = sorted.filter((item) =>
    item.category !== "summary" &&
    (item.category !== "status" || item.due_at !== null) &&
    (item.category !== "research" || item.actions.includes("run")),
  );
  const recentCompleted = await collectRecentRuns(vaultRoot);
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    focus: focusPool.slice(0, 5),
    reviews: reviews.slice(0, TODAY_SECTION_LIMIT),
    inbox: groupInbox(inboxItems),
    due: due.slice(0, TODAY_SECTION_LIMIT),
    waiting_external: waitingExternal.slice(0, TODAY_SECTION_LIMIT),
    failures: failures.slice(0, TODAY_SECTION_LIMIT),
    recent_completed: recentCompleted,
    module_summaries: moduleSummaries.slice(0, TODAY_SECTION_LIMIT),
    counts: {
      focus: Math.min(focusPool.length, 5),
      reviews: reviewProjection.total,
      inbox: countOverrides.inbox ?? inboxItems.length,
      due: due.length,
      waiting_external: waitingExternal.length,
      failures: failures.length,
      recent_completed: recentCompleted.length,
    },
  };
}

function renderItems(items: DashboardItem[]): string[] {
  const lines: string[] = [];
  for (const item of items) {
    const label = item.target ? wikiLink(item.target) : item.title;
    lines.push(`- ${label} — ${item.title}（${item.priority}）`);
    if (item.description) lines.push(`  - ${item.description}`);
    if (item.due_at) lines.push(`  - 到期：${item.due_at}`);
  }
  return lines;
}

function addSection(lines: string[], title: string, content: string[]): void {
  if (content.length === 0) return;
  lines.push("", `## ${title}`, "", ...content);
}

async function preservedUserArea(todayPath: string): Promise<string[]> {
  if (!(await exists(todayPath))) return [USER_START, "", "可在此区域添加个人笔记；重新生成 Today 时会保留。", "", USER_END];
  const content = await fs.readFile(todayPath, "utf8");
  const start = content.indexOf(USER_START);
  const end = content.indexOf(USER_END);
  if (start < 0 || end < start) return [USER_START, "", "", USER_END];
  return content.slice(start, end + USER_END.length).split(/\r?\n/);
}

export async function writeTodayMarkdown(vaultRoot: string, snapshot: TodaySnapshot): Promise<string> {
  return (await writeTodayMarkdownWithResult(vaultRoot, snapshot)).path;
}

export interface TodayWriteResult {
  path: string;
  written: boolean;
}

function comparableTodayMarkdown(content: string): string {
  return content.replace(/^(> [^\r\n]*?)(\d{4}-\d{2}-\d{2}T[^\r\n]+)$/m, "$1<generated-at>");
}

export async function writeTodayMarkdownWithResult(vaultRoot: string, snapshot: TodaySnapshot): Promise<TodayWriteResult> {
  const todayPath = path.join(vaultRoot, "Today.md");
  const userArea = await preservedUserArea(todayPath);
  const lines = ["# Today", "", `> 最后更新：${snapshot.generated_at}`];
  const rendered = new Set<string>();
  const renderOnce = (items: DashboardItem[]): string[] => renderItems(items.filter((item) => {
    const key = itemKey(item);
    if (rendered.has(key)) return false;
    rendered.add(key);
    return true;
  }));
  addSection(lines, "今日重点", renderOnce(snapshot.focus));
  addSection(lines, "待审核", renderOnce(snapshot.reviews));
  addSection(lines, "待处理 Inbox", snapshot.inbox.map((group) => `- ${group.label}：${group.count} 项`));
  addSection(lines, "即将到期", renderOnce(snapshot.due));
  addSection(lines, "等待外部操作", renderOnce(snapshot.waiting_external));
  addSection(lines, "异常与失败", renderOnce(snapshot.failures));
  addSection(lines, "最近完成", snapshot.recent_completed.map((run) => `- ${wikiLink(run.target)} — ${run.source_module}（${run.completed_at}）`));
  addSection(lines, "模块状态摘要", renderOnce(snapshot.module_summaries));
  if (snapshot.focus.length === 0 && snapshot.recent_completed.length === 0) lines.push("", "当前没有需要处理的事项。");
  lines.push("", "## 我的笔记", "", ...userArea, "");
  const content = lines.join("\n");
  if (await exists(todayPath)) {
    const current = await fs.readFile(todayPath, "utf8");
    if (comparableTodayMarkdown(current) === comparableTodayMarkdown(content)) {
      return { path: todayPath, written: false };
    }
  }
  await fs.writeFile(todayPath, content, "utf8");
  return { path: todayPath, written: true };
}

export async function buildTodayDashboard(vaultRoot: string, moduleItems: DashboardItem[] = []): Promise<string> {
  return writeTodayMarkdown(vaultRoot, await buildTodaySnapshot(vaultRoot, moduleItems));
}
