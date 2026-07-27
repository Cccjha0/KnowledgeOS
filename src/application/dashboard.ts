import path from "node:path";
import type { DashboardItem } from "../types.js";
import { parseMarkdown } from "../core/bridge.js";
import { listFilesRecursive, toVaultPath } from "../core/files.js";

export async function collectApplicationDashboardItems(vaultRoot: string): Promise<DashboardItem[]> {
  const root = path.join(vaultRoot, "20-Workspace", "Applications");
  const items: DashboardItem[] = [];
  let sequence = 0;
  const nextId = (kind: string): string => `DSH-APP-${kind}-${String(++sequence).padStart(3, "0")}`;

  const markdownFiles = await listFilesRecursive(root, ".md");
  for (const file of markdownFiles) {
    const parts = file.split(path.sep);
    if (parts.includes("Inbox")) {
      items.push({
        item_id: nextId("INBOX"),
        source_module: "application-tracker",
        instance_id: null,
        category: "action",
        priority: "medium",
        title: "处理申请 Inbox 文件",
        description: path.basename(file),
        target: toVaultPath(vaultRoot, file),
        due_at: null,
        actions: ["open", "run"],
      });
      continue;
    }
    if (!parts.includes("Records")) {
      continue;
    }
    const document = parseMarkdown(vaultRoot, file);
    const monitoring = document.data.monitoring;
    if (!monitoring || typeof monitoring !== "object" || Array.isArray(monitoring)) {
      continue;
    }
    const active = (monitoring as Record<string, unknown>).active;
    const nextCheck = (monitoring as Record<string, unknown>).next_check;
    if (active !== true || typeof nextCheck !== "string" || Date.parse(nextCheck) > Date.now()) {
      continue;
    }
    items.push({
      item_id: nextId("DUE"),
      source_module: "application-tracker",
      instance_id: typeof document.data.module_instance === "string" ? document.data.module_instance : null,
      category: "research",
      priority: "high",
      title: `${String(document.data.institution ?? "申请项目")} — ${String(document.data.program_name ?? "")}`,
      description: "申请信息已到重新核验时间。",
      target: toVaultPath(vaultRoot, file),
      due_at: nextCheck,
      actions: ["open", "generate", "defer"],
    });
  }
  return items;
}
