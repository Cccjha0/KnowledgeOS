import path from "node:path";
import type { ApplicationDocument, ApplicationRecord, DashboardItem, ResearchRequest } from "../types.js";
import { parseMarkdown } from "../core/bridge.js";
import { listFilesRecursive, toVaultPath } from "../core/files.js";
import { APPLICATION_STATE_MACHINE, type ApplicationStatus } from "./stateMachine.js";
import { OPEN_RESEARCH_REQUEST_STATUSES } from "./researchRequest.js";
import { discoverInstances } from "../core/discovery.js";

interface Located<T> { file: string; data: T }

export async function collectApplicationDashboardItems(vaultRoot: string): Promise<DashboardItem[]> {
  const root = path.join(vaultRoot, "20-Workspace", "Applications");
  const items: DashboardItem[] = [];
  const records: Array<Located<ApplicationRecord>> = [];
  const documents: Array<Located<ApplicationDocument>> = [];
  const requests: Array<Located<ResearchRequest>> = [];
  let sequence = 0;
  const instanceRoots = (await discoverInstances(vaultRoot))
    .filter((instance) => instance.data.module_id === "application-tracker" && typeof instance.data.content_root === "string")
    .map((instance) => ({ instance_id: String(instance.data.instance_id), content_root: String(instance.data.content_root) }));
  const nextId = (kind: string): string => `DSH-APP-${kind}-${String(++sequence).padStart(3, "0")}`;

  for (const file of await listFilesRecursive(root, ".md")) {
    const parts = file.split(path.sep);
    const document = parseMarkdown(vaultRoot, file);
    if (parts.includes("Inbox")) {
      const vaultPath = toVaultPath(vaultRoot, file);
      const inferredInstance = instanceRoots.find((instance) => vaultPath === instance.content_root || vaultPath.startsWith(`${instance.content_root}/`));
      items.push({
        item_id: nextId("INBOX"), source_module: "application-tracker", instance_id: typeof document.data.instance_id === "string" ? document.data.instance_id : inferredInstance?.instance_id ?? null,
        category: "action", priority: "medium", title: "Process application Inbox item",
        description: path.basename(file), target: toVaultPath(vaultRoot, file), due_at: null,
        created_at: null, blocks_count: 0, active_context: true, actions: ["open", "run"],
      });
    } else if (document.data.type === "application-record") {
      records.push({ file, data: document.data as unknown as ApplicationRecord });
    } else if (document.data.type === "application-document") {
      documents.push({ file, data: document.data as unknown as ApplicationDocument });
    } else if (document.data.type === "research-request") {
      requests.push({ file, data: document.data as unknown as ResearchRequest });
    }
  }

  const pendingReviewFiles = await listFilesRecursive(path.join(vaultRoot, "90-System", "Review Queue", "Pending"), ".md");
  const pendingReviewTargets = new Map<string, number>();
  for (const file of pendingReviewFiles) {
    const review = parseMarkdown(vaultRoot, file);
    if (review.data.source_module !== "application-tracker" || typeof review.data.target !== "string") continue;
    pendingReviewTargets.set(review.data.target, (pendingReviewTargets.get(review.data.target) ?? 0) + 1);
  }

  for (const { file, data: record } of records) {
    const recordPath = toVaultPath(vaultRoot, file);
    const relatedDocuments = documents.filter((item) => item.data.application_id === record.id);
    const applicable = relatedDocuments.filter((item) => item.data.status !== "not-applicable");
    const ready = applicable.filter((item) => item.data.status === "ready" || item.data.status === "submitted").length;
    const openRequest = requests.find((item) =>
      item.data.application_id === record.id && OPEN_RESEARCH_REQUEST_STATUSES.has(item.data.status),
    );
    const due = record.monitoring.active && record.monitoring.next_check !== null && Date.parse(record.monitoring.next_check) <= Date.now();
    const rule = APPLICATION_STATE_MACHINE[record.application_status as ApplicationStatus];
    const nextAction = openRequest ? "核验请求已创建，等待研究结果" : rule?.today ?? "Review the application record";
    const reviewCount = pendingReviewTargets.get(recordPath) ?? 0;
    const verificationWaiting = due && Boolean(openRequest);
    items.push({
      item_id: nextId("PROJECT"),
      source_module: "application-tracker",
      instance_id: record.instance_id,
      category: due && !openRequest ? "research" : "status",
      priority: reviewCount > 0 || (due && !openRequest) ? "high" : "medium",
      title: `${record.institution} — ${record.program_name}`,
      description: [
        `Status: ${record.application_status}`,
        `Next check: ${record.monitoring.next_check ?? "stopped"}`,
        `Research request: ${verificationWaiting ? openRequest!.data.status : "none"}`,
        `Pending reviews: ${reviewCount}`,
        `Materials: ${ready}/${applicable.length}`,
        `Last update: ${record.updated}`,
        `Next action: ${nextAction}`,
      ].join(" | "),
      target: recordPath,
      due_at: due && !openRequest ? record.monitoring.next_check : null,
      created_at: record.created,
      blocks_count: reviewCount,
      active_context: true,
      actions: due && !openRequest ? ["open", "generate"] : ["open"],
    });
  }

  for (const { file, data: request } of requests.filter((item) => OPEN_RESEARCH_REQUEST_STATUSES.has(item.data.status))) {
    const record = records.find((item) => item.data.id === request.application_id)?.data;
    items.push({
      item_id: nextId("REQUEST"), source_module: "application-tracker", instance_id: request.instance_id,
      category: "research", priority: request.status === "needs-more-information" ? "high" : "medium",
      title: record ? `${record.institution} — ${record.program_name} 核验` : `Research Request ${request.request_id}`,
      description: request.status === "needs-more-information"
        ? `More evidence is required. Reports received: ${request.report_ids.length}.`
        : `Research pending: ${request.requested_fields.join(", ")}`,
      target: toVaultPath(vaultRoot, file), due_at: request.next_action_at, actions: ["open", "run"],
      created_at: request.created_at,
      blocks_count: 0,
      active_context: true,
    });
  }
  return items;
}
