import { promises as fs } from "node:fs";
import path from "node:path";
import { parseMarkdown } from "./bridge.js";
import { exists, listFilesRecursive, toVaultPath } from "./files.js";

function wikiLink(vaultPath: string): string {
  return `[[${vaultPath.replace(/\.md$/i, "")}]]`;
}

export async function buildTodayDashboard(vaultRoot: string): Promise<string> {
  const inboxRoot = path.join(vaultRoot, "20-Workspace", "Applications");
  const inboxFiles = (await listFilesRecursive(inboxRoot, ".md")).filter((file) =>
    file.split(path.sep).includes("Inbox"),
  );

  const reviewRoot = path.join(vaultRoot, "90-System", "Review Queue", "Pending");
  const reviewFiles = await listFilesRecursive(reviewRoot, ".md");
  const pendingReviews: Array<{ path: string; title: string; priority: string }> = [];
  for (const reviewFile of reviewFiles) {
    const document = parseMarkdown(vaultRoot, reviewFile);
    if (document.data.status === "pending") {
      pendingReviews.push({
        path: toVaultPath(vaultRoot, reviewFile),
        title: String(document.data.reason ?? path.basename(reviewFile, ".md")),
        priority: String(document.data.priority ?? "medium"),
      });
    }
  }

  const recordRoot = path.join(vaultRoot, "20-Workspace", "Applications");
  const recordFiles = (await listFilesRecursive(recordRoot, ".md")).filter((file) =>
    file.split(path.sep).includes("Records"),
  );
  const now = Date.now();
  const dueRecords: Array<{ path: string; title: string; due: string }> = [];
  for (const recordFile of recordFiles) {
    const document = parseMarkdown(vaultRoot, recordFile);
    const monitoring = document.data.monitoring;
    if (monitoring && typeof monitoring === "object" && !Array.isArray(monitoring)) {
      const nextCheck = (monitoring as Record<string, unknown>).next_check;
      const active = (monitoring as Record<string, unknown>).active;
      if (active === true && typeof nextCheck === "string" && Date.parse(nextCheck) <= now) {
        dueRecords.push({
          path: toVaultPath(vaultRoot, recordFile),
          title: `${String(document.data.institution ?? "申请项目")} — ${String(document.data.program_name ?? "")}`,
          due: nextCheck,
        });
      }
    }
  }

  const logRoot = path.join(vaultRoot, "90-System", "Logs");
  let latestLog: string | null = null;
  if (await exists(logRoot)) {
    const logs = await listFilesRecursive(logRoot, ".md");
    logs.sort();
    const latest = logs.at(-1);
    latestLog = latest ? toVaultPath(vaultRoot, latest) : null;
  }

  const lines: string[] = [
    "# Today",
    "",
    `> 最后重建：${new Date().toISOString()}`,
    "",
    "## 今日优先事项",
    "",
  ];

  if (pendingReviews.length === 0 && dueRecords.length === 0 && inboxFiles.length === 0) {
    lines.push("- 当前没有必须处理的申请事项。");
  } else {
    if (pendingReviews.length > 0) {
      lines.push(`- 审核 ${pendingReviews.length} 项关键申请信息。`);
    }
    if (dueRecords.length > 0) {
      lines.push(`- 重新核验 ${dueRecords.length} 个到期申请项目。`);
    }
    if (inboxFiles.length > 0) {
      lines.push(`- 处理申请 Inbox 中的 ${inboxFiles.length} 个 Markdown 文件。`);
    }
  }

  lines.push("", "## 待人工审核", "");
  if (pendingReviews.length === 0) {
    lines.push("- 无。");
  } else {
    for (const item of pendingReviews.sort((a, b) => a.priority.localeCompare(b.priority))) {
      lines.push(`- ${wikiLink(item.path)} — ${item.title}（${item.priority}）`);
    }
  }

  lines.push("", "## 等待外部核验", "");
  if (dueRecords.length === 0) {
    lines.push("- 无到期项目。");
  } else {
    for (const item of dueRecords) {
      lines.push(`- ${wikiLink(item.path)} — 下次检查：${item.due}`);
    }
  }

  lines.push("", "## Application Inbox", "");
  if (inboxFiles.length === 0) {
    lines.push("- 已清空。");
  } else {
    for (const file of inboxFiles) {
      lines.push(`- ${wikiLink(toVaultPath(vaultRoot, file))}`);
    }
  }

  lines.push("", "## 最近处理", "");
  lines.push(latestLog ? `- ${wikiLink(latestLog)}` : "- 暂无处理日志。");
  lines.push("");

  const todayPath = path.join(vaultRoot, "Today.md");
  await fs.writeFile(todayPath, lines.join("\n"), "utf8");
  return todayPath;
}
