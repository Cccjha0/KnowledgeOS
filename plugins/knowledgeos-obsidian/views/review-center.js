const { LatestRequestGate } = require("../services/latest-request");

function createReviewCenterViews(deps) {
  const { ItemView, Modal, Notice, PluginSettingTab, Setting, setIcon, VIEW_TYPE, REVIEW_VIEW_TYPE, INBOX_VIEW_TYPE, SYSTEM_VIEW_TYPE, settingsDefaults, moduleUiMetadata, manifestFormatters, LIST_PAGE_SIZE, FALLBACK_CODEX_MODELS, REASONING_LABELS, markLiveRegion, taskCycleChanged, shouldAutoRefreshPath, missingBuiltCliFailure, labelStatus, labelModule, labelJob, labelField, friendlyAction, calendarDayDifference, formatTime, formatVerificationSchedule, createTime, friendlyDashboardDescription, friendlyDashboardTitle, createToolbarButton, renderLoadingSkeleton, addCardArrow, renderDeveloperDetails, renderRecoverableError, displayJson } = deps;
class ReviewActionModal extends Modal {
  constructor(app, plugin, review, decision, onComplete) {
    super(app);
    this.plugin = plugin;
    this.review = review;
    this.decision = decision;
    this.onComplete = onComplete;
  }

  onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("knowledgeos-review-modal");
    const labels = {
      approve: "接受建议",
      "approve-with-modification": "修改后接受",
      reject: "拒绝建议",
      defer: "延后审核",
    };
    root.createEl("h2", { text: labels[this.decision] });
    root.createEl("p", { text: this.review.title });
    if (this.decision === "approve-with-modification") {
      const valueLabel = root.createEl("label", { text: "最终值（JSON）" });
      this.valueInput = valueLabel.createEl("textarea");
      this.valueInput.value = JSON.stringify(this.review.suggested_value, null, 2);
      this.valueInput.rows = 5;
    }
    if (this.decision === "defer") {
      const dateLabel = root.createEl("label", { text: "提醒时间" });
      this.dateInput = dateLabel.createEl("input", { type: "datetime-local" });
      const tomorrow = new Date(Date.now() + 86_400_000);
      this.dateInput.value = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
      const presets = root.createDiv({ cls: "knowledgeos-review-presets" });
      for (const [label, days] of [["明天", 1], ["三天后", 3], ["一周后", 7]]) {
        const button = presets.createEl("button", { text: label });
        button.onclick = () => {
          const date = new Date(Date.now() + days * 86_400_000);
          this.dateInput.value = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
        };
      }
    }
    const commentLabel = root.createEl("label", { text: this.decision === "reject" ? "拒绝原因" : "备注（可选）" });
    this.commentInput = commentLabel.createEl("textarea", { placeholder: "记录判断依据…" });
    this.commentInput.rows = 3;
    this.statusEl = root.createDiv({ cls: "knowledgeos-capture-status" });
    const actions = root.createDiv({ cls: "knowledgeos-capture-actions" });
    this.submitButton = actions.createEl("button", { cls: "mod-cta", text: "确认" });
    this.submitButton.onclick = () => this.submit();
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.onclick = () => this.close();
  }

  async submit() {
    if (this.decision === "reject" && !this.commentInput.value.trim()) {
      this.statusEl.setText("请填写拒绝原因。");
      return;
    }
    const params = {
      mode: "decide",
      review_id: this.review.review_id,
      decision: this.decision,
      user_comment: this.commentInput.value,
    };
    if (this.decision === "approve-with-modification") {
      try { params.modified_value = JSON.parse(this.valueInput.value); }
      catch { this.statusEl.setText("最终值不是有效 JSON。"); return; }
    }
    if (this.decision === "defer") {
      if (!this.dateInput.value) { this.statusEl.setText("请选择提醒时间。"); return; }
      params.review_after = new Date(this.dateInput.value).toISOString();
    }
    this.submitButton.disabled = true;
    this.statusEl.setText("审核决定已提交，将在列表中继续处理…");
    this.close();
    await this.onComplete(params);
  }
}

