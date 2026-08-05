function markLiveRegion(element, politeness = "polite") {
  element.setAttr("role", "status");
  element.setAttr("aria-live", politeness);
  element.setAttr("aria-atomic", "true");
  return element;
}

function createUiHelpers(setIcon) {
  function createToolbarButton(parent, icon, label, options = {}) {
    const button = parent.createEl("button", { cls: `knowledgeos-toolbar-button${options.iconOnly ? " is-icon-only" : ""}${options.cls ? ` ${options.cls}` : ""}` });
    setIcon(button, icon);
    if (!options.iconOnly) button.createSpan({ text: label });
    button.setAttr("aria-label", label);
    button.setAttr("title", label);
    return button;
  }

  function renderLoadingSkeleton(root, label) {
    root.empty();
    const loading = markLiveRegion(root.createDiv({ cls: "knowledgeos-loading" }));
    loading.createDiv({ cls: "knowledgeos-loading-label", text: label });
    const grid = loading.createDiv({ cls: "knowledgeos-loading-grid" });
    for (let index = 0; index < 4; index += 1) {
      const card = grid.createDiv({ cls: "knowledgeos-loading-card" });
      card.createDiv({ cls: "knowledgeos-skeleton is-short" });
      card.createDiv({ cls: "knowledgeos-skeleton is-wide" });
      card.createDiv({ cls: "knowledgeos-skeleton is-medium" });
    }
  }

  function addCardArrow(parent) {
    const arrow = parent.createSpan({ cls: "knowledgeos-card-arrow", attr: { "aria-hidden": "true" } });
    setIcon(arrow, "chevron-right");
    return arrow;
  }

  function renderDeveloperDetails(parent, plugin, rows) {
    if (!plugin.settings.developerMode) return;
    const details = parent.createEl("details", { cls: "knowledgeos-technical" });
    details.createEl("summary", { text: "开发者信息" });
    for (const [label, value] of rows.filter(([, value]) => value !== undefined && value !== null && value !== "")) {
      details.createDiv({ text: `${label}：${value}` });
    }
  }

  function renderRecoverableError(root, title, error, retry) {
    root.empty();
    root.createEl("h2", { text: title });
    root.createEl("p", { text: error?.message || "发生未知错误；本地 Markdown 数据没有被删除。" });
    if (error?.impact) root.createEl("p", { cls: "knowledgeos-impact", text: error.impact });
    if (error?.recovery_actions?.length) {
      const actions = root.createEl("ul");
      for (const action of error.recovery_actions) actions.createEl("li", { text: action });
    }
    const retryButton = root.createEl("button", { cls: "mod-cta", text: "重试" });
    retryButton.onclick = retry;
    return retryButton;
  }

  return { createToolbarButton, renderLoadingSkeleton, addCardArrow, renderDeveloperDetails, renderRecoverableError };
}

module.exports = { markLiveRegion, createUiHelpers };
