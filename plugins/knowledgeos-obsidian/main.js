const { ItemView, Modal, Notice, Plugin, PluginSettingTab, Setting } = require("obsidian");
const { execFile } = require("node:child_process");

const VIEW_TYPE = "knowledgeos-today";
const REVIEW_VIEW_TYPE = "knowledgeos-reviews";
const INBOX_VIEW_TYPE = "knowledgeos-inbox";
const DEFAULT_SETTINGS = {
  coreCliPath: "",
  nodePath: "node",
  vaultPath: "",
  openTodayOnStartup: true,
  autoRefresh: true,
};

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

    this.statusEl = root.createDiv({ cls: "knowledgeos-capture-status" });
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
    new Notice(`已保存到 ${result.destination_label}`);
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
    new Notice(`审核已更新为 ${response.data.status}`);
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
      new Notice("讨论上下文已复制；请粘贴到 Codex。结论必须回到此窗口提交。");
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
    new Notice(`讨论结论已回写：${response.data.status}`);
    this.close();
    await this.onComplete();
  }
}

class ReviewCenterView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
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
    this.listEl.createDiv({ cls: "knowledgeos-state", text: "正在加载审核事项…" });
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
    if (!response.ok) { this.listEl.createEl("p", { text: response.error?.message || "审核列表加载失败。" }); return; }
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
    for (const review of this.reviews) {
      const card = this.listEl.createDiv({ cls: `knowledgeos-card priority-${review.priority}` });
      const title = card.createEl("button", { cls: "knowledgeos-link", text: review.title });
      title.onclick = () => this.renderDetail(review);
      card.createDiv({ cls: "knowledgeos-review-meta", text: `${review.source_module} · ${review.status} · 置信度 ${Math.round(review.confidence * 100)}%` });
      card.createDiv({ cls: "knowledgeos-description", text: `${review.target} · ${review.action}` });
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
    if (!response.ok) { new Notice(response.error?.message || "审核操作失败"); return; }
    new Notice("审核状态已更新");
    await this.loadReviews();
  }
}

class InboxCenterView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.selectedRoutes = new Map(); }
  getViewType() { return INBOX_VIEW_TYPE; }
  getDisplayText() { return "KnowledgeOS Inbox"; }
  getIcon() { return "inbox"; }
  async onOpen() { await this.refresh(); }

  async refresh(selectedItemId = null) {
    const root = this.contentEl;
    root.empty();
    root.createDiv({ cls: "knowledgeos-state", text: "正在加载 Inbox…" });
    const [inbox, modules, instances] = await Promise.all([
      this.plugin.client.invoke("listInboxItems", {}),
      this.plugin.client.invoke("getModules", {}),
      this.plugin.client.invoke("getInstances", {}),
    ]);
    if (!inbox.ok || !modules.ok || !instances.ok) {
      const error = inbox.error || modules.error || instances.error;
      root.empty();
      root.createEl("h2", { text: "Inbox Center 暂时不可用" });
      root.createEl("p", { text: error?.message || "未知错误" });
      const retry = root.createEl("button", { text: "重试" });
      retry.onclick = () => this.refresh();
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
    const batch = header.createEl("button", { cls: "mod-cta", text: `处理高置信度项 (${eligible.length})` });
    batch.disabled = eligible.length === 0;
    batch.onclick = () => this.processBatch(eligible);

    const counts = root.createDiv({ cls: "knowledgeos-counts" });
    for (const [label, value] of [["总计", this.listing.counts.total], ["待路由", this.listing.counts.needs_routing], ["等待 AI", this.listing.counts.waiting_for_ai], ["失败", this.listing.counts.failed]]) {
      counts.createSpan({ cls: "knowledgeos-count", text: `${label} ${value}` });
    }
    if (this.resultMessage) root.createDiv({ cls: "knowledgeos-state", text: this.resultMessage });
    if (!this.listing.groups.length) {
      root.createDiv({ cls: "knowledgeos-empty", text: "所有受管 Inbox 都已处理完毕。" });
      return;
    }
    for (const group of this.listing.groups) {
      const section = root.createDiv({ cls: "knowledgeos-inbox-group" });
      section.createEl("h3", { text: `${group.label} (${group.count})` });
      for (const item of group.items) this.renderItem(section, item, item.item_id === selectedItemId);
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
    if (!response.ok) { new Notice(response.error?.message || "无法生成预览"); return; }
    this.previewData = response.data;
    this.render(item.item_id);
  }

  async processItem(item, action, extra = {}) {
    const route = this.selectedRoute(item);
    const response = await this.plugin.client.invoke("processInboxItem", { item_id: item.item_id, action, ...route, ...extra });
    if (!response.ok) { new Notice(response.error?.message || "Inbox 处理失败"); return; }
    this.resultMessage = response.data.status === "waiting-for-ai" ? "条目已安全保留，等待 Codex / 模块工作流。" : `Inbox 状态已更新：${response.data.status}`;
    await this.refresh();
  }

  async processBatch(items) {
    const response = await this.plugin.client.invoke("processInboxBatch", { mode: "high-confidence", item_ids: items.map((item) => item.item_id) });
    if (!response.ok) { new Notice(response.error?.message || "批量处理失败"); return; }
    this.resultMessage = `批量完成：成功 ${response.data.completed}，跳过 ${response.data.skipped}，失败 ${response.data.failed}`;
    await this.refresh();
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
    root.createDiv({ cls: "knowledgeos-state", text: "正在加载 Today…" });
  }

  renderError(error) {
    const root = this.contentEl;
    root.empty();
    root.createEl("h2", { text: "Today 暂时不可用" });
    root.createEl("p", { text: error?.message || "未知错误" });
    if (error?.impact) root.createEl("p", { cls: "knowledgeos-impact", text: error.impact });
    const actions = root.createEl("ul");
    for (const action of error?.recovery_actions || []) actions.createEl("li", { text: action });
    const retry = root.createEl("button", { text: "重试" });
    retry.onclick = () => this.refresh();
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
      card.createDiv({ text: `${run.source_module} · ${run.run_id}` });
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
    new Setting(containerEl).setName("测试连接").addButton((button) => button.setButtonText("测试").onClick(async () => {
      const result = await this.plugin.client.invoke("getModules", {});
      new Notice(result.ok ? "KnowledgeOS Core 连接正常" : result.error?.message || "连接失败");
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
    this.addRibbonIcon("calendar-check", "打开 KnowledgeOS Today", () => this.activateToday());
    this.addRibbonIcon("plus-circle", "Quick Capture", () => this.openCapture());
    this.addRibbonIcon("clipboard-check", "打开 Review Center", () => this.activateReviews());
    this.addRibbonIcon("inbox", "打开 Inbox Center", () => this.activateInbox());
    this.addCommand({ id: "open-today", name: "Open Today", callback: () => this.activateToday() });
    this.addCommand({ id: "quick-capture", name: "Quick Capture", callback: () => this.openCapture() });
    this.addCommand({ id: "open-reviews", name: "Open Review Center", callback: () => this.activateReviews() });
    this.addCommand({ id: "open-inbox", name: "Open Inbox Center", callback: () => this.activateInbox() });
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
        for (const type of [VIEW_TYPE, INBOX_VIEW_TYPE]) {
          for (const leaf of this.app.workspace.getLeavesOfType(type)) leaf.view.refresh();
        }
      }, 1500);
    }));
    if (this.settings.openTodayOnStartup) this.app.workspace.onLayoutReady(() => this.activateToday());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.client.settings = this.settings;
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
};