class ReviewDiscussionModal extends Modal {
  constructor(app, plugin, review, onComplete) {
    super(app);
    this.plugin = plugin;
    this.review = review;
    this.onComplete = onComplete;
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("knowledgeos-review-modal");
    root.createEl("h2", { text: "与 Codex 讨论" });
    this.statusEl = root.createDiv({ cls: "knowledgeos-state", text: "正在构建最小上下文…" });
    const response = await this.plugin.client.invoke("resolveReview", {
      mode: "prepare-discussion",
      review_id: this.review.review_id,
    });
    if (!response.ok) { this.statusEl.setText(response.error?.message || "无法构建讨论上下文。"); return; }
    this.context = response.data;
    this.statusEl.setText("上下文已准备；Core 正在等待讨论结论，不会执行文件修改。");
    const summary = root.createDiv({ cls: "knowledgeos-review-context" });
    summary.createEl("strong", { text: this.review.title });
    summary.createEl("div", { text: `当前值：${displayJson(this.review.current_value)}` });
    summary.createEl("div", { text: `建议值：${displayJson(this.review.suggested_value)}` });
    summary.createEl("div", { text: `依据：${this.review.evidence.join("、") || "无"}` });
    const copy = root.createEl("button", { text: "复制最小上下文给 Codex" });
    copy.onclick = async () => {
      await navigator.clipboard.writeText(JSON.stringify(this.context, null, 2));
      this.plugin.notify("讨论上下文已复制；请粘贴到 Codex。结论必须回到此窗口提交。");
    };

    const outcomeLabel = root.createEl("label", { text: "Codex 讨论结论" });
    this.outcomeSelect = outcomeLabel.createEl("select");
    for (const [value, label] of [
      ["approve", "接受"],
      ["approve-with-modification", "修改后接受"],
      ["reject", "拒绝"],
      ["continue-waiting", "继续等待"],
      ["needs-more-information", "需要更多信息"],
    ]) this.outcomeSelect.createEl("option", { value, text: label });
    this.outcomeSelect.onchange = () => this.updateModifiedValue();

    this.modifiedLabel = root.createEl("label", { text: "最终值（JSON）" });
    this.modifiedInput = this.modifiedLabel.createEl("textarea");
    this.modifiedInput.value = JSON.stringify(this.review.suggested_value, null, 2);
    this.modifiedInput.rows = 4;
    const commentLabel = root.createEl("label", { text: "结构化结论与理由" });
    this.commentInput = commentLabel.createEl("textarea", { placeholder: "粘贴或整理 Codex 的结论依据…" });
    this.commentInput.rows = 4;
    this.errorEl = root.createDiv({ cls: "knowledgeos-capture-status" });
    const actions = root.createDiv({ cls: "knowledgeos-capture-actions" });
    this.submitButton = actions.createEl("button", { cls: "mod-cta", text: "提交结构化结论" });
    this.submitButton.onclick = () => this.submit();
    const close = actions.createEl("button", { text: "稍后处理" });
    close.onclick = () => this.close();
    this.updateModifiedValue();
  }

  updateModifiedValue() {
    this.modifiedLabel.style.display = this.outcomeSelect.value === "approve-with-modification" ? "flex" : "none";
  }

  async submit() {
    if (!this.commentInput.value.trim()) { this.errorEl.setText("请填写讨论结论与理由。"); return; }
    const discussionResult = {
      outcome: this.outcomeSelect.value,
      user_comment: this.commentInput.value,
    };
    if (discussionResult.outcome === "approve-with-modification") {
      try { discussionResult.modified_value = JSON.parse(this.modifiedInput.value); }
      catch { this.errorEl.setText("最终值不是有效 JSON。"); return; }
    }
    this.submitButton.disabled = true;
    this.errorEl.setText("正在验证上下文并执行结论…");
    const response = await this.plugin.client.invoke("resolveReview", {
      mode: "apply-discussion-result",
      review_id: this.review.review_id,
      context_token: this.context.context_token,
      discussion_result: discussionResult,
    });
    this.submitButton.disabled = false;
    if (!response.ok) { this.errorEl.setText(response.error?.message || "讨论结论提交失败。"); return; }
    this.plugin.notify(`讨论结论已回写：${response.data.status}`);
    this.close();
    await this.onComplete();
  }
}

