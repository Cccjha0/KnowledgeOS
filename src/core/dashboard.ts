import { promises as fs } from "node:fs";
import path from "node:path";
import type { DashboardItem } from "./types.js";
import { parseMarkdown, validateSchema } from "./bridge.js";
import { exists, listFilesRecursive, toVaultPath } from "./files.js";
import { requeueDueReviews } from "./reviews.js";

const DASHBOARD_SCHEMA = "https://pkb.local/schemas/core/dashboard-item.schema.json";
const PRIORITY_WEIGHT: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function wikiLink(vaultPath: string): string {
  return `[[${vaultPath.replace(/\.md$/i, "")}]]`;
}

async function collectReviewDashboardItems(vaultRoot: string): Promise<DashboardItem[]> {
  const items: DashboardItem[] = [];
  const pendingRoot = path.join(vaultRoot, "90-System", "Review Queue", "Pending");
  for (const file of await listFilesRecursive(pendingRoot, ".md")) {
    const document = parseMarkdown(vaultRoot, file);
    if (document.data.status !== "pending") {
      continue;
    }
    const observation = document.data.target_observation;
    const warning = Boolean(
      observation && typeof observation === "object" && !Array.isArray(observation) &&
      (observation as Record<string, unknown>).matches === "neither",
    );
    items.push({
      item_id: `DSH-REVIEW-${String(document.data.review_id)}`,
      source_module: String(document.data.source_module),
      instance_id: typeof document.data.instance_id === "string" ? document.data.instance_id : null,
      category: warning ? "warning" : "review",
      priority: String(document.data.priority) as DashboardItem["priority"],
      title: String(document.data.reason ?? path.basename(file, ".md")),
      description: warning ? "目标文件已被修改，但关联审核项仍未关闭。" : "等待用户决定。",
      target: toVaultPath(vaultRoot, file),
      due_at: null,
      actions: ["open", "approve", "reject", "defer", "discuss"],
    });
  }

  const errorRoot = path.join(vaultRoot, "90-System", "Review Queue", "Error");
  for (const file of await listFilesRecursive(errorRoot, ".md")) {
    const document = parseMarkdown(vaultRoot, file);
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
      actions: ["open", "retry"],
    });
  }
  return items;
}

export async function buildTodayDashboard(
  vaultRoot: string,
  moduleItems: DashboardItem[] = [],
): Promise<string> {
  await requeueDueReviews(vaultRoot);
  const items = [...(await collectReviewDashboardItems(vaultRoot)), ...moduleItems];
  for (const item of items) {
    validateSchema(vaultRoot, DASHBOARD_SCHEMA, item);
  }
  items.sort((a, b) =>
    (PRIORITY_WEIGHT[a.priority] ?? 99) - (PRIORITY_WEIGHT[b.priority] ?? 99) ||
    a.title.localeCompare(b.title),
  );

  const logRoot = path.join(vaultRoot, "90-System", "Logs");
  let latestLog: string | null = null;
  if (await exists(logRoot)) {
    const logs = await listFilesRecursive(logRoot, ".md");
    logs.sort();
    const latest = logs.at(-1);
    latestLog = latest ? toVaultPath(vaultRoot, latest) : null;
  }

  const lines = [
    "# Today",
    "",
    `> 最后重建：${new Date().toISOString()}`,
    "",
    "## 今日优先事项",
    "",
  ];
  if (items.length === 0) {
    lines.push("- 当前没有必须处理的事项。");
  } else {
    const counts = new Map<string, number>();
    for (const item of items) {
      counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    }
    for (const [category, count] of counts) {
      lines.push(`- ${category}: ${count}`);
    }
  }

  lines.push("", "## 待处理", "");
  if (items.length === 0) {
    lines.push("- 无。");
  } else {
    for (const item of items) {
      const link = item.target ? wikiLink(item.target) : item.title;
      lines.push(`- ${link} — ${item.title}（${item.priority}）`);
      if (item.description) {
        lines.push(`  - ${item.description}`);
      }
      if (item.due_at) {
        lines.push(`  - 到期：${item.due_at}`);
      }
    }
  }

  lines.push("", "## 最近处理", "");
  lines.push(latestLog ? `- ${wikiLink(latestLog)}` : "- 暂无处理日志。");
  lines.push("");
  const todayPath = path.join(vaultRoot, "Today.md");
  await fs.writeFile(todayPath, lines.join("\n"), "utf8");
  return todayPath;
}
