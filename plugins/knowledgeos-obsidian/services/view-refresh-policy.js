const VIEW_KEYS = Object.freeze({
  today: "today",
  reviews: "reviews",
  inbox: "inbox",
  system: "system",
});

function affectedKnowledgeViews(filePath) {
  const normalized = String(filePath || "").replaceAll("\\", "/");
  if (!normalized || normalized === "Today.md" || normalized.startsWith(".obsidian/")) return [];
  if (["90-System/Cache/", "90-System/Backups/"].some((prefix) => normalized.startsWith(prefix))) return [];

  if (normalized.startsWith("00-Inbox/") || normalized === "00-Inbox" || normalized.includes("/Inbox/") || normalized.endsWith("/Inbox")) return [VIEW_KEYS.today, VIEW_KEYS.inbox];
  if (normalized.startsWith("90-System/Logs/")) return [VIEW_KEYS.today, VIEW_KEYS.system];
  if (normalized.startsWith("90-System/Review Queue/")) return [VIEW_KEYS.today, VIEW_KEYS.reviews, VIEW_KEYS.system];
  if (normalized.startsWith("90-System/State/")) {
    if (/\/(?:Captures|Sidecars|Inbox)\//.test(normalized)) return [VIEW_KEYS.today, VIEW_KEYS.inbox];
    return [VIEW_KEYS.today, VIEW_KEYS.system];
  }
  if (normalized.startsWith("90-System/Modules/") || normalized.startsWith("90-System/Module Development/")) {
    return [VIEW_KEYS.today, VIEW_KEYS.system];
  }
  return [VIEW_KEYS.today, VIEW_KEYS.system];
}

function affectedKnowledgeViewsForPaths(filePaths) {
  const views = new Set();
  for (const filePath of filePaths || []) for (const view of affectedKnowledgeViews(filePath)) views.add(view);
  return [...views];
}

module.exports = { VIEW_KEYS, affectedKnowledgeViews, affectedKnowledgeViewsForPaths };