class ReviewCenterView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.visibleLimit = LIST_PAGE_SIZE;
    this.reviews = null;
    this.loadPromise = null;
    this.loadQueued = false;
    this.pendingReviewId = null;
    this.backgroundStatus = null;
    this.lastSuccessfulAt = null;
    this.modules = [];
    this.instances = [];
    this.filterWarnings = [];
    this.actionPendingReviewId = null;
    this.pendingReviewActions = new Map();
    this.reviewActionErrors = new Map();
    this.activeReviewId = null;
    this.loadGate = new LatestRequestGate();
  }
  getViewType() { return REVIEW_VIEW_TYPE; }
  getDisplayText() { return "KnowledgeOS Reviews"; }
  getIcon() { return "clipboard-check"; }
  async onOpen() { await this.renderShell(); }

  async renderShell(selectedReviewId = null) {
    if (this.listEl?.isConnected) return this.loadReviews(selectedReviewId);
    const root = this.contentEl;
    root.empty();
    root.addClass("knowledgeos-review-center");
    const header = root.createDiv({ cls: "knowledgeos-page-header knowledgeos-review-header" });
    const heading = header.createDiv({ cls: "knowledgeos-review-heading" });
    heading.createEl("h2", { text: "审核中心" });
    heading.createDiv({ cls: "knowledgeos-page-subtitle", text: "检查重要变更，并决定是否应用" });
    const headerActions = header.createDiv({ cls: "knowledgeos-header-actions" });
    const refresh = createToolbarButton(headerActions, "refresh-cw", "刷新审核事项", { iconOnly: true });
    refresh.onclick = () => this.loadReviews();
    this.summaryEl = root.createDiv({ cls: "knowledgeos-review-summary", attr: { "aria-live": "polite" } });

    const filters = root.createEl("section", { cls: "knowledgeos-review-filters", attr: { "aria-label": "审核筛选" } });
    const primaryFilters = filters.createDiv({ cls: "knowledgeos-review-primary-filters" });
    const statusLabel = primaryFilters.createEl("label", { text: "状态" });
    this.statusFilter = statusLabel.createEl("select");
    for (const [value, label] of [["active", "待处理"], ["pending", "待决定"], ["error", "处理失败"], ["deferred", "已延后"], ["all", "全部状态"]]) {
      this.statusFilter.createEl("option", { value, text: label });
    }
    const priorityLabel = primaryFilters.createEl("label", { text: "优先级" });
    this.priorityFilter = priorityLabel.createEl("select");
    for (const [value, label] of [["", "全部优先级"], ["critical", "紧急"], ["high", "高"], ["medium", "中"], ["low", "低"]]) {
      this.priorityFilter.createEl("option", { value, text: label });
    }

    this.moreFilters = filters.createEl("details", { cls: "knowledgeos-review-more-filters" });
    this.moreFilters.createEl("summary", { text: "更多筛选" });
    const advancedFilters = this.moreFilters.createDiv({ cls: "knowledgeos-review-advanced-filters" });
    const moduleLabel = advancedFilters.createEl("label", { text: "模块" });
    this.moduleFilter = moduleLabel.createEl("select");
    this.moduleFilter.createEl("option", { value: "", text: "全部模块" });
    this.moduleFilter.disabled = true;
    const instanceLabel = advancedFilters.createEl("label", { text: "实例" });
    this.instanceFilter = instanceLabel.createEl("select");
    this.instanceFilter.createEl("option", { value: "", text: "全部实例" });
    this.instanceFilter.disabled = true;
    const actionLabel = advancedFilters.createEl("label", { text: "操作类型" });
    this.actionFilter = actionLabel.createEl("select");
    this.actionFilter.createEl("option", { value: "", text: "全部操作" });
    this.knownActions = new Set();
    const createdLabel = advancedFilters.createEl("label", { text: "创建日期" });
    this.createdFilter = createdLabel.createEl("input", { type: "date" });
    const deferredLabel = advancedFilters.createEl("label", { text: "延后日期" });
    this.deferredFilter = deferredLabel.createEl("input", { type: "date" });
    const filterActions = advancedFilters.createDiv({ cls: "knowledgeos-review-filter-actions" });
    const clearFilters = filterActions.createEl("button", { text: "清除筛选" });
    clearFilters.onclick = () => this.clearFilters();
    for (const select of [this.statusFilter, this.priorityFilter, this.moduleFilter, this.instanceFilter, this.actionFilter]) {
      select.onchange = () => this.loadReviews();
    }
    this.createdFilter.onchange = () => this.loadReviews();
    this.deferredFilter.onchange = () => this.loadReviews();
    this.filterStatusEl = root.createDiv({ cls: "knowledgeos-review-partial", attr: { "aria-live": "polite" } });
    this.listEl = root.createDiv({ cls: "knowledgeos-review-list" });
    await Promise.all([this.loadFilterOptions(), this.loadReviews(selectedReviewId)]);
  }

  async loadFilterOptions() {
    this.filterWarnings = [];
    const [modules, instances] = await Promise.all([
      this.plugin.client.invoke("getModules", {}),
      this.plugin.client.invoke("getInstances", {}),
    ]);
    if (modules.ok && Array.isArray(modules.data)) {
      this.modules = modules.data;
      const selected = this.moduleFilter.value;
      this.moduleFilter.empty();
      this.moduleFilter.createEl("option", { value: "", text: "全部模块" });
      for (const module of this.modules) this.moduleFilter.createEl("option", { value: module.id, text: module.name });
      this.moduleFilter.value = selected;
      this.moduleFilter.disabled = false;
    } else {
      this.filterWarnings.push("模块筛选暂时不可用");
    }
    if (instances.ok && Array.isArray(instances.data)) {
      this.instances = instances.data;
      const selected = this.instanceFilter.value;
      this.instanceFilter.empty();
      this.instanceFilter.createEl("option", { value: "", text: "全部实例" });
      for (const instance of this.instances) this.instanceFilter.createEl("option", { value: instance.instance_id, text: instance.display_name });
      this.instanceFilter.value = selected;
      this.instanceFilter.disabled = false;
    } else {
      this.filterWarnings.push("实例筛选暂时不可用");
    }
    this.renderFilterStatus();
  }

  renderFilterStatus() {
    this.filterStatusEl.empty();
    if (!this.filterWarnings.length) return;
    this.moreFilters.open = true;
    this.filterStatusEl.createSpan({ text: `部分筛选信息暂时不可用：${this.filterWarnings.join("；")}。审核列表仍可正常使用。` });
    const retry = this.filterStatusEl.createEl("button", { text: "重试" });
    retry.onclick = () => this.loadFilterOptions();
  }

  clearFilters() {
    this.statusFilter.value = "active";
    this.priorityFilter.value = "";
    this.moduleFilter.value = "";
    this.instanceFilter.value = "";
    this.actionFilter.value = "";
    this.createdFilter.value = "";
    this.deferredFilter.value = "";
    this.moreFilters.open = false;
    this.loadReviews();
  }

  async loadReviews(selectedReviewId = null) {
    this.loadGate.request();
    if (selectedReviewId) {
      this.pendingReviewId = selectedReviewId;
      this.activeReviewId = selectedReviewId;
    }
    if (this.loadPromise) {
      this.loadQueued = true;
      return this.loadPromise;
    }
    this.loadPromise = (async () => {
      do {
        this.loadQueued = false;
        const nextReviewId = this.pendingReviewId;
        this.pendingReviewId = null;
        await this.performReviewLoad(nextReviewId, this.loadGate.current());
      } while (this.loadQueued);
    })();
    try { await this.loadPromise; }
    finally { this.loadPromise = null; }
  }

  async performReviewLoad(selectedReviewId = null, generation = this.loadGate.current()) {
    const preserveContent = Array.isArray(this.reviews) && this.listEl.childElementCount > 0;
    this.listEl.setAttr("aria-busy", "true");
    if (preserveContent) this.renderReviewBackgroundStatus("更新中…");
    else renderLoadingSkeleton(this.listEl, "正在加载审核事项…");
    const params = {};
    const status = this.statusFilter.value;
    if (status !== "active") params.statuses = status === "all"
      ? ["pending", "approved", "approved-with-modification", "rejected", "deferred", "resolved-by-user-edit", "error"]
      : [status];
    if (this.priorityFilter.value) params.priority = this.priorityFilter.value;
    if (this.moduleFilter.value) params.module_id = this.moduleFilter.value;
    if (this.instanceFilter.value) params.instance_id = this.instanceFilter.value;
    if (this.actionFilter.value) params.action = this.actionFilter.value;
    if (this.createdFilter.value) {
      params.created_from = new Date(`${this.createdFilter.value}T00:00:00`).toISOString();
      params.created_to = new Date(`${this.createdFilter.value}T23:59:59.999`).toISOString();
    }
    if (this.deferredFilter.value) {
      params.review_after_from = new Date(`${this.deferredFilter.value}T00:00:00`).toISOString();
      params.review_after_to = new Date(`${this.deferredFilter.value}T23:59:59.999`).toISOString();
    }
    const response = await this.plugin.client.invoke("listReviewItems", params);
    if (!this.loadGate.isCurrent(generation)) return;
    this.listEl.removeAttribute("aria-busy");
    if (!response.ok) {
      const reason = response.error?.message ? `：${response.error.message}` : "";
      if (preserveContent) this.renderReviewBackgroundStatus(`显示的是上次成功加载的内容${this.lastSuccessfulAt ? ` · ${formatTime(this.lastSuccessfulAt)}` : ""}${reason}`, true, true);
      else renderRecoverableError(this.listEl, "Review Center 暂时不可用", response.error, () => this.loadReviews());
      return;
    }
    this.listEl.empty();
    this.backgroundStatus = null;
    this.reviews = response.data;
    this.lastSuccessfulAt = new Date().toISOString();
    this.updateReviewSummary();
    let actionOptionsChanged = false;
    for (const review of this.reviews) {
      if (!this.knownActions.has(review.action)) { this.knownActions.add(review.action); actionOptionsChanged = true; }
    }
    if (actionOptionsChanged) {
      const selectedAction = this.actionFilter.value;
      this.actionFilter.empty();
      this.actionFilter.createEl("option", { value: "", text: "全部操作" });
      for (const action of [...this.knownActions].sort()) this.actionFilter.createEl("option", { value: action, text: this.actionLabel(action) });
      this.actionFilter.value = selectedAction;
    }
    if (!this.reviews.length) { this.renderReviewEmpty(); return; }
    if (this.activeReviewId) {
      const selected = this.reviews.find((review) => review.review_id === this.activeReviewId);
      if (selected) { this.renderDetail(selected); return; }
    }
    this.renderReviewList();
  }

  renderReviewBackgroundStatus(text, failed = false, retry = false, reason = "") {
    this.backgroundStatus?.remove();
    const status = markLiveRegion(this.listEl.createDiv({ cls: `knowledgeos-review-refresh-state${failed ? " is-error is-stale" : ""}` }));
    const message = status.createSpan({ text });
    if (reason) message.setAttr("title", reason);
    if (retry) {
      const button = status.createEl("button", { text: "重试" });
      button.onclick = () => this.loadReviews();
    }
    this.listEl.prepend(status);
    this.backgroundStatus = status;
  }

  updateReviewSummary() {
    const critical = this.reviews.filter((review) => review.priority === "critical" || review.priority === "high").length;
    const failed = this.reviews.filter((review) => review.status === "error").length;
    const parts = [`当前结果 ${this.reviews.length} 项`];
    if (critical) parts.push(`${critical} 项高优先级`);
    if (failed) parts.push(`${failed} 项处理失败`);
    this.summaryEl.setText(parts.join(" · "));
  }

  hasActiveFilters() {
    return this.statusFilter.value !== "active" || this.priorityFilter.value || this.moduleFilter.value || this.instanceFilter.value || this.actionFilter.value || this.createdFilter.value || this.deferredFilter.value;
  }

  renderReviewEmpty() {
    this.activeReviewId = null;
    this.contentEl.removeClass("is-review-detail");
    const empty = this.listEl.createDiv({ cls: "knowledgeos-review-empty" });
    const icon = empty.createSpan({ cls: "knowledgeos-review-empty-icon", attr: { "aria-hidden": "true" } });
    setIcon(icon, this.hasActiveFilters() ? "search-x" : "circle-check");
    empty.createEl("h3", { text: this.hasActiveFilters() ? "没有符合筛选条件的审核事项" : "当前没有需要处理的审核事项" });
    empty.createDiv({ text: this.hasActiveFilters() ? "调整或清除筛选后再查看。" : "新的重要变更需要确认时，会显示在这里。" });
    if (this.hasActiveFilters()) {
      const clear = empty.createEl("button", { text: "清除筛选" });
      clear.onclick = () => this.clearFilters();
    }
  }

  renderReviewList() {
    this.activeReviewId = null;
    this.contentEl.removeClass("is-review-detail");
    this.listEl.empty();
    const section = this.listEl.createEl("section", { cls: "knowledgeos-review-results", attr: { "aria-label": "审核事项" } });
    for (const review of this.reviews.slice(0, this.visibleLimit)) {
      const card = section.createEl("article", { cls: `knowledgeos-review-item priority-${review.priority} status-${review.status}` });
      const pendingDecision = this.pendingReviewActions.get(review.review_id);
      const actionError = this.reviewActionErrors.get(review.review_id);
      if (pendingDecision) card.addClass("is-applying");
      const heading = card.createDiv({ cls: "knowledgeos-review-item-heading" });
      const title = heading.createEl("button", { cls: "knowledgeos-link knowledgeos-review-item-title", text: review.title });
      title.disabled = Boolean(pendingDecision);
      title.onclick = () => this.renderDetail(review);
      const state = heading.createDiv({ cls: "knowledgeos-review-item-state" });
      state.createSpan({ cls: `knowledgeos-review-priority is-${review.priority}`, text: this.priorityLabel(review.priority) });
      state.createSpan({ text: pendingDecision ? "正在应用" : this.reviewStatusLabel(review.status) });
      const subject = review.field ? `${labelField(review.field, review.source_module)} · ${this.actionLabel(review.action)}` : this.actionLabel(review.action);
      card.createDiv({ cls: "knowledgeos-review-subject", text: subject });
      const context = card.createDiv({ cls: "knowledgeos-review-item-context" });
      context.createSpan({ text: this.moduleName(review.source_module) });
      if (review.instance_id) context.createSpan({ text: this.instanceName(review.instance_id) });
      createTime(context, review.created_at, "创建于 ");
      if (pendingDecision) card.createDiv({ cls: "knowledgeos-review-row-progress", text: "Core 正在创建快照并应用决定；你可以继续查看其他审核。" });
      else if (actionError) card.createDiv({ cls: "knowledgeos-review-row-warning is-error", text: actionError });
      else if (review.target_state === "changed") card.createDiv({ cls: "knowledgeos-review-row-warning", text: "目标文件已修改，需要重新确认。" });
      else if (review.target_state === "unavailable") card.createDiv({ cls: "knowledgeos-review-row-warning is-error", text: "当前无法读取目标字段。" });
      addCardArrow(heading);
    }
    if (this.reviews.length > this.visibleLimit) {
      const more = this.listEl.createEl("button", { cls: "knowledgeos-review-load-more", text: `加载更多（剩余 ${this.reviews.length - this.visibleLimit}）` });
      more.onclick = () => { this.visibleLimit += LIST_PAGE_SIZE; this.renderReviewList(); };
    }
  }

  showCachedReviewList() {
    this.activeReviewId = null;
    this.contentEl.removeClass("is-review-detail");
    this.listEl.removeAttribute("aria-busy");
    this.backgroundStatus = null;
    this.updateReviewSummary();
    if (!this.reviews?.length) {
      this.listEl.empty();
      this.renderReviewEmpty();
      return;
    }
    this.renderReviewList();
  }

  priorityLabel(priority) {
    return ({ critical: "紧急", high: "高", medium: "中", low: "低" })[priority] || priority;
  }

  reviewStatusLabel(status) {
    return ({ pending: "待处理", error: "处理失败", deferred: "已延后", approved: "已接受", "approved-with-modification": "修改后接受", rejected: "已拒绝", "resolved-by-user-edit": "已由用户处理" })[status] || labelStatus(status);
  }

  actionLabel(action) {
    return ({ update: "更新信息", "update-field": "更新字段", "apply-application-update": "应用申请信息变更", reconcile: "重新比较" })[action] || String(action || "审核变更").replaceAll("-", " ");
  }

  moduleName(moduleId) {
    return this.modules.find((module) => module.id === moduleId)?.name || labelModule(moduleId);
  }

  instanceName(instanceId) {
    return this.instances.find((instance) => instance.instance_id === instanceId)?.display_name || instanceId;
  }

  section(root, title, value) {
    const section = root.createEl("section", { cls: "knowledgeos-review-section" });
    section.createEl("h3", { text: title });
    this.renderReviewValue(section, value);
    return section;
  }

  renderReviewValue(root, value) {
    if (value === null || value === undefined || value === "") {
      root.createDiv({ cls: "knowledgeos-review-value is-empty", text: "未提供" });
      return;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      root.createDiv({ cls: "knowledgeos-review-value", text: String(value) });
      return;
    }
    root.createEl("pre", { cls: "knowledgeos-review-value is-structured", text: displayJson(value) });
  }

  renderTargetState(root, review) {
    if (review.target_state === "changed") {
      const warning = root.createDiv({ cls: "knowledgeos-review-alert is-warning" });
      warning.createEl("strong", { text: "目标文件已发生变化" });
      warning.createDiv({ text: "请重新比较、确认直接编辑已经解决，或保留这项审核。" });
      const actions = warning.createDiv({ cls: "knowledgeos-review-alert-actions" });
      const compare = actions.createEl("button", { text: "重新比较" });
      compare.onclick = () => this.simpleAction(review, "reconcile");
      const resolved = actions.createEl("button", { text: "视为已解决" });
      resolved.onclick = () => this.simpleAction(review, "mark-resolved-by-user-edit");
      const retain = actions.createEl("button", { text: "保留审核" });
      retain.onclick = () => this.loadReviews();
    } else if (review.target_state === "matches-suggestion") {
      const notice = root.createDiv({ cls: "knowledgeos-review-alert is-info" });
      notice.createEl("strong", { text: "目标字段已经与建议值一致" });
      const reconcile = notice.createEl("button", { text: "重新比较并关闭" });
      reconcile.onclick = () => this.simpleAction(review, "reconcile");
    } else if (review.target_state === "unavailable") {
      const warning = root.createDiv({ cls: "knowledgeos-review-alert is-error" });
      warning.createEl("strong", { text: "无法读取目标字段" });
      warning.createDiv({ text: review.target_error || "请检查目标文件后重试。" });
    }
  }

  renderDetail(review) {
    this.activeReviewId = review.review_id;
    this.contentEl.addClass("is-review-detail");
    const root = this.listEl;
    root.empty();
    const detail = root.createEl("article", { cls: `knowledgeos-review-detail priority-${review.priority} status-${review.status}` });
    const navigation = detail.createDiv({ cls: "knowledgeos-review-detail-navigation" });
    const back = navigation.createEl("button", { text: "← 返回审核列表" });
    back.onclick = () => this.showCachedReviewList();
    const open = navigation.createEl("button", { text: "打开目标文件" });
    open.onclick = () => this.app.workspace.openLinkText(review.target, "", false);
    detail.createEl("h2", { text: review.title });
    const summary = detail.createDiv({ cls: "knowledgeos-review-detail-summary" });
    summary.createSpan({ text: this.moduleName(review.source_module) });
    if (review.instance_id) summary.createSpan({ text: this.instanceName(review.instance_id) });
    summary.createSpan({ text: `${this.priorityLabel(review.priority)}优先级` });
    summary.createSpan({ text: this.reviewStatusLabel(review.status) });

    this.renderTargetState(detail, review);

    const comparison = detail.createEl("section", { cls: "knowledgeos-review-comparison", attr: { "aria-label": "当前值与建议值" } });
    const current = comparison.createDiv({ cls: "knowledgeos-review-comparison-column is-current" });
    current.createEl("h3", { text: "当前值" });
    this.renderReviewValue(current, review.current_value);
    const suggested = comparison.createDiv({ cls: "knowledgeos-review-comparison-column is-suggested" });
    suggested.createEl("h3", { text: "建议值" });
    this.renderReviewValue(suggested, review.suggested_value);

    const reason = this.section(detail, "为什么需要审核", review.why_uncertain);
    reason.addClass("knowledgeos-review-reason");
    const evidence = detail.createEl("section", { cls: "knowledgeos-review-section knowledgeos-review-evidence" });
    evidence.createEl("h3", { text: "证据" });
    if (review.evidence?.length) {
      const list = evidence.createEl("ul");
      for (const item of review.evidence) {
        const row = list.createEl("li");
        this.renderReviewValue(row, item);
      }
    } else {
      evidence.createDiv({ cls: "knowledgeos-review-value is-empty", text: "没有附带证据" });
    }
    const impact = detail.createEl("section", { cls: "knowledgeos-review-section knowledgeos-review-impact" });
    impact.createEl("h3", { text: "影响范围" });
    if (review.impact?.summary) impact.createDiv({ cls: "knowledgeos-review-value", text: String(review.impact.summary) });
    const impactFacts = impact.createDiv({ cls: "knowledgeos-review-impact-facts" });
    impactFacts.createSpan({ text: `${review.impact?.files?.length || 0} 个文件` });
    impactFacts.createSpan({ text: `${review.impact?.fields?.length || 0} 个字段` });
    impactFacts.createSpan({ text: `预计 ${review.impact?.estimated_operations ?? 0} 个操作` });

    this.actionStatusEl = markLiveRegion(detail.createDiv({ cls: "knowledgeos-review-action-status" }));
    if (!review.available_actions.length) {
      detail.createDiv({ cls: "knowledgeos-review-closed", text: "这项审核已经关闭，没有可执行操作。" });
    }
    const actions = detail.createDiv({ cls: "knowledgeos-review-actions" });
    if (review.available_actions.includes("approve")) this.actionButton(actions, "接受", review, "approve", true);
    if (review.available_actions.includes("approve-with-modification")) this.actionButton(actions, "修改后接受", review, "approve-with-modification");
    if (review.available_actions.includes("discuss")) {
      const discuss = actions.createEl("button", { text: "与 Codex 讨论" });
      discuss.onclick = () => new ReviewDiscussionModal(this.app, this.plugin, review, () => this.loadReviews(this.activeReviewId)).open();
    }
    if (review.available_actions.includes("defer")) this.actionButton(actions, "延后", review, "defer");
    if (review.available_actions.includes("reject")) this.actionButton(actions, "拒绝", review, "reject");
    if (review.available_actions.includes("retry")) {
      const retry = actions.createEl("button", { text: "重试" });
      retry.onclick = () => this.simpleAction(review, "retry");
    }
    if (review.decision_history?.length) {
      const history = detail.createEl("details", { cls: "knowledgeos-review-history" });
      history.createEl("summary", { text: `历史决定 · ${review.decision_history.length}` });
      this.renderReviewValue(history, review.decision_history);
    }
    renderDeveloperDetails(detail, this.plugin, [["Review ID", review.review_id], ["原始状态", review.status], ["原始操作", review.action], ["置信度", `${Math.round(review.confidence * 100)}%`], ["目标路径", review.target], ["Review 文件", review.vault_path]]);
  }

  actionButton(root, label, review, decision, primary = false) {
    const button = root.createEl("button", { text: label, cls: primary ? "mod-cta" : "" });
    button.onclick = () => new ReviewActionModal(this.app, this.plugin, review, decision, (params) => this.resolveDecision(review, params)).open();
  }

  async resolveDecision(review, params) {
    if (this.pendingReviewActions.has(review.review_id)) return;
    this.pendingReviewActions.set(review.review_id, params.decision);
    this.reviewActionErrors.delete(review.review_id);
    this.showCachedReviewList();
    this.plugin.notify("审核决定已提交，正在后台应用");
    const response = await this.plugin.client.invoke("resolveReview", params);
    this.pendingReviewActions.delete(review.review_id);
    if (!response.ok) {
      const message = response.error?.message || "审核处理失败";
      this.reviewActionErrors.set(review.review_id, message);
      if (!this.activeReviewId || this.activeReviewId === review.review_id) this.showCachedReviewList();
      this.plugin.notify(message, { error: true });
      return;
    }
    this.reviewActionErrors.delete(review.review_id);
    this.reviews = this.reviews.filter((item) => item.review_id !== review.review_id);
    if (!this.activeReviewId || this.activeReviewId === review.review_id) this.showCachedReviewList();
    else this.updateReviewSummary();
    this.plugin.notify(`审核已更新为 ${response.data.status}`);
    void this.loadReviews(this.activeReviewId);
  }

  async simpleAction(review, mode) {
    if (this.actionPendingReviewId === review.review_id) return;
    this.actionPendingReviewId = review.review_id;
    if (this.actionStatusEl?.isConnected) {
      this.actionStatusEl.removeClass("is-error");
      this.actionStatusEl.setText(mode === "retry" ? "正在重试审核…" : "正在更新审核状态…");
    }
    const controls = [...this.listEl.querySelectorAll(".knowledgeos-review-actions button, .knowledgeos-review-alert-actions button")];
    for (const control of controls) control.disabled = true;
    const response = await this.plugin.client.invoke("resolveReview", { mode, review_id: review.review_id });
    this.actionPendingReviewId = null;
    for (const control of controls) control.disabled = false;
    if (!response.ok) {
      const message = response.error?.message || "审核操作失败";
      if (this.actionStatusEl?.isConnected) {
        this.actionStatusEl.addClass("is-error");
        this.actionStatusEl.setText(message);
      }
      this.plugin.notify(message, { error: true });
      return;
    }
    this.plugin.notify("审核状态已更新");
    await this.loadReviews(this.activeReviewId);
  }
}


  return { ReviewCenterView };
}
module.exports = { createReviewCenterViews };
