const { ItemView, Modal, Notice, Plugin, PluginSettingTab, Setting } = require("obsidian");
const { execFile } = require("node:child_process");

const VIEW_TYPE = "knowledgeos-today";
const REVIEW_VIEW_TYPE = "knowledgeos-reviews";
const INBOX_VIEW_TYPE = "knowledgeos-inbox";
const SYSTEM_VIEW_TYPE = "knowledgeos-system";
const LIST_PAGE_SIZE = 50;
const DEFAULT_SETTINGS = {
  coreCliPath: "",
  nodePath: "node",
  vaultPath: "",
  openTodayOnStartup: true,
  autoRefresh: true,
  developerMode: false,
  notifyOnCompletion: true,
  allowBatchOperations: true,
};

function markLiveRegion(element, politeness = "polite") {
  element.setAttr("role", "status");
  element.setAttr("aria-live", politeness);
  element.setAttr("aria-atomic", "true");
  return element;
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

class CoreCommandClient {
  constructor(settings) {
    this.settings = settings;
  }

  invoke(method, params = {}, requestId = null) {
    if (!this.settings.coreCliPath || !this.settings.vaultPath) {
      return Promise.resolve({
        ok: false,
        state: "failed",
        error: {
          message: "尚未配置 Core CLI 与 Vault 路径。",
          impact: "Today 暂时无法刷新，已有 Markdown 数据不受影响。",
          recovery_actions: ["打开 KnowledgeOS 设置并填写路径"],
        },
      });
    }
    requestId = requestId || `PLUGIN-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const args = [
      this.settings.coreCliPath,
      "api",
      method,
      "--vault",
      this.settings.vaultPath,
      "--request-id",
      requestId,
      "--input",
      JSON.stringify(params),
    ];
    return new Promise((resolve) => {
      execFile(this.settings.nodePath || "node", args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve({
            ok: false,
            state: "failed",
            error: {
              message: error?.message || "Core 返回了无法解析的结果。",
              impact: "本次界面操作没有得到确认。",
              recovery_actions: ["检查 Core CLI 路径", "在设置页测试连接"],
            },
          });
        }
      });
    });
  }
}

class QuickCaptureModal extends Modal {
  constructor(app, plugin, contextPath = null) {
    super(app);
    this.plugin = plugin;
    this.contextPath = contextPath || app.workspace.getActiveFile()?.path || null;
    this.requestId = `CAPTURE-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("knowledgeos-capture");
    root.createEl("h2", { text: "Quick Capture" });
    this.modules = [];
    this.instances = [];
    this.contextTouched = false;
    this.preview = { destination_label: "正在识别当前上下文…", module_id: null, instance_id: null };
    this.renderForm();
    const [modulesResponse, instancesResponse, previewResponse] = await Promise.all([
      this.plugin.client.invoke("getModules", {}),
      this.plugin.client.invoke("getInstances", {}),
      this.plugin.client.invoke("createCapture", { preview_only: true, active_path: this.contextPath }, this.requestId),
    ]);
    if (!modulesResponse.ok || !instancesResponse.ok || !previewResponse.ok) {
      const error = modulesResponse.error || instancesResponse.error || previewResponse.error;
      this.destinationEl.setText("无法预览上下文；保存时将由 Core 再次判断。 ");
      this.statusEl.setText(error?.message || "无法加载 Capture 上下文。");
      return;
    }
    this.modules = modulesResponse.data.filter((module) => module.status === "enabled");
    this.instances = instancesResponse.data.filter((instance) => instance.status === "active");
    this.preview = previewResponse.data;
    this.destinationEl.setText(`默认保存到：${this.preview.destination_label}`);
    this.populateModuleOptions();
    if (this.contextTouched) {
      this.refreshInstanceOptions(this.instanceSelect.value);
    } else if (this.preview.instance_id) {
      this.moduleSelect.value = this.preview.module_id;
      this.refreshInstanceOptions(this.preview.instance_id);
    } else if (this.preview.module_id) {
      this.moduleSelect.value = this.preview.module_id;
      this.refreshInstanceOptions("__none__");
    } else {
      this.moduleSelect.value = "__global__";
      this.refreshInstanceOptions("__none__");
    }
  }

  renderForm() {
    const root = this.contentEl;
    this.destinationEl = root.createDiv({ cls: "knowledgeos-destination", text: `默认保存到：${this.preview.destination_label}` });

    const titleLabel = root.createEl("label", { text: "标题（可选）" });
    this.titleInput = titleLabel.createEl("input", { type: "text", placeholder: "留空时使用正文第一行" });

    const contentLabel = root.createEl("label", { text: "内容" });
    this.contentInput = contentLabel.createEl("textarea", { placeholder: "记录此刻的想法…" });
    this.contentInput.rows = 8;

    const row = root.createDiv({ cls: "knowledgeos-capture-row" });
    const moduleLabel = row.createEl("label", { text: "模块" });
    this.moduleSelect = moduleLabel.createEl("select");
    this.populateModuleOptions();

    const instanceLabel = row.createEl("label", { text: "实例" });
    this.instanceSelect = instanceLabel.createEl("select");
    this.refreshInstanceOptions();

    this.moduleSelect.onchange = () => { this.contextTouched = true; this.refreshInstanceOptions("__none__"); };
    this.instanceSelect.onchange = () => { this.contextTouched = true; };

    const typeLabel = row.createEl("label", { text: "类型（可选）" });
    this.typeSelect = typeLabel.createEl("select");
    for (const [value, label] of [["note", "笔记"], ["idea", "想法"], ["task", "任务"], ["log", "记录"], ["other", "其他"]]) {
      this.typeSelect.createEl("option", { value, text: label });
    }

    const attachmentLabel = root.createEl("label", { text: "附件（可选，Vault 相对路径，用逗号分隔）" });
    this.attachmentInput = attachmentLabel.createEl("input", { type: "text", placeholder: "Attachments/example.pdf" });

    this.statusEl = markLiveRegion(root.createDiv({ cls: "knowledgeos-capture-status" }), "assertive");
    const actions = root.createDiv({ cls: "knowledgeos-capture-actions" });
    this.saveButton = actions.createEl("button", { cls: "mod-cta", text: "保存" });
    this.saveButton.onclick = () => this.save();
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.onclick = () => this.close();
    this.contentInput.focus();
  }

  populateModuleOptions() {
    if (!this.moduleSelect) return;
    const selected = this.moduleSelect.value || "__auto__";
    this.moduleSelect.empty();
    this.moduleSelect.createEl("option", { value: "__auto__", text: "自动判断" });
    this.moduleSelect.createEl("option", { value: "__global__", text: "全局 Inbox" });
    for (const module of this.modules || []) this.moduleSelect.createEl("option", { value: module.id, text: module.name });
    this.moduleSelect.value = selected;
  }

  refreshInstanceOptions(selected = "__auto__") {
    if (!this.instanceSelect) return;
    const moduleId = this.moduleSelect?.value;
    this.instanceSelect.empty();
    this.instanceSelect.createEl("option", { value: "__auto__", text: "自动判断" });
    this.instanceSelect.createEl("option", { value: "__none__", text: "不指定实例" });
    for (const instance of this.instances || []) {
      if (moduleId && !moduleId.startsWith("__") && instance.module_id !== moduleId) continue;
      this.instanceSelect.createEl("option", { value: instance.instance_id, text: instance.display_name });
    }
    this.instanceSelect.value = selected;
  }

  captureParams() {
    const moduleValue = this.moduleSelect.value;
    const instanceValue = this.instanceSelect.value;
    const automatic = moduleValue === "__auto__" && instanceValue === "__auto__";
    const global = moduleValue === "__global__";
    return {
      content: this.contentInput.value,
      title: this.titleInput.value || null,
      module_id: global || moduleValue === "__auto__" ? null : moduleValue,
      instance_id: instanceValue.startsWith("__") ? null : instanceValue,
      content_type: this.typeSelect.value,
      attachments: this.attachmentInput.value.split(",").map((item) => item.trim()).filter(Boolean),
      active_path: automatic ? this.contextPath : null,
    };
  }

  async save() {
    if (!this.contentInput.value.trim()) {
      this.statusEl.setText("请输入内容。");
      this.contentInput.focus();
      return;
    }
    const params = this.captureParams();
    const fingerprint = JSON.stringify(params);
    if (this.lastSubmittedParams && this.lastSubmittedParams !== fingerprint) {
      this.requestId = `CAPTURE-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
    this.lastSubmittedParams = fingerprint;
    this.saveButton.disabled = true;
    this.statusEl.setText("正在保存；可以关闭窗口，Core 会继续处理…");
    const response = await this.plugin.client.invoke("createCapture", params, this.requestId);
    this.saveButton.disabled = false;
    if (!response.ok) {
      this.statusEl.empty();
      this.statusEl.createDiv({ text: response.error?.message || "保存失败，输入内容已保留。" });
      if (response.error?.impact) this.statusEl.createDiv({ cls: "knowledgeos-impact", text: response.error.impact });
      return;
    }
    this.renderSuccess(response.data);
  }

  renderSuccess(result) {
    const root = this.contentEl;
    root.empty();
    root.createEl("h2", { text: "已保存" });
    root.createEl("p", { text: `已保存到 ${result.destination_label}` });
    root.createEl("code", { text: result.path });
    const actions = root.createDiv({ cls: "knowledgeos-capture-actions" });
    const open = actions.createEl("button", { cls: "mod-cta", text: "打开文件" });
    open.onclick = async () => { await this.app.workspace.openLinkText(result.path, "", false); this.close(); };
    const again = actions.createEl("button", { text: "继续记录" });
    again.onclick = () => { this.close(); new QuickCaptureModal(this.app, this.plugin, this.contextPath).open(); };
    const done = actions.createEl("button", { text: "完成" });
    done.onclick = () => this.close();
    this.plugin.notify(`已保存到 ${result.destination_label}`);
  }
}

function displayJson(value) {
  if (value === null || value === undefined) return "—";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

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
    this.statusEl.setText("Core 正在执行审核决定…");
    const response = await this.plugin.client.invoke("resolveReview", params);
    this.submitButton.disabled = false;
    if (!response.ok) {
      this.statusEl.setText(response.error?.message || "审核处理失败。");
      return;
    }
    this.plugin.notify(`审核已更新为 ${response.data.status}`);
    this.close();
    await this.onComplete();
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
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.visibleLimit = LIST_PAGE_SIZE; }
  getViewType() { return REVIEW_VIEW_TYPE; }
  getDisplayText() { return "KnowledgeOS Reviews"; }
  getIcon() { return "clipboard-check"; }
  async onOpen() { await this.renderShell(); }

  async renderShell(selectedReviewId = null) {
    const root = this.contentEl;
    root.empty();
    const header = root.createDiv({ cls: "knowledgeos-header" });
    header.createEl("h2", { text: "Reviews" });
    const refresh = header.createEl("button", { text: "刷新" });
    refresh.onclick = () => this.loadReviews();
    const filters = root.createDiv({ cls: "knowledgeos-review-filters" });
    this.statusFilter = filters.createEl("select");
    for (const [value, label] of [["active", "待处理"], ["pending", "Pending"], ["error", "Error"], ["deferred", "Deferred"], ["all", "全部状态"]]) {
      this.statusFilter.createEl("option", { value, text: label });
    }
    this.priorityFilter = filters.createEl("select");
    for (const [value, label] of [["", "全部优先级"], ["critical", "Critical"], ["high", "High"], ["medium", "Medium"], ["low", "Low"]]) {
      this.priorityFilter.createEl("option", { value, text: label });
    }
    this.moduleFilter = filters.createEl("select");
    this.moduleFilter.createEl("option", { value: "", text: "全部模块" });
    const [modules, instances] = await Promise.all([
      this.plugin.client.invoke("getModules", {}),
      this.plugin.client.invoke("getInstances", {}),
    ]);
    if (modules.ok) for (const module of modules.data) this.moduleFilter.createEl("option", { value: module.id, text: module.name });
    this.instanceFilter = filters.createEl("select");
    this.instanceFilter.createEl("option", { value: "", text: "全部实例" });
    if (instances.ok) for (const instance of instances.data) this.instanceFilter.createEl("option", { value: instance.instance_id, text: instance.display_name });
    this.actionFilter = filters.createEl("select");
    this.actionFilter.createEl("option", { value: "", text: "全部操作" });
    this.knownActions = new Set();
    const createdLabel = filters.createEl("label", { text: "创建日期" });
    this.createdFilter = createdLabel.createEl("input", { type: "date" });
    const deferredLabel = filters.createEl("label", { text: "延后日期" });
    this.deferredFilter = deferredLabel.createEl("input", { type: "date" });
    for (const select of [this.statusFilter, this.priorityFilter, this.moduleFilter, this.instanceFilter, this.actionFilter]) {
      select.onchange = () => this.loadReviews();
    }
    this.createdFilter.onchange = () => this.loadReviews();
    this.deferredFilter.onchange = () => this.loadReviews();
    this.listEl = root.createDiv({ cls: "knowledgeos-review-list" });
    await this.loadReviews(selectedReviewId);
  }

  async loadReviews(selectedReviewId = null) {
    this.listEl.empty();
    markLiveRegion(this.listEl.createDiv({ cls: "knowledgeos-state", text: "正在加载审核事项…" }));
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
    this.listEl.empty();
    if (!response.ok) { renderRecoverableError(this.listEl, "Review Center 暂时不可用", response.error, () => this.loadReviews()); return; }
    this.reviews = response.data;
    let actionOptionsChanged = false;
    for (const review of this.reviews) {
      if (!this.knownActions.has(review.action)) { this.knownActions.add(review.action); actionOptionsChanged = true; }
    }
    if (actionOptionsChanged) {
      const selectedAction = this.actionFilter.value;
      this.actionFilter.empty();
      this.actionFilter.createEl("option", { value: "", text: "全部操作" });
      for (const action of [...this.knownActions].sort()) this.actionFilter.createEl("option", { value: action, text: action });
      this.actionFilter.value = selectedAction;
    }
    if (!this.reviews.length) { this.listEl.createDiv({ cls: "knowledgeos-empty", text: "当前没有符合条件的审核事项。" }); return; }
    if (selectedReviewId) {
      const selected = this.reviews.find((review) => review.review_id === selectedReviewId);
      if (selected) { this.renderDetail(selected); return; }
    }
    this.renderReviewList();
  }

  renderReviewList() {
    this.listEl.empty();
    for (const review of this.reviews.slice(0, this.visibleLimit)) {
      const card = this.listEl.createDiv({ cls: `knowledgeos-card priority-${review.priority}` });
      const title = card.createEl("button", { cls: "knowledgeos-link", text: review.title });
      title.onclick = () => this.renderDetail(review);
      card.createDiv({ cls: "knowledgeos-review-meta", text: `${review.source_module} · ${review.status} · 置信度 ${Math.round(review.confidence * 100)}%` });
      card.createDiv({ cls: "knowledgeos-description", text: `${review.target} · ${review.action}` });
    }
    if (this.reviews.length > this.visibleLimit) {
      const more = this.listEl.createEl("button", { text: `加载更多（剩余 ${this.reviews.length - this.visibleLimit}）` });
      more.onclick = () => { this.visibleLimit += LIST_PAGE_SIZE; this.renderReviewList(); };
    }
  }

  section(root, title, value) {
    const section = root.createDiv({ cls: "knowledgeos-review-section" });
    section.createEl("h3", { text: title });
    section.createEl("pre", { text: displayJson(value) });
  }

  renderDetail(review) {
    const root = this.listEl;
    root.empty();
    const back = root.createEl("button", { text: "← 返回审核列表" });
    back.onclick = () => this.loadReviews();
    root.createEl("h2", { text: review.title });
    root.createDiv({ cls: "knowledgeos-review-meta", text: `${review.review_id} · ${review.source_module} · ${review.priority}` });
    const open = root.createEl("button", { text: "打开目标文件" });
    open.onclick = () => this.app.workspace.openLinkText(review.target, "", false);
    if (review.target_state === "changed") {
      const warning = root.createDiv({ cls: "knowledgeos-review-warning" });
      warning.createEl("strong", { text: "目标文件已发生变化" });
      warning.createDiv({ text: "请重新比较、确认直接编辑已解决，或保留审核。" });
      const compare = warning.createEl("button", { text: "重新比较" });
      compare.onclick = () => this.simpleAction(review, "reconcile");
      const resolved = warning.createEl("button", { text: "视为已解决" });
      resolved.onclick = () => this.simpleAction(review, "mark-resolved-by-user-edit");
      const retain = warning.createEl("button", { text: "保留审核" });
      retain.onclick = () => this.loadReviews();
    } else if (review.target_state === "matches-suggestion") {
      const notice = root.createDiv({ cls: "knowledgeos-review-warning" });
      notice.createEl("strong", { text: "目标字段已经与建议值一致" });
      const reconcile = notice.createEl("button", { text: "重新比较并关闭" });
      reconcile.onclick = () => this.simpleAction(review, "reconcile");
    } else if (review.target_state === "unavailable") {
      const warning = root.createDiv({ cls: "knowledgeos-review-warning" });
      warning.createEl("strong", { text: "无法读取目标字段" });
      warning.createDiv({ text: review.target_error || "请检查目标文件后重试。" });
    }
    this.section(root, "当前值", review.current_value);
    this.section(root, "建议值", review.suggested_value);
    this.section(root, "判断依据", review.evidence);
    this.section(root, "不确定原因", review.why_uncertain);
    this.section(root, "影响范围", review.impact);
    if (review.decision_history?.length) this.section(root, "历史决定", review.decision_history);
    if (!review.available_actions.length) return;
    const actions = root.createDiv({ cls: "knowledgeos-review-actions" });
    if (review.available_actions.includes("approve")) this.actionButton(actions, "接受", review, "approve", true);
    if (review.available_actions.includes("approve-with-modification")) this.actionButton(actions, "修改后接受", review, "approve-with-modification");
    if (review.available_actions.includes("reject")) this.actionButton(actions, "拒绝", review, "reject");
    if (review.available_actions.includes("defer")) this.actionButton(actions, "延后", review, "defer");
    if (review.available_actions.includes("discuss")) {
      const discuss = actions.createEl("button", { text: "与 Codex 讨论" });
      discuss.onclick = () => new ReviewDiscussionModal(this.app, this.plugin, review, () => this.loadReviews()).open();
    }
    if (review.available_actions.includes("retry")) {
      const retry = actions.createEl("button", { text: "重试" });
      retry.onclick = () => this.simpleAction(review, "retry");
    }
  }

  actionButton(root, label, review, decision, primary = false) {
    const button = root.createEl("button", { text: label, cls: primary ? "mod-cta" : "" });
    button.onclick = () => new ReviewActionModal(this.app, this.plugin, review, decision, () => this.loadReviews()).open();
  }

  async simpleAction(review, mode) {
    const response = await this.plugin.client.invoke("resolveReview", { mode, review_id: review.review_id });
    if (!response.ok) { this.plugin.notify(response.error?.message || "审核操作失败", { error: true }); return; }
    this.plugin.notify("审核状态已更新");
    await this.loadReviews();
  }
}

class InboxCenterView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.selectedRoutes = new Map(); this.visibleLimit = LIST_PAGE_SIZE; }
  getViewType() { return INBOX_VIEW_TYPE; }
  getDisplayText() { return "KnowledgeOS Inbox"; }
  getIcon() { return "inbox"; }
  async onOpen() { await this.refresh(); }

  async refresh(selectedItemId = null) {
    const root = this.contentEl;
    root.empty();
    markLiveRegion(root.createDiv({ cls: "knowledgeos-state", text: "正在加载 Inbox…" }));
    const [inbox, modules, instances] = await Promise.all([
      this.plugin.client.invoke("listInboxItems", {}),
      this.plugin.client.invoke("getModules", {}),
      this.plugin.client.invoke("getInstances", {}),
    ]);
    if (!inbox.ok || !modules.ok || !instances.ok) {
      const error = inbox.error || modules.error || instances.error;
      renderRecoverableError(root, "Inbox Center 暂时不可用", error, () => this.refresh());
      return;
    }
    this.listing = inbox.data;
    this.modules = modules.data.filter((item) => item.status === "enabled");
    this.instances = instances.data.filter((item) => item.status === "active");
    this.render(selectedItemId);
  }

  render(selectedItemId = null) {
    const root = this.contentEl;
    root.empty();
    const header = root.createDiv({ cls: "knowledgeos-header" });
    header.createEl("h2", { text: "Inbox Center" });
    const refresh = header.createEl("button", { text: "刷新" });
    refresh.onclick = () => this.refresh(selectedItemId);
    const eligible = this.listing.items.filter((item) => item.confidence >= item.auto_route_threshold && !item.requires_ai);
    if (this.plugin.settings.allowBatchOperations) {
      const batch = header.createEl("button", { cls: "mod-cta", text: `处理高置信度项 (${eligible.length})` });
      batch.disabled = eligible.length === 0;
      batch.onclick = () => this.processBatch(eligible);
    }

    const counts = root.createDiv({ cls: "knowledgeos-counts" });
    for (const [label, value] of [["总计", this.listing.counts.total], ["待路由", this.listing.counts.needs_routing], ["等待 AI", this.listing.counts.waiting_for_ai], ["失败", this.listing.counts.failed]]) {
      counts.createSpan({ cls: "knowledgeos-count", text: `${label} ${value}` });
    }
    if (this.resultMessage) markLiveRegion(root.createDiv({ cls: "knowledgeos-state", text: this.resultMessage }));
    if (!this.listing.groups.length) {
      root.createDiv({ cls: "knowledgeos-empty", text: "所有受管 Inbox 都已处理完毕。" });
      return;
    }
    let rendered = 0;
    for (const group of this.listing.groups) {
      if (rendered >= this.visibleLimit) break;
      const visibleItems = group.items.slice(0, this.visibleLimit - rendered);
      if (!visibleItems.length) continue;
      const section = root.createDiv({ cls: "knowledgeos-inbox-group" });
      section.createEl("h3", { text: `${group.label} (${group.count})` });
      for (const item of visibleItems) this.renderItem(section, item, item.item_id === selectedItemId);
      rendered += visibleItems.length;
    }
    if (this.listing.items.length > rendered) {
      const more = root.createEl("button", { text: `加载更多（剩余 ${this.listing.items.length - rendered}）` });
      more.onclick = () => { this.visibleLimit += LIST_PAGE_SIZE; this.render(selectedItemId); };
    }
  }

  selectedRoute(item) {
    return this.selectedRoutes.get(item.item_id) || {
      module_id: item.suggested_module_id,
      instance_id: item.suggested_instance_id,
    };
  }

  renderItem(root, item, selected) {
    const card = root.createDiv({ cls: `knowledgeos-card knowledgeos-inbox-card state-${item.state}` });
    const title = card.createEl("button", { cls: "knowledgeos-link", text: item.title });
    title.onclick = () => this.app.workspace.openLinkText(item.path, "", false);
    card.createDiv({ cls: "knowledgeos-review-meta", text: `${item.path} · ${item.content_type} · ${item.size} bytes` });
    card.createDiv({ cls: "knowledgeos-review-meta", text: `状态：${item.state} · 置信度：${Math.round(item.confidence * 100)}% · 读取级别：${item.required_read_level}` });
    card.createDiv({ cls: "knowledgeos-description", text: item.reasons.join("；") || "尚无可靠路由依据" });
    if (item.error) card.createDiv({ cls: "knowledgeos-review-warning", text: item.error });
    if (item.requires_ai) card.createDiv({ cls: "knowledgeos-inbox-ai", text: "需要 Codex / 模块工作流继续处理；Core 不会伪装成已完成。" });

    const route = this.selectedRoute(item);
    const routeRow = card.createDiv({ cls: "knowledgeos-inbox-route" });
    const moduleSelect = routeRow.createEl("select");
    moduleSelect.createEl("option", { value: "", text: "选择模块…" });
    for (const module of this.modules) moduleSelect.createEl("option", { value: module.id, text: module.name });
    moduleSelect.value = route.module_id || "";
    const instanceSelect = routeRow.createEl("select");
    const populateInstances = () => {
      const previous = route.instance_id || "";
      instanceSelect.empty();
      instanceSelect.createEl("option", { value: "", text: "不指定实例" });
      for (const instance of this.instances.filter((candidate) => !moduleSelect.value || candidate.module_id === moduleSelect.value)) {
        instanceSelect.createEl("option", { value: instance.instance_id, text: instance.display_name });
      }
      instanceSelect.value = previous;
    };
    populateInstances();
    const saveRoute = () => this.selectedRoutes.set(item.item_id, { module_id: moduleSelect.value || null, instance_id: instanceSelect.value || null });
    moduleSelect.onchange = () => { this.selectedRoutes.set(item.item_id, { module_id: moduleSelect.value || null, instance_id: null }); populateInstances(); };
    instanceSelect.onchange = saveRoute;

    const actions = card.createDiv({ cls: "knowledgeos-review-actions" });
    const preview = actions.createEl("button", { text: "预览" });
    preview.onclick = () => this.previewItem(item);
    const process = actions.createEl("button", { cls: "mod-cta", text: item.state === "failed" ? "重试" : "处理" });
    process.onclick = () => this.processItem(item, item.state === "failed" ? "retry" : "process");
    const open = actions.createEl("button", { text: "打开" });
    open.onclick = () => this.app.workspace.openLinkText(item.path, "", false);
    const defer = actions.createEl("button", { text: "明天提醒" });
    defer.onclick = () => this.processItem(item, "defer", { review_after: new Date(Date.now() + 86_400_000).toISOString() });
    const ignore = actions.createEl("button", { text: "忽略" });
    ignore.onclick = () => this.processItem(item, "ignore");
    const unmanage = actions.createEl("button", { text: "移出系统管理" });
    unmanage.onclick = () => this.processItem(item, "unmanage");

    if (selected && this.previewData?.item_id === item.item_id) {
      const detail = card.createDiv({ cls: "knowledgeos-inbox-preview" });
      detail.createEl("strong", { text: "执行预览" });
      detail.createDiv({ text: `归属：${this.previewData.suggested_ownership.module_id || "未确定"}${this.previewData.suggested_ownership.instance_id ? ` / ${this.previewData.suggested_ownership.instance_id}` : ""}` });
      detail.createDiv({ text: `目标：${this.previewData.operation_summary.target || "等待用户或 AI 决定"}` });
      detail.createDiv({ text: `预计操作：${this.previewData.operation_summary.estimated_operations ?? "由模块计划决定"}` });
      detail.createDiv({ text: `风险：${this.previewData.risk} · ${this.previewData.requires_codex ? "需要 Codex" : "Core 可执行"}` });
    }
  }

  async previewItem(item) {
    const route = this.selectedRoute(item);
    const response = await this.plugin.client.invoke("processInboxItem", { item_id: item.item_id, action: "preview", ...route });
    if (!response.ok) { this.plugin.notify(response.error?.message || "无法生成预览", { error: true }); return; }
    this.previewData = response.data;
    this.render(item.item_id);
  }

  async processItem(item, action, extra = {}) {
    const route = this.selectedRoute(item);
    const response = await this.plugin.client.invoke("processInboxItem", { item_id: item.item_id, action, ...route, ...extra });
    if (!response.ok) { this.plugin.notify(response.error?.message || "Inbox 处理失败", { error: true }); return; }
    this.resultMessage = response.data.status === "waiting-for-ai" ? "条目已安全保留，等待 Codex / 模块工作流。" : `Inbox 状态已更新：${response.data.status}`;
    await this.refresh();
  }

  async processBatch(items) {
    const response = await this.plugin.client.invoke("processInboxBatch", { mode: "high-confidence", item_ids: items.map((item) => item.item_id) });
    if (!response.ok) { this.plugin.notify(response.error?.message || "批量处理失败", { error: true }); return; }
    this.resultMessage = `批量完成：成功 ${response.data.completed}，跳过 ${response.data.skipped}，失败 ${response.data.failed}`;
    await this.refresh();
  }
}

function rollbackLabel(assessment) {
  if (!assessment?.can_rollback) return "不可自动撤销";
  return assessment.requires_confirmation ? "撤销（需要确认）" : "安全撤销";
}

class RollbackConfirmModal extends Modal {
  constructor(app, plugin, run, onComplete) { super(app); this.plugin = plugin; this.run = run; this.onComplete = onComplete; }
  onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("knowledgeos-review-modal");
    root.createEl("h2", { text: "确认撤销" });
    root.createEl("p", { text: `准备撤销 ${this.run.run_id}：${this.run.source_action}` });
    const assessment = this.run.rollback;
    const warning = root.createDiv({ cls: assessment.requires_confirmation ? "knowledgeos-review-warning" : "knowledgeos-state" });
    for (const reason of assessment.reasons || []) warning.createDiv({ text: reason });
    if (assessment.later_dependent_runs?.length) warning.createDiv({ text: `后续关联 Run：${assessment.later_dependent_runs.join("、")}` });
    root.createEl("p", { text: "撤销只恢复该事务记录的文件快照；如果文件已被用户修改，Core 会拒绝覆盖。" });
    this.statusEl = root.createDiv({ cls: "knowledgeos-capture-status" });
    const actions = root.createDiv({ cls: "knowledgeos-capture-actions" });
    this.confirmButton = actions.createEl("button", { cls: "mod-warning", text: "确认撤销" });
    this.confirmButton.onclick = () => this.submit();
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.onclick = () => this.close();
  }
  async submit() {
    this.confirmButton.disabled = true;
    this.statusEl.setText("Core 正在验证文件状态并执行撤销…");
    const response = await this.plugin.client.invoke("rollbackRun", {
      run_id: this.run.run_id,
      confirm: this.run.rollback.requires_confirmation === true,
    });
    this.confirmButton.disabled = false;
    if (!response.ok) {
      this.statusEl.setText(response.error?.message || "撤销失败；现有文件保持不变。");
      return;
    }
    const warning = response.data.warnings?.length ? `；${response.data.warnings.join("；")}` : "";
    this.plugin.notify(`已撤销 ${this.run.run_id}${warning}`, { force: true });
    this.close();
    await this.onComplete(response.data);
  }
}

class RunDetailsModal extends Modal {
  constructor(app, plugin, runId, onChanged) { super(app); this.plugin = plugin; this.runId = runId; this.onChanged = onChanged; }
  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("knowledgeos-run-modal");
    root.createEl("h2", { text: "Run 详情" });
    this.body = root.createDiv({ cls: "knowledgeos-state", text: "正在加载运行详情…" });
    const response = await this.plugin.client.invoke("getRunDetails", { run_id: this.runId, developer_mode: this.plugin.settings.developerMode });
    if (!response.ok) { this.body.setText(response.error?.message || "无法加载 Run 详情"); return; }
    this.run = response.data;
    this.renderDetails();
  }
  renderDetails() {
    const run = this.run;
    const root = this.body;
    root.empty();
    root.removeClass("knowledgeos-state");
    root.createEl("h3", { text: `${run.run_id} · ${run.status}` });
    root.createDiv({ cls: "knowledgeos-review-meta", text: `${run.source_module}${run.instance_id ? ` / ${run.instance_id}` : ""} · ${run.completed_at}` });
    root.createEl("p", { text: run.input_summary || run.source_action || "Core operation" });

    root.createEl("h4", { text: `修改文件 (${run.affected_files.length})` });
    if (!run.affected_files.length) root.createDiv({ cls: "knowledgeos-empty", text: "此 Run 没有可展示的事务文件。" });
    for (const file of run.affected_files) {
      const button = root.createEl("button", { cls: "knowledgeos-link knowledgeos-run-file", text: file.path });
      button.onclick = () => this.app.workspace.openLinkText(file.path, "", false);
    }
    root.createEl("h4", { text: `执行操作 (${run.operations.length})` });
    for (const operation of run.operations) {
      const row = root.createDiv({ cls: "knowledgeos-run-operation" });
      row.createEl("strong", { text: `${operation.type} · ${operation.status}` });
      if (operation.target) row.createDiv({ text: operation.target });
      if (operation.error) row.createDiv({ cls: "knowledgeos-impact", text: operation.error });
    }
    if (run.reviews.length) {
      root.createEl("h4", { text: `创建审核 (${run.reviews.length})` });
      for (const review of run.reviews) {
        const button = root.createEl("button", { cls: "knowledgeos-link knowledgeos-run-file", text: `${review.review_id} · ${review.action}` });
        button.onclick = () => { this.close(); this.plugin.activateReviews(review.review_id); };
      }
    }
    root.createEl("h4", { text: "恢复能力" });
    const assessment = root.createDiv({ cls: `knowledgeos-rollback rollback-${run.rollback.level}` });
    assessment.createEl("strong", { text: rollbackLabel(run.rollback) });
    for (const reason of run.rollback.reasons || []) assessment.createDiv({ text: reason });
    if (run.rollback.changed_paths?.length) assessment.createDiv({ text: `已变化：${run.rollback.changed_paths.join("、")}` });
    assessment.createDiv({ cls: "knowledgeos-review-meta", text: `Git 快照：${run.git_snapshot || "无"}` });
    if (run.error_summary) root.createDiv({ cls: "knowledgeos-review-warning", text: run.error_summary });

    if (this.plugin.settings.developerMode && run.developer) {
      const details = root.createEl("details");
      details.createEl("summary", { text: "开发者数据" });
      details.createEl("pre", { text: displayJson(run.developer) });
    }
    const actions = root.createDiv({ cls: "knowledgeos-capture-actions" });
    const rollback = actions.createEl("button", { text: rollbackLabel(run.rollback) });
    rollback.disabled = !run.rollback.can_rollback;
    rollback.onclick = () => {
      this.close();
      new RollbackConfirmModal(this.app, this.plugin, run, async () => { await this.onChanged(); }).open();
    };
    const openLog = actions.createEl("button", { text: "打开运行日志" });
    openLog.onclick = () => this.app.workspace.openLinkText(run.vault_path, "", false);
    const close = actions.createEl("button", { text: "关闭" });
    close.onclick = () => this.close();
  }
}

class LifecycleConfirmModal extends Modal {
  constructor(app, plugin, title, method, params, preview, onComplete) {
    super(app); this.plugin = plugin; this.title = title; this.method = method; this.params = params; this.preview = preview; this.onComplete = onComplete;
  }
  onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("knowledgeos-review-modal");
    root.createEl("h2", { text: this.title });
    root.createDiv({ cls: "knowledgeos-review-meta", text: `${this.preview.current_status} → ${this.preview.target_status}` });
    const effects = root.createDiv({ cls: this.preview.requires_confirmation ? "knowledgeos-review-warning" : "knowledgeos-state" });
    for (const effect of this.preview.effects || []) effects.createDiv({ text: `• ${effect}` });
    if (this.preview.impact) {
      const impact = root.createDiv({ cls: "knowledgeos-lifecycle-impact" });
      if (this.preview.impact.active_instance_count !== undefined) impact.createDiv({ text: `活跃实例：${this.preview.impact.active_instance_count}` });
      if (this.preview.impact.inbox_count !== undefined) impact.createDiv({ text: `未处理 Inbox：${this.preview.impact.inbox_count}` });
      if (this.preview.impact.pending_review_count !== undefined) impact.createDiv({ text: `待审核：${this.preview.impact.pending_review_count}` });
      impact.createDiv({ text: this.preview.impact.data_deleted ? "会删除数据" : "不会删除用户数据" });
    }
    this.statusEl = root.createDiv({ cls: "knowledgeos-capture-status" });
    const actions = root.createDiv({ cls: "knowledgeos-capture-actions" });
    this.confirmButton = actions.createEl("button", { cls: this.preview.requires_confirmation ? "mod-warning" : "mod-cta", text: "确认执行" });
    this.confirmButton.onclick = () => this.submit();
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.onclick = () => this.close();
  }
  async submit() {
    this.confirmButton.disabled = true;
    this.statusEl.setText("Core 正在创建快照并执行生命周期变更…");
    const response = await this.plugin.client.invoke(this.method, { ...this.params, confirm: true });
    this.confirmButton.disabled = false;
    if (!response.ok) { this.statusEl.setText(response.error?.message || "生命周期操作失败"); return; }
    this.plugin.notify(`状态已更新为 ${response.data.status}`);
    this.close();
    await this.onComplete();
  }
}

class CreateInstanceModal extends Modal {
  constructor(app, plugin, modules, onComplete, initialModuleId = null) {
    super(app); this.plugin = plugin; this.modules = modules.filter((module) => module.status === "enabled" && module.instance_form); this.onComplete = onComplete; this.initialModuleId = initialModuleId;
  }
  onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("knowledgeos-instance-wizard");
    root.createEl("h2", { text: "创建实例" });
    const moduleLabel = root.createEl("label", { text: "模块" });
    this.moduleSelect = moduleLabel.createEl("select");
    for (const module of this.modules) this.moduleSelect.createEl("option", { value: module.id, text: module.name });
    if (this.initialModuleId) this.moduleSelect.value = this.initialModuleId;
    this.moduleSelect.onchange = () => this.renderFields();
    const common = root.createDiv({ cls: "knowledgeos-capture-row" });
    const idLabel = common.createEl("label", { text: "实例 ID" });
    this.idInput = idLabel.createEl("input", { type: "text", placeholder: "intern-2026" });
    const nameLabel = common.createEl("label", { text: "显示名称" });
    this.nameInput = nameLabel.createEl("input", { type: "text", placeholder: "2026 实习" });
    this.fieldsEl = root.createDiv({ cls: "knowledgeos-instance-fields" });
    this.previewEl = root.createDiv();
    this.statusEl = root.createDiv({ cls: "knowledgeos-capture-status" });
    const actions = root.createDiv({ cls: "knowledgeos-capture-actions" });
    this.previewButton = actions.createEl("button", { text: "预览" });
    this.previewButton.onclick = () => this.preview();
    this.createButton = actions.createEl("button", { cls: "mod-cta", text: "创建实例" });
    this.createButton.disabled = true;
    this.createButton.onclick = () => this.create();
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.onclick = () => this.close();
    this.idInput.oninput = () => this.invalidatePreview();
    this.nameInput.oninput = () => this.invalidatePreview();
    this.renderFields();
  }
  currentModule() { return this.modules.find((module) => module.id === this.moduleSelect.value); }
  renderFields() {
    this.fieldsEl.empty();
    this.inputs = new Map();
    const module = this.currentModule();
    if (!module) { this.fieldsEl.createDiv({ cls: "knowledgeos-empty", text: "没有支持实例创建的已启用模块。" }); return; }
    for (const field of module.instance_form.fields) {
      const label = this.fieldsEl.createEl("label", { text: `${field.label}${field.required ? " *" : ""}` });
      let input;
      if (field.type === "select") {
        input = label.createEl("select");
        for (const option of field.options || []) input.createEl("option", { value: option, text: option });
      } else if (field.type === "boolean") {
        input = label.createEl("input", { type: "checkbox" });
        input.checked = field.default === true;
      } else {
        input = label.createEl("input", { type: field.type === "date" ? "date" : field.type === "number" ? "number" : "text" });
        if (field.default !== undefined && field.default !== null) input.value = String(field.default);
      }
      input.onchange = () => this.invalidatePreview();
      if (field.type !== "boolean" && field.type !== "select") input.oninput = () => this.invalidatePreview();
      this.inputs.set(field.key, { input, field });
    }
    this.previewEl.empty();
    this.createButton.disabled = true;
  }
  invalidatePreview() {
    if (this.previewEl) this.previewEl.empty();
    if (this.createButton) this.createButton.disabled = true;
    this.previewData = null;
  }
  params(previewOnly) {
    const fields = {};
    for (const [key, entry] of this.inputs) {
      if (entry.field.type === "boolean") fields[key] = entry.input.checked;
      else if (entry.field.type === "number") fields[key] = entry.input.value === "" ? null : Number(entry.input.value);
      else fields[key] = entry.input.value === "" && entry.field.default === null ? null : entry.input.value || undefined;
    }
    for (const key of Object.keys(fields)) if (fields[key] === undefined) delete fields[key];
    return {
      module_id: this.moduleSelect.value, instance_id: this.idInput.value.trim(), display_name: this.nameInput.value.trim(),
      fields, preview_only: previewOnly,
    };
  }
  async preview() {
    this.statusEl.setText("正在验证实例配置…");
    const response = await this.plugin.client.invoke("createInstance", this.params(true));
    if (!response.ok) { this.statusEl.setText(response.error?.message || "实例配置无法通过验证"); this.createButton.disabled = true; return; }
    this.previewData = response.data;
    this.statusEl.setText("");
    this.previewEl.empty();
    const preview = this.previewEl.createDiv({ cls: "knowledgeos-inbox-preview" });
    preview.createEl("strong", { text: "创建预览" });
    preview.createDiv({ text: `内容目录：${response.data.content_root}` });
    preview.createDiv({ text: `Inbox：${response.data.inbox_path}` });
    preview.createDiv({ text: "初始状态：active" });
    preview.createDiv({ text: "不会修改或删除现有用户文件。" });
    this.createButton.disabled = false;
  }
  async create() {
    this.createButton.disabled = true;
    this.statusEl.setText("Core 正在创建 Git 快照、目录和实例配置…");
    const response = await this.plugin.client.invoke("createInstance", this.params(false));
    if (!response.ok) { this.statusEl.setText(response.error?.message || "实例创建失败"); this.createButton.disabled = false; return; }
    this.plugin.notify(`已创建实例 ${response.data.display_name}`);
    this.close();
    await this.onComplete();
  }
}

class TaskDetailsModal extends Modal {
  constructor(app, plugin, taskId, onChanged) { super(app); this.plugin = plugin; this.taskId = taskId; this.onChanged = onChanged; }
  async onOpen() {
    const root = this.contentEl;
    root.empty(); root.addClass("knowledgeos-run-modal");
    root.createEl("h2", { text: "Task 详情" });
    const state = markLiveRegion(root.createDiv({ cls: "knowledgeos-state", text: "正在加载任务…" }));
    const response = await this.plugin.client.invoke("getTaskDetails", { task_id: this.taskId });
    if (!response.ok) { state.setText(response.error?.message || "任务加载失败"); return; }
    state.remove();
    const task = response.data.task;
    root.createEl("h3", { text: `${task.job_id} · ${task.status}` });
    root.createDiv({ cls: "knowledgeos-review-meta", text: `${task.module}${task.instance_id ? ` / ${task.instance_id}` : ""} · ${task.priority}` });
    root.createDiv({ text: `计划：${task.scheduled_for} · 尝试 ${task.attempt_count}/${task.max_attempts}` });
    root.createDiv({ text: `资源：filesystem ${task.resources.filesystem} · network ${task.resources.network} · codex ${task.resources.codex} · user ${task.resources.user}` });
    if (task.last_error) root.createDiv({ cls: "knowledgeos-review-warning", text: `${task.last_error.code}：${task.last_error.message}` });
    if (task.payload?.source_file) {
      const source = root.createEl("button", { cls: "knowledgeos-link", text: `打开关联文件：${task.payload.source_file}` });
      source.onclick = () => this.app.workspace.openLinkText(task.payload.source_file, "", false);
    }
    root.createEl("h4", { text: `运行历史 (${response.data.runs.length})` });
    for (const run of response.data.runs) root.createDiv({ cls: "knowledgeos-run-operation", text: `第 ${run.attempt_number} 次 · ${run.status} · ${run.started_at}` });
    if (response.data.codex_invocations?.length) {
      root.createEl("h4", { text: `Codex 调用 (${response.data.codex_invocations.length})` });
      for (const call of response.data.codex_invocations) root.createDiv({ cls: "knowledgeos-run-operation", text: `${call.prompt_id}@${call.prompt_version} · ${call.model || call.adapter} · ${call.status}` });
    }
    const actions = root.createDiv({ cls: "knowledgeos-capture-actions" });
    if (["failed", "waiting-for-network", "waiting-for-ai", "waiting-for-user", "deferred", "interrupted"].includes(task.status)) this.actionButton(actions, "重试", "retry");
    if (!["completed", "cancelled"].includes(task.status)) {
      if (task.priority !== "high") this.actionButton(actions, "提升为高优先级", "set-priority", { priority: "high" });
      if (task.priority !== "normal") this.actionButton(actions, "恢复普通优先级", "set-priority", { priority: "normal" });
      this.actionButton(actions, "延后一天", "defer", { defer_until: new Date(Date.now() + 86_400_000).toISOString() });
      this.actionButton(actions, task.status === "running" ? "请求取消" : "取消", "cancel");
    }
    const close = actions.createEl("button", { text: "关闭" }); close.onclick = () => this.close();
  }
  actionButton(root, label, action, extra = {}) {
    const button = root.createEl("button", { text: label });
    button.onclick = async () => {
      button.disabled = true;
      const response = await this.plugin.client.invoke("manageTask", { task_id: this.taskId, action, ...extra });
      if (!response.ok) { button.disabled = false; this.plugin.notify(response.error?.message || "任务操作失败", { error: true }); return; }
      this.plugin.notify(`任务已更新为 ${response.data.status}`);
      this.close(); await this.onChanged();
    };
  }
}

class SystemCenterView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return SYSTEM_VIEW_TYPE; }
  getDisplayText() { return "KnowledgeOS System"; }
  getIcon() { return "activity"; }
  async onOpen() { await this.refresh(); }

  async refresh(openRunId = null, openTaskId = null) {
    const root = this.contentEl;
    root.empty();
    markLiveRegion(root.createDiv({ cls: "knowledgeos-state", text: "正在检查系统状态…" }));
    const [modules, instances, inbox, reviews, runs, tasks, runtime] = await Promise.all([
      this.plugin.client.invoke("getModules", {}),
      this.plugin.client.invoke("getInstances", {}),
      this.plugin.client.invoke("listInboxItems", {}),
      this.plugin.client.invoke("listReviewItems", { statuses: ["pending", "error"] }),
      this.plugin.client.invoke("getRecentRuns", { limit: 20 }),
      this.plugin.client.invoke("listTasks", { limit: 200 }),
      this.plugin.client.invoke("getTaskRuntimeStatus", {}),
    ]);
    const failed = [modules, instances, inbox, reviews, runs, tasks, runtime].find((response) => !response.ok);
    if (failed) { this.renderFailure(failed.error); return; }
    this.data = { modules: modules.data, instances: instances.data, inbox: inbox.data, reviews: reviews.data, runs: runs.data, tasks: tasks.data, runtime: runtime.data };
    this.render();
    if (openRunId) new RunDetailsModal(this.app, this.plugin, openRunId, () => this.refresh()).open();
    if (openTaskId) new TaskDetailsModal(this.app, this.plugin, openTaskId, () => this.refresh()).open();
  }

  renderFailure(error) {
    const root = this.contentEl;
    renderRecoverableError(root, "System Center 无法连接 Core", error, () => this.refresh());
  }

  moduleStats(moduleId) {
    return {
      inbox: this.data.inbox.items.filter((item) => item.suggested_module_id === moduleId).length,
      reviews: this.data.reviews.filter((item) => item.source_module === moduleId).length,
      latest: this.data.runs.find((run) => run.source_module === moduleId) || null,
    };
  }
  instanceStats(instanceId) {
    return {
      inbox: this.data.inbox.items.filter((item) => item.suggested_instance_id === instanceId).length,
      reviews: this.data.reviews.filter((item) => item.instance_id === instanceId).length,
      latest: this.data.runs.find((run) => run.instance_id === instanceId) || null,
    };
  }

  render() {
    const root = this.contentEl;
    root.empty();
    const header = root.createDiv({ cls: "knowledgeos-header" });
    header.createEl("h2", { text: "System Center" });
    const refresh = header.createEl("button", { text: "刷新" });
    refresh.onclick = () => this.refresh();
    const create = header.createEl("button", { cls: "mod-cta", text: "创建实例" });
    create.disabled = !this.data.modules.some((module) => module.status === "enabled" && module.instance_form);
    create.onclick = () => new CreateInstanceModal(this.app, this.plugin, this.data.modules, () => this.refresh()).open();
    const runTasks = header.createEl("button", { text: "运行任务队列" });
    runTasks.onclick = async () => { runTasks.disabled = true; const response = await this.plugin.client.invoke("runTaskCycle", { limit: 2 }); runTasks.disabled = false; if (!response.ok) this.plugin.notify(response.error?.message || "任务运行失败", { error: true }); await this.refresh(); };
    const health = root.createDiv({ cls: "knowledgeos-system-health" });
    health.createEl("strong", { text: "Core 已连接 · Command API v1" });
    health.createDiv({ text: `模块 ${this.data.modules.length} · 实例 ${this.data.instances.length} · Inbox ${this.data.inbox.counts.total} · 待审核 ${this.data.reviews.length}` });
    health.createDiv({ text: `Task Runtime ${this.data.runtime.integrity} · 队列 ${this.data.runtime.counts.queued || 0} · 等待 AI ${this.data.runtime.counts["waiting-for-ai"] || 0} · 失败 ${this.data.runtime.counts.failed || 0}` });

    root.createEl("h3", { text: "Task Center" });
    const taskGroups = [
      ["Active", ["queued", "running"]], ["Waiting", ["waiting-for-network", "waiting-for-ai", "waiting-for-user", "deferred", "interrupted"]],
      ["Scheduled", ["queued"]], ["Failed", ["failed"]], ["History", ["completed", "cancelled"]],
    ];
    for (const [label, statuses] of taskGroups) {
      const matching = this.data.tasks.filter((task) => statuses.includes(task.status))
        .filter((task) => label === "Scheduled" ? task.status === "queued" && Date.parse(task.scheduled_for) > Date.now() : label === "Active" ? task.status === "running" || (task.status === "queued" && Date.parse(task.scheduled_for) <= Date.now()) : true)
        .slice(0, label === "History" ? 10 : 50);
      if (!matching.length) continue;
      root.createEl("h4", { text: `${label} (${matching.length})` });
      for (const task of matching) {
        const card = root.createDiv({ cls: `knowledgeos-card knowledgeos-task-card task-${task.status}` });
        const open = card.createEl("button", { cls: "knowledgeos-link", text: `${task.job_id} · ${task.status}` });
        open.onclick = () => new TaskDetailsModal(this.app, this.plugin, task.task_id, () => this.refresh()).open();
        card.createDiv({ cls: "knowledgeos-review-meta", text: `${task.module}${task.instance_id ? ` / ${task.instance_id}` : ""} · ${task.scheduled_for} · 尝试 ${task.attempt_count}/${task.max_attempts}` });
        if (task.last_error) card.createDiv({ cls: "knowledgeos-description", text: task.last_error.message });
      }
    }

    const scheduledJobs = (this.data.runtime.jobs || []).filter((job) => job.enabled && job.trigger?.type !== "startup");
    if (scheduledJobs.length) {
      root.createEl("h4", { text: `已注册计划 (${scheduledJobs.length})` });
      for (const job of scheduledJobs) {
        const card = root.createDiv({ cls: "knowledgeos-card knowledgeos-task-card" });
        card.createEl("strong", { text: job.job_id });
        card.createDiv({ cls: "knowledgeos-review-meta", text: `${job.trigger.type} · ${job.workflow} · ${job.priority}` });
        const run = card.createEl("button", { text: "立即运行" });
        run.onclick = async () => {
          run.disabled = true;
          const response = await this.plugin.client.invoke("enqueueTask", { job_id: job.job_id });
          if (!response.ok) this.plugin.notify(response.error?.message || "任务创建失败", { error: true });
          else this.plugin.notify(response.data.deduplicated ? "任务已在队列中" : "任务已加入队列");
          await this.refresh();
        };
      }
    }

    root.createEl("h3", { text: "模块" });
    for (const module of this.data.modules) {
      const stats = this.moduleStats(module.id);
      const card = root.createDiv({ cls: "knowledgeos-card knowledgeos-system-card" });
      card.createEl("strong", { text: `${module.name} · ${module.status}` });
      card.createDiv({ cls: "knowledgeos-review-meta", text: `v${module.version} · 活跃实例 ${module.active_instance_count} · Inbox ${stats.inbox} · 审核 ${stats.reviews}` });
      if (module.description) card.createDiv({ cls: "knowledgeos-description", text: module.description.trim() });
      card.createDiv({ cls: "knowledgeos-review-meta", text: stats.latest ? `最近运行：${stats.latest.run_id} · ${stats.latest.status}` : "尚无运行记录" });
      const actions = card.createDiv({ cls: "knowledgeos-review-actions" });
      const validate = actions.createEl("button", { text: "验证模块" });
      validate.onclick = () => this.validateModule(module);
      const toggle = actions.createEl("button", { text: module.status === "enabled" ? "停用模块" : "启用模块" });
      toggle.onclick = () => this.moduleAction(module, module.status === "enabled" ? "disable" : "enable");
      if (module.status === "enabled" && module.instance_form) {
        const add = actions.createEl("button", { text: "创建实例" });
        add.onclick = () => new CreateInstanceModal(this.app, this.plugin, this.data.modules, () => this.refresh(), module.id).open();
      }
    }

    root.createEl("h3", { text: "实例" });
    if (!this.data.instances.length) root.createDiv({ cls: "knowledgeos-empty", text: "当前没有模块实例。创建向导将在生命周期 API 开放后提供。" });
    for (const instance of this.data.instances) {
      const stats = this.instanceStats(instance.instance_id);
      const card = root.createDiv({ cls: "knowledgeos-card knowledgeos-system-card" });
      const open = card.createEl("button", { cls: "knowledgeos-link", text: `${instance.display_name} · ${instance.status}` });
      open.onclick = () => this.app.workspace.openLinkText(instance.content_root, "", false);
      card.createDiv({ cls: "knowledgeos-review-meta", text: `${instance.module_id} · Inbox ${stats.inbox} · 审核 ${stats.reviews}` });
      card.createDiv({ cls: "knowledgeos-description", text: instance.content_root });
      card.createDiv({ cls: "knowledgeos-review-meta", text: stats.latest ? `最近成功：${stats.latest.run_id} · ${stats.latest.completed_at}` : "尚无运行记录" });
      const actions = card.createDiv({ cls: "knowledgeos-review-actions" });
      for (const action of instance.available_actions || []) {
        const labels = { activate: "激活", pause: "暂停", resume: "恢复", complete: "标记完成", archive: "归档" };
        const button = actions.createEl("button", { text: labels[action] || action });
        button.onclick = () => this.instanceAction(instance, action);
      }
    }

    root.createEl("h3", { text: "最近运行" });
    if (!this.data.runs.length) root.createDiv({ cls: "knowledgeos-empty", text: "尚无运行记录。" });
    for (const run of this.data.runs) this.renderRun(root, run);
  }

  renderRun(root, run) {
    const card = root.createDiv({ cls: `knowledgeos-card knowledgeos-run-card run-${run.status}` });
    const title = card.createEl("button", { cls: "knowledgeos-link", text: run.source_action });
    title.onclick = () => new RunDetailsModal(this.app, this.plugin, run.run_id, () => this.refresh()).open();
    card.createDiv({ cls: "knowledgeos-review-meta", text: `${run.run_id} · ${run.source_module}${run.instance_id ? ` / ${run.instance_id}` : ""} · ${run.completed_at}` });
    card.createDiv({ text: `文件 ${run.modified_file_count} · 操作 ${run.operation_count} · 审核 ${run.review_count}` });
    const recovery = card.createDiv({ cls: `knowledgeos-rollback-inline rollback-${run.rollback.level}`, text: rollbackLabel(run.rollback) });
    if (run.status === "failed") recovery.setText("运行失败 · 查看详情");
  }

  async validateModule(module) {
    const response = await this.plugin.client.invoke("manageModule", { module_id: module.id, action: "validate" });
    if (!response.ok) { this.plugin.notify(response.error?.message || "模块验证失败", { error: true }); return; }
    this.plugin.notify(`${module.name} 验证通过：${response.data.checks.join("、")}`);
  }
  async moduleAction(module, action) {
    const response = await this.plugin.client.invoke("manageModule", { module_id: module.id, action, preview_only: true });
    if (!response.ok) { this.plugin.notify(response.error?.message || "无法预览模块操作", { error: true }); return; }
    new LifecycleConfirmModal(this.app, this.plugin, `${action === "disable" ? "停用" : "启用"} ${module.name}`, "manageModule", { module_id: module.id, action }, response.data, () => this.refresh()).open();
  }
  async instanceAction(instance, action) {
    const response = await this.plugin.client.invoke("manageInstance", { instance_id: instance.instance_id, action, preview_only: true });
    if (!response.ok) { this.plugin.notify(response.error?.message || "无法预览实例操作", { error: true }); return; }
    const labels = { activate: "激活", pause: "暂停", resume: "恢复", complete: "标记完成", archive: "归档" };
    new LifecycleConfirmModal(this.app, this.plugin, `${labels[action] || action} ${instance.display_name}`, "manageInstance", { instance_id: instance.instance_id, action }, response.data, () => this.refresh()).open();
  }
}

class TodayView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.state = "ready";
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "KnowledgeOS Today"; }
  getIcon() { return "calendar-check"; }

  async onOpen() { await this.refresh(); }

  async refresh() {
    this.state = "loading";
    this.renderLoading();
    const response = await this.plugin.client.invoke("getTodayItems", { refresh_markdown: true });
    this.state = response.state;
    if (!response.ok) this.renderError(response.error);
    else this.renderSnapshot(response.data);
  }

  renderLoading() {
    const root = this.contentEl;
    root.empty();
    markLiveRegion(root.createDiv({ cls: "knowledgeos-state", text: "正在加载 Today…" }));
  }

  renderError(error) {
    const root = this.contentEl;
    renderRecoverableError(root, "Today 暂时不可用", error, () => this.refresh());
    const open = root.createEl("button", { text: "打开上次生成的 Today.md" });
    open.onclick = () => this.app.workspace.openLinkText("Today", "", false);
  }

  renderSnapshot(snapshot) {
    const root = this.contentEl;
    root.empty();
    this.renderedItems = new Set();
    const header = root.createDiv({ cls: "knowledgeos-header" });
    header.createEl("h2", { text: "Today" });
    const refresh = header.createEl("button", { text: "刷新" });
    refresh.onclick = () => this.refresh();
    const open = header.createEl("button", { text: "打开 Today.md" });
    open.onclick = () => this.app.workspace.openLinkText("Today", "", false);

    const counts = root.createDiv({ cls: "knowledgeos-counts" });
    for (const [label, value] of [
      ["重点", snapshot.counts.focus],
      ["审核", snapshot.counts.reviews],
      ["Inbox", snapshot.counts.inbox],
      ["失败", snapshot.counts.failures],
    ]) counts.createSpan({ cls: "knowledgeos-count", text: `${label} ${value}` });

    this.renderItems(root, "今日重点", snapshot.focus);
    this.renderItems(root, "待审核", snapshot.reviews);
    this.renderInbox(root, snapshot.inbox);
    this.renderItems(root, "异常与失败", snapshot.failures);
    this.renderRuns(root, snapshot.recent_completed);
    if (!snapshot.focus.length && !snapshot.recent_completed.length) {
      root.createDiv({ cls: "knowledgeos-empty", text: "当前没有需要处理的事项。" });
    }
  }

  renderItems(root, title, items) {
    const visible = (items || []).filter((item) => {
      const key = item.target ? `${item.source_module}:${item.target}:${item.category}` : `${item.source_module}:${item.item_id}`;
      if (this.renderedItems.has(key)) return false;
      this.renderedItems.add(key);
      return true;
    });
    if (!visible.length) return;
    root.createEl("h3", { text: title });
    const list = root.createDiv({ cls: "knowledgeos-list" });
    for (const item of visible) {
      const card = list.createDiv({ cls: `knowledgeos-card priority-${item.priority}` });
      const button = card.createEl("button", { cls: "knowledgeos-link", text: item.title });
      button.onclick = () => item.category === "review"
        ? this.plugin.activateReviews(item.item_id.replace("DSH-REVIEW-", ""))
        : item.item_id.startsWith("DSH-TASK-")
          ? this.plugin.activateSystem(null, item.item_id.replace("DSH-TASK-", ""))
        : item.target && this.app.workspace.openLinkText(item.target, "", false);
      if (item.description) card.createDiv({ cls: "knowledgeos-description", text: item.description });
      card.createSpan({ cls: "knowledgeos-module", text: item.source_module });
    }
  }

  renderInbox(root, groups) {
    if (!groups?.length) return;
    root.createEl("h3", { text: "待处理 Inbox" });
    for (const group of groups) {
      const button = root.createEl("button", { cls: "knowledgeos-card knowledgeos-inbox-summary", text: `${group.label}：${group.count} 项` });
      button.onclick = () => this.plugin.activateInbox();
    }
  }

  renderRuns(root, runs) {
    if (!runs?.length) return;
    root.createEl("h3", { text: "最近完成" });
    for (const run of runs.slice(0, 5)) {
      const card = root.createDiv({ cls: "knowledgeos-card" });
      const button = card.createEl("button", { cls: "knowledgeos-link", text: `${run.source_module} · ${run.run_id}` });
      button.onclick = () => this.plugin.activateSystem(run.run_id);
      card.createDiv({ cls: "knowledgeos-description", text: run.completed_at });
    }
  }
}

class KnowledgeOSSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("Core CLI 路径").setDesc("knowledgeos-engine/dist/cli.js 的绝对路径")
      .addText((text) => text.setPlaceholder("E:\\KnowledgeOS\\knowledgeos-engine\\dist\\cli.js")
        .setValue(this.plugin.settings.coreCliPath).onChange(async (value) => {
          this.plugin.settings.coreCliPath = value.trim(); await this.plugin.saveSettings();
        }));
    new Setting(containerEl).setName("Node.js 可执行文件").setDesc("通常保持为 node；未加入 PATH 时填写 node.exe 的绝对路径")
      .addText((text) => text.setValue(this.plugin.settings.nodePath).onChange(async (value) => {
        this.plugin.settings.nodePath = value.trim() || "node"; await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("Vault 路径").setDesc("当前 KnowledgeOS 数据仓库的绝对路径")
      .addText((text) => text.setValue(this.plugin.settings.vaultPath).onChange(async (value) => {
        this.plugin.settings.vaultPath = value.trim(); await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("启动时打开 Today").addToggle((toggle) => toggle
      .setValue(this.plugin.settings.openTodayOnStartup).onChange(async (value) => {
        this.plugin.settings.openTodayOnStartup = value; await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("自动刷新").setDesc("Vault 文件变化后刷新 Today 视图")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.autoRefresh).onChange(async (value) => {
        this.plugin.settings.autoRefresh = value; await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("操作完成通知").setDesc("显示主动操作的完成通知；失败和撤销结果始终通知")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.notifyOnCompletion).onChange(async (value) => {
        this.plugin.settings.notifyOnCompletion = value; await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("允许批量处理").setDesc("在 Inbox Center 显示高置信度批量处理入口")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.allowBatchOperations).onChange(async (value) => {
        this.plugin.settings.allowBatchOperations = value; await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("开发者模式").setDesc("在 Run 详情中显示底层计划、事务和日志数据")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.developerMode).onChange(async (value) => {
        this.plugin.settings.developerMode = value; await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("测试连接").addButton((button) => button.setButtonText("测试").onClick(async () => {
      const result = await this.plugin.client.invoke("getModules", {});
      this.plugin.notify(result.ok ? "KnowledgeOS Core 连接正常" : result.error?.message || "连接失败", { error: !result.ok, force: true });
    }));
  }
}

module.exports = class KnowledgeOSPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.vaultPath && this.app.vault.adapter.basePath) this.settings.vaultPath = this.app.vault.adapter.basePath;
    this.client = new CoreCommandClient(this.settings);
    this.registerView(VIEW_TYPE, (leaf) => new TodayView(leaf, this));
    this.registerView(REVIEW_VIEW_TYPE, (leaf) => new ReviewCenterView(leaf, this));
    this.registerView(INBOX_VIEW_TYPE, (leaf) => new InboxCenterView(leaf, this));
    this.registerView(SYSTEM_VIEW_TYPE, (leaf) => new SystemCenterView(leaf, this));
    this.addRibbonIcon("calendar-check", "打开 KnowledgeOS Today", () => this.activateToday());
    this.addRibbonIcon("plus-circle", "Quick Capture", () => this.openCapture());
    this.addRibbonIcon("clipboard-check", "打开 Review Center", () => this.activateReviews());
    this.addRibbonIcon("inbox", "打开 Inbox Center", () => this.activateInbox());
    this.addRibbonIcon("activity", "打开 System Center", () => this.activateSystem());
    this.addCommand({ id: "open-today", name: "Open Today", hotkeys: [{ modifiers: ["Mod", "Shift"], key: "t" }], callback: () => this.activateToday() });
    this.addCommand({ id: "quick-capture", name: "Quick Capture", hotkeys: [{ modifiers: ["Mod", "Shift"], key: "c" }], callback: () => this.openCapture() });
    this.addCommand({ id: "open-reviews", name: "Open Review Center", callback: () => this.activateReviews() });
    this.addCommand({ id: "open-inbox", name: "Open Inbox Center", callback: () => this.activateInbox() });
    this.addCommand({ id: "open-system", name: "Open System Center", callback: () => this.activateSystem() });
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      menu.addItem((item) => item.setTitle("Quick Capture 到此上下文").setIcon("plus-circle")
        .onClick(() => this.openCapture(file.path)));
    }));
    this.addSettingTab(new KnowledgeOSSettingTab(this.app, this));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (!this.settings.autoRefresh) return;
      if (file.path === "Today.md") return;
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => {
        for (const type of [VIEW_TYPE, INBOX_VIEW_TYPE, SYSTEM_VIEW_TYPE]) {
          for (const leaf of this.app.workspace.getLeavesOfType(type)) leaf.view.refresh();
        }
      }, 1500);
    }));
    this.app.workspace.onLayoutReady(async () => {
      await this.runTaskCycle(true);
      if (this.settings.openTodayOnStartup) await this.activateToday();
    });
    this.registerInterval(setInterval(() => this.runTaskCycle(false), 60_000));
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.client.settings = this.settings;
  }

  notify(message, options = {}) {
    if (options.error || options.force || this.settings.notifyOnCompletion) new Notice(message);
  }

  async runTaskCycle(startup = false) {
    if (this.taskCycleRunning) return;
    this.taskCycleRunning = true;
    try {
      const response = await this.client.invoke("runTaskCycle", { startup, limit: 2 });
      if (!response.ok) return;
      for (const type of [VIEW_TYPE, SYSTEM_VIEW_TYPE]) {
        for (const leaf of this.app.workspace.getLeavesOfType(type)) await leaf.view.refresh();
      }
    } finally { this.taskCycleRunning = false; }
  }

  async activateToday() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  openCapture(contextPath = null) {
    new QuickCaptureModal(this.app, this, contextPath).open();
  }

  async activateReviews(reviewId = null) {
    let leaf = this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: REVIEW_VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    if (leaf.view?.renderShell) await leaf.view.renderShell(reviewId);
  }

  async activateInbox() {
    let leaf = this.app.workspace.getLeavesOfType(INBOX_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: INBOX_VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    if (leaf.view?.refresh) await leaf.view.refresh();
  }

  async activateSystem(runId = null, taskId = null) {
    let leaf = this.app.workspace.getLeavesOfType(SYSTEM_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: SYSTEM_VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    if (leaf.view?.refresh) await leaf.view.refresh(runId, taskId);
  }
};
