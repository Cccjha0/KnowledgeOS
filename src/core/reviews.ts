import path from "node:path";
import type { MarkdownDocument, ReviewItem } from "../types.js";
import { ensureDir } from "./files.js";
import { writeMarkdown } from "./bridge.js";

export async function writeReviewItems(
  vaultRoot: string,
  items: ReviewItem[],
): Promise<string[]> {
  const directory = path.join(vaultRoot, "90-System", "Review Queue", "Pending");
  await ensureDir(directory);
  const paths: string[] = [];

  for (const item of items) {
    const filePath = path.join(directory, `${item.review_id}.md`);
    const proposed = JSON.stringify(item.proposed_value, null, 2);
    const document: MarkdownDocument = {
      data: item,
      content: [
        `# 审核事项 ${item.review_id}`,
        "",
        "## 建议修改",
        "",
        `操作：${item.action}`,
        "",
        "```json",
        proposed,
        "```",
        "",
        "## 判断依据",
        "",
        item.reason,
        "",
        "## 用户决定",
        "",
        "<!-- 在此填写，或通过 CLI 执行 approve / reject / defer -->",
        "",
        "## 执行结果",
        "",
        "尚未执行。",
        "",
      ].join("\n"),
    };
    writeMarkdown(vaultRoot, filePath, document);
    paths.push(filePath);
  }

  return paths;
}
