const { LatestRequestGate } = require("../services/latest-request");

function createTodayViews(deps) {
  const { ItemView, Modal, Notice, PluginSettingTab, Setting, setIcon, VIEW_TYPE, REVIEW_VIEW_TYPE, INBOX_VIEW_TYPE, SYSTEM_VIEW_TYPE, settingsDefaults, moduleUiMetadata, manifestFormatters, LIST_PAGE_SIZE, FALLBACK_CODEX_MODELS, REASONING_LABELS, markLiveRegion, taskCycleChanged, shouldAutoRefreshPath, missingBuiltCliFailure, labelStatus, labelModule, labelJob, labelField, friendlyAction, calendarDayDifference, formatTime, formatVerificationSchedule, createTime, formatTodayHeading, friendlyDashboardDescription, friendlyDashboardTitle, createToolbarButton, renderLoadingSkeleton, addCardArrow, renderDeveloperDetails, renderRecoverableError } = deps;
class TodayView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.state = "ready";
    this.snapshot = null;
    this.refreshPromise = null;
    this.refreshQueued = false;
    this.backgroundStatus = null;
    this.lastSuccessfulAt = null;
    this.partialWarnings = [];
    this.refreshGate = new LatestRequestGate();
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "KnowledgeOS Today"; }
  getIcon() { return "calendar-check"; }

  async onOpen() { await this.refresh(); }

  async refresh(options = {}) {
    this.refreshGate.request();
    const background = options.background === true;
    if (this.refreshPromise) {
      this.refreshQueued = true;
      return this.refreshPromise;
    }
    this.refreshPromise = (async () => {
      let nextIsBackground = background;
      do {
        this.refreshQueued = false;
        await this.performRefresh(nextIsBackground, this.refreshGate.current());
        nextIsBackground = true;
      } while (this.refreshQueued);
    })();
    try { await this.refreshPromise; }
    finally { this.refreshPromise = null; }
  }

  async performRefresh(background, generation = this.refreshGate.current()) {
    const preserveContent = Boolean(this.snapshot && this.contentEl.childElementCount > 0);
    this.state = "loading";
    this.contentEl.setAttr("aria-busy", "true");
    if (preserveContent) this.renderBackgroundStatus("更新中…");
    else this.renderLoading();
    const response = await this.plugin.client.invoke("getTodayItems", { refresh_markdown: !background });
    if (!this.refreshGate.isCurrent(generation)) return;
    this.state = response.state;
    this.contentEl.removeAttribute("aria-busy");
    if (!response.ok) {
      if (preserveContent) this.renderStaleStatus(response.error);
      else this.renderError(response.error);
      return;
    }
    const normalized = this.normalizeSnapshot(response.data);
    if (!normalized) {
      const error = { message: "Core 返回的 Today 数据缺少必要内容。", impact: "上次成功生成的 Today.md 没有被修改。", recovery_actions: ["重试加载 Today"] };
      if (preserveContent) this.renderStaleStatus(error);
      else this.renderError(error);
      return;
    }
    this.snapshot = normalized;
    this.lastSuccessfulAt = normalized.generated_at || null;
    this.renderSnapshot(normalized);
  }

  renderBackgroundStatus(text, failed = false, retry = false) {
    this.backgroundStatus?.remove();
    const status = markLiveRegion(this.contentEl.createDiv({ cls: `knowledgeos-today-refresh-state${failed ? " is-error is-stale" : ""}` }));
    status.createSpan({ text });
    if (retry) {
      const button = status.createEl("button", { text: "重试" });
      button.onclick = () => this.refresh();
    }
    this.contentEl.prepend(status);
    this.backgroundStatus = status;
  }

  renderStaleStatus(error) {
    const updated = this.snapshot?.generated_at || this.lastSuccessfulAt;
    const reason = error?.message ? `：${error.message}` : "";
    this.renderBackgroundStatus(`显示的是上次成功生成的 Today 内容${updated ? ` · ${formatTime(updated)}` : ""}${reason}`, true, true);
  }

  renderPageHeader(root, loading = false, generatedAt = null) {
    const header = root.createDiv({ cls: "knowledgeos-page-header knowledgeos-today-header" });
    const heading = header.createDiv({ cls: "knowledgeos-today-heading" });
    const titleRow = heading.createDiv({ cls: "knowledgeos-title-row" });
    const titleIcon = titleRow.createSpan({ cls: "knowledgeos-title-icon", attr: { "aria-hidden": "true" } });
    setIcon(titleIcon, "calendar-check");
    titleRow.createEl("h2", { text: "今天" });
    heading.createDiv({ cls: "knowledgeos-page-subtitle", text: formatTodayHeading(new Date()) });
    if (generatedAt) createTime(heading.createDiv({ cls: "knowledgeos-today-updated" }), generatedAt, "更新于 ");
    const actions = header.createDiv({ cls: "knowledgeos-header-actions" });
    const refresh = createToolbarButton(actions, "refresh-cw", "刷新", { iconOnly: true });
    refresh.disabled = loading;
    refresh.onclick = () => this.refresh();
    const open = createToolbarButton(actions, "file-text", "打开页面");
    open.onclick = () => this.app.workspace.openLinkText("Today", "", false);
  }

  renderLoading() {
    const root = this.contentEl;
    root.empty();
    root.addClass("knowledgeos-today-view");
    this.backgroundStatus = null;
    this.renderPageHeader(root, true);
    const body = root.createDiv({ cls: "knowledgeos-today-loading" });
    renderLoadingSkeleton(body, "正在准备今天的事项…");
  }

  renderError(error) {
    const root = this.contentEl;
    root.empty();
    root.addClass("knowledgeos-today-view");
    this.backgroundStatus = null;
    this.renderPageHeader(root);
    const body = root.createDiv({ cls: "knowledgeos-today-failure" });
    renderRecoverableError(body, "Today 暂时不可用", error, () => this.refresh());
    const open = body.createEl("button", { text: "打开上次生成的 Today.md" });
    open.onclick = () => this.app.workspace.openLinkText("Today", "", false);
  }

  normalizeSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.focus)) return null;
    this.partialWarnings = [];
    const optionalArrays = ["reviews", "inbox", "due", "waiting_external", "failures", "recent_completed", "module_summaries"];
    const normalized = { ...snapshot };
    for (const key of optionalArrays) {
      if (!Array.isArray(snapshot[key])) {
        normalized[key] = [];
        this.partialWarnings.push(key);
      }
    }
    if (!snapshot.counts || typeof snapshot.counts !== "object" || Array.isArray(snapshot.counts)) {
      normalized.counts = {
        focus: normalized.focus.length,
        reviews: normalized.reviews.length,
        inbox: normalized.inbox.reduce((sum, group) => sum + (Number(group.count) || 0), 0),
        due: normalized.due.length,
        waiting_external: normalized.waiting_external.length,
        failures: normalized.failures.length,
        recent_completed: normalized.recent_completed.length,
      };
      this.partialWarnings.push("counts");
    }
    if (typeof snapshot.generated_at !== "string") this.partialWarnings.push("generated_at");
    return normalized;
  }

  renderSnapshot(snapshot) {
    const root = this.contentEl;
    const scrollTop = root.scrollTop;
    root.empty();
    this.backgroundStatus = null;
    this.renderedItems = new Set();
    root.addClass("knowledgeos-today-view");
    this.renderPageHeader(root, false, snapshot.generated_at);
    this.renderTodaySummary(root, snapshot);
    if (this.partialWarnings.length) this.renderPartialState(root);

    let actionableSections = 0;
    actionableSections += this.renderItems(root, "需要你处理", snapshot.focus, "focus");
    actionableSections += this.renderItems(root, "等待审核", snapshot.reviews, "reviews");
    actionableSections += this.renderItems(root, "即将到期", snapshot.due, "due");
    actionableSections += this.renderItems(root, "等待外部操作", snapshot.waiting_external, "external");
    actionableSections += this.renderInbox(root, snapshot.inbox);
    actionableSections += this.renderItems(root, "异常与失败", snapshot.failures, "failures");
    if (!actionableSections) this.renderTodayEmpty(root);
    this.renderRuns(root, snapshot.recent_completed);
    root.scrollTop = scrollTop;
  }

  renderTodaySummary(root, snapshot) {
    const summary = root.createDiv({ cls: "knowledgeos-today-summary", attr: { "aria-live": "polite" } });
    const counts = snapshot.counts || {};
    const parts = [];
    if (Number(counts.focus)) parts.push(`今日重点 ${counts.focus}`);
    if (Number(counts.reviews)) parts.push(`待审核 ${counts.reviews}`);
    if (Number(counts.inbox)) parts.push(`Inbox ${counts.inbox}`);
    if (Number(counts.failures)) parts.push(`异常 ${counts.failures}`);
    summary.setText(parts.length ? parts.join(" · ") : "当前没有需要处理的事项");
  }

  renderPartialState(root) {
    const labels = { reviews: "审核", inbox: "Inbox", due: "到期事项", waiting_external: "外部操作", failures: "异常", recent_completed: "最近完成", module_summaries: "模块摘要", counts: "计数", generated_at: "更新时间" };
    const state = markLiveRegion(root.createDiv({ cls: "knowledgeos-today-partial" }));
    state.createSpan({ text: `部分 Today 信息暂时不可用：${this.partialWarnings.map((key) => labels[key] || key).join("、")}。其他事项仍可查看。` });
    const retry = state.createEl("button", { text: "重试" });
    retry.onclick = () => this.refresh();
  }

  renderTodayEmpty(root) {
    const empty = root.createDiv({ cls: "knowledgeos-today-empty" });
    const icon = empty.createSpan({ cls: "knowledgeos-today-empty-icon", attr: { "aria-hidden": "true" } });
    setIcon(icon, "circle-check");
    empty.createEl("h3", { text: "今天没有需要你处理的事项" });
    empty.createDiv({ text: "新的审核、Inbox 内容、到期提醒或失败任务会显示在这里。" });
  }

  renderItems(root, title, items, sectionId) {
    const visible = (items || []).filter((item) => {
      const key = item.target ? `${item.source_module}:${item.target}:${item.category}` : `${item.source_module}:${item.item_id}`;
      if (this.renderedItems.has(key)) return false;
      this.renderedItems.add(key);
      return true;
    });
    if (!visible.length) return 0;
    const section = root.createEl("section", { cls: `knowledgeos-today-section is-${sectionId}`, attr: { "aria-label": title } });
    section.createEl("h3", { text: title });
    const list = section.createDiv({ cls: "knowledgeos-today-list" });
    for (const item of visible) {
      const card = list.createEl("article", { cls: `knowledgeos-today-item priority-${item.priority} category-${item.category}` });
      const titleRow = card.createDiv({ cls: "knowledgeos-today-item-heading" });
      const button = titleRow.createEl("button", { cls: "knowledgeos-link knowledgeos-today-item-title", text: friendlyDashboardTitle(item.title) });
      button.onclick = () => item.category === "review"
        ? this.plugin.activateReviews(item.item_id.replace("DSH-REVIEW-", ""))
        : item.item_id.startsWith("DSH-TASK-")
          ? this.plugin.activateSystem(null, item.item_id.replace("DSH-TASK-", ""))
        : item.target && this.app.workspace.openLinkText(item.target, "", false);
      if (item.priority === "critical" || item.priority === "high") titleRow.createSpan({ cls: `knowledgeos-today-priority is-${item.priority}`, text: item.priority === "critical" ? "紧急" : "高优先级" });
      addCardArrow(titleRow);
      const description = friendlyDashboardDescription(item.description, item.source_module);
      if (description) card.createDiv({ cls: "knowledgeos-today-description", text: description });
      const scheduleAlreadyDescribed = description.includes("下次核验") || description.includes("核验已逾期");
      if ((item.due_at || item.scheduled_for) && !scheduleAlreadyDescribed) createTime(card.createDiv({ cls: "knowledgeos-today-item-time" }), item.due_at || item.scheduled_for);
      renderDeveloperDetails(card, this.plugin, [["Dashboard ID", item.item_id], ["来源模块", item.source_module], ["目标", item.target], ["原始说明", item.description]]);
    }
    return visible.length;
  }

  renderInbox(root, groups) {
    if (!groups?.length) return 0;
    const section = root.createEl("section", { cls: "knowledgeos-today-section is-inbox", attr: { "aria-label": "待整理 Inbox" } });
    section.createEl("h3", { text: "待整理 Inbox" });
    const list = section.createDiv({ cls: "knowledgeos-today-inbox-list" });
    for (const group of groups) {
      const button = list.createEl("button", { cls: "knowledgeos-today-inbox-row" });
      const text = button.createSpan({ cls: "knowledgeos-today-inbox-text" });
      text.createSpan({ cls: "knowledgeos-today-inbox-title", text: group.label });
      const facts = [`${group.count} 项待整理`];
      if (group.unroutable_count) facts.push(`${group.unroutable_count} 项需要选择归属`);
      if (group.failed_count) facts.push(`${group.failed_count} 项失败`);
      text.createSpan({ cls: "knowledgeos-today-inbox-meta", text: facts.join(" · ") });
      const arrow = button.createSpan({ cls: "knowledgeos-card-arrow", attr: { "aria-hidden": "true" } });
      setIcon(arrow, "chevron-right");
      button.onclick = () => this.plugin.activateInbox();
    }
    return groups.length;
  }

  renderRuns(root, runs) {
    if (!runs?.length) return;
    const details = root.createEl("details", { cls: "knowledgeos-today-recent-runs" });
    details.createEl("summary", { text: "最近完成" });
    const list = details.createDiv({ cls: "knowledgeos-today-run-list" });
    for (const run of runs.slice(0, this.plugin.settings.developerMode ? 5 : 3)) {
      const card = list.createEl("article", { cls: "knowledgeos-today-run-item" });
      const button = card.createEl("button", { cls: "knowledgeos-link", text: friendlyAction(run.source_action || run.job_id || "系统任务", run.source_module) });
      button.onclick = () => this.plugin.activateSystem(run.run_id);
      const meta = card.createDiv({ cls: "knowledgeos-today-run-meta" });
      meta.createSpan({ text: labelModule(run.source_module) });
      createTime(meta, run.completed_at, " · ");
      renderDeveloperDetails(card, this.plugin, [["Run ID", run.run_id], ["来源模块", run.source_module], ["完成时间", run.completed_at]]);
    }
  }
}


  return { TodayView };
}
module.exports = { createTodayViews };
