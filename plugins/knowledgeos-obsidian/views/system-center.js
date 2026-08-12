const { LatestRequestGate } = require("../services/latest-request");

function createSystemCenterViews(deps) {
  const { ItemView, Modal, Notice, PluginSettingTab, Setting, setIcon, VIEW_TYPE, REVIEW_VIEW_TYPE, INBOX_VIEW_TYPE, SYSTEM_VIEW_TYPE, settingsDefaults, moduleUiMetadata, manifestFormatters, LIST_PAGE_SIZE, FALLBACK_CODEX_MODELS, REASONING_LABELS, markLiveRegion, taskCycleChanged, shouldAutoRefreshPath, missingBuiltCliFailure, labelStatus, labelModule, labelJob, labelField, friendlyAction, calendarDayDifference, formatTime, formatVerificationSchedule, createTime, friendlyDashboardDescription, friendlyDashboardTitle, createToolbarButton, renderLoadingSkeleton, addCardArrow, renderDeveloperDetails, renderRecoverableError, displayJson, rollbackLabel, RollbackConfirmModal } = deps;
class RunDetailsModal extends Modal {
  constructor(app, plugin, runId, onChanged) {
    super(app); this.plugin = plugin; this.runId = runId; this.onChanged = onChanged;
    this.run = null; this.loadedAt = null; this.loading = false;
  }
  async onOpen() { await this.load(); }
  renderShell(loading = false) {
    const root = this.contentEl;
    root.empty(); root.addClass("knowledgeos-run-modal"); root.setAttr("aria-busy", String(loading));
    const header = root.createEl("header", { cls: "knowledgeos-modal-header" });
    header.createEl("h2", { text: "运行详情" });
    const refresh = createToolbarButton(header, "refresh-cw", "刷新运行详情", { iconOnly: true, cls: "knowledgeos-modal-refresh" });
    refresh.disabled = loading; refresh.onclick = () => this.load(true);
    return root.createEl("main", { cls: "knowledgeos-modal-body" });
  }
  async load(preserve = false) {
    if (this.loading) return;
    this.loading = true;
    const body = preserve && this.run ? null : this.renderShell(true);
    if (body) renderLoadingSkeleton(body, "正在加载运行详情…");
    else { this.contentEl.setAttr("aria-busy", "true"); const refresh = this.contentEl.querySelector(".knowledgeos-modal-refresh"); if (refresh) refresh.disabled = true; }
    const response = await this.plugin.client.invoke("getRunDetails", { run_id: this.runId, developer_mode: this.plugin.settings.developerMode });
    this.loading = false; this.contentEl.setAttr("aria-busy", "false");
    if (!response.ok) {
      if (preserve && this.run) this.renderStale(response.error);
      else this.renderFailure(response.error);
      return;
    }
    if (!response.data || typeof response.data !== "object") {
      const error = { message: "Core 返回的运行详情不完整。", impact: "没有执行撤销或其他操作。", recovery_actions: ["刷新运行详情"] };
      if (preserve && this.run) this.renderStale(error); else this.renderFailure(error);
      return;
    }
    const run = { ...response.data };
    const warnings = [];
    for (const key of ["affected_files", "operations", "reviews"]) if (!Array.isArray(run[key])) { run[key] = []; warnings.push(key); }
    if (!run.rollback || typeof run.rollback !== "object") {
      run.rollback = { level: "unavailable", can_rollback: false, requires_confirmation: false, reasons: ["无法确认此运行的恢复能力。"], changed_paths: [], later_dependent_runs: [] };
      warnings.push("rollback");
    }
    this.run = run; this.loadedAt = new Date().toISOString(); this.renderDetails(warnings);
  }
  renderFailure(error) {
    const body = this.renderShell();
    renderRecoverableError(body, "无法加载运行详情", error, () => this.load());
    const close = body.createEl("button", { text: "关闭" }); close.onclick = () => this.close();
  }
  renderStale(error) {
    this.contentEl.querySelector(".knowledgeos-modal-stale")?.remove();
    const body = this.contentEl.querySelector(".knowledgeos-modal-body");
    const state = markLiveRegion(body.createDiv({ cls: "knowledgeos-modal-stale" }));
    state.createSpan({ text: `显示的是上次成功加载的运行详情${this.loadedAt ? ` · ${formatTime(this.loadedAt)}` : ""}${error?.message ? `：${error.message}` : ""}` });
    const retry = state.createEl("button", { text: "重试" }); retry.onclick = () => this.load(true);
    body.prepend(state);
    const refresh = this.contentEl.querySelector(".knowledgeos-modal-refresh"); if (refresh) refresh.disabled = false;
  }
  renderDetails(warnings = []) {
    const run = this.run;
    const root = this.renderShell();
    const title = root.createEl("section", { cls: "knowledgeos-modal-title" });
    const titleRow = title.createDiv({ cls: "knowledgeos-modal-title-row" });
    titleRow.createEl("h3", { text: friendlyAction(run.source_action || run.input_summary || "Core operation", run.source_module) });
    titleRow.createSpan({ cls: `knowledgeos-status status-${run.status}`, text: labelStatus(run.status) });
    const subtitle = title.createDiv({ cls: "knowledgeos-modal-subtitle" });
    subtitle.createSpan({ text: `${labelModule(run.source_module)}${run.instance_id ? ` / ${run.instance_id}` : ""}` });
    if (run.completed_at) createTime(subtitle, run.completed_at, " · ");
    if (warnings.length) {
      const labels = { affected_files: "修改文件", operations: "执行操作", reviews: "审核", rollback: "恢复能力" };
      const partial = markLiveRegion(root.createDiv({ cls: "knowledgeos-modal-partial", text: `部分运行信息暂时不可用：${warnings.map((key) => labels[key] || key).join("、")}。` }));
    }
    if (run.error_summary) {
      const error = root.createEl("section", { cls: "knowledgeos-modal-alert is-error", attr: { role: "alert" } });
      error.createEl("strong", { text: "这次运行未成功完成" });
      error.createDiv({ text: run.error_summary });
    }
    if (run.input_summary && run.input_summary !== run.source_action) root.createEl("p", { cls: "knowledgeos-modal-intro", text: run.input_summary });

    if (run.explanation_chain) {
      const explanation = root.createEl("section", { cls: "knowledgeos-modal-section" });
      explanation.createEl("h4", { text: "为什么系统这样做" });
      const chain = run.explanation_chain;
      const steps = [
        ["触发", chain.trigger?.reason], ["输入", `${(chain.inputs || []).length} 个文件`],
        ["判断", `${chain.decision?.module || "core"} / ${chain.decision?.workflow || "deterministic"}`],
        ["风险", `${(chain.decision?.risks || []).map((item) => item.risk).join("、") || "无写入"}`],
        ["审核", chain.review?.review_id || (chain.review?.created ? "已创建" : "无需审核")],
        ["执行", `${(chain.execution?.operations || []).filter((item) => item.status === "completed").length} 个操作完成`],
        ["变更", `${(chain.changes || []).length} 条 Change Record`],
      ];
      const list = explanation.createEl("ol", { cls: "knowledgeos-explanation-chain" });
      for (const [label, value] of steps) {
        const item = list.createEl("li");
        item.createEl("strong", { text: label });
        item.createSpan({ text: value || "未记录" });
      }
    }

    const files = root.createEl("section", { cls: "knowledgeos-modal-section" });
    files.createEl("h4", { text: `修改文件 (${run.affected_files.length})` });
    if (!run.affected_files.length) files.createDiv({ cls: "knowledgeos-modal-empty", text: "这次运行没有修改 Vault 文件。" });
    else {
      const list = files.createDiv({ cls: "knowledgeos-modal-list" });
      for (const file of run.affected_files) {
        const row = list.createEl("article", { cls: "knowledgeos-modal-row" });
        const button = row.createEl("button", { cls: "knowledgeos-link knowledgeos-modal-file", text: file.path.split("/").pop() || file.path });
        button.onclick = () => this.app.workspace.openLinkText(file.path, "", false);
        row.createDiv({ cls: "knowledgeos-modal-row-meta", text: file.path });
      }
    }
    const operations = root.createEl("section", { cls: "knowledgeos-modal-section" });
    operations.createEl("h4", { text: `执行操作 (${run.operations.length})` });
    if (!run.operations.length) operations.createDiv({ cls: "knowledgeos-modal-empty", text: "这次运行没有需要执行的写入操作。" });
    else {
      const list = operations.createDiv({ cls: "knowledgeos-modal-list" });
      for (const operation of run.operations) {
        const row = list.createEl("article", { cls: `knowledgeos-modal-row status-${operation.status}` });
        const heading = row.createDiv({ cls: "knowledgeos-modal-row-heading" });
        heading.createEl("strong", { text: operation.type });
        heading.createSpan({ cls: `knowledgeos-status status-${operation.status}`, text: labelStatus(operation.status) });
        if (operation.target) row.createDiv({ cls: "knowledgeos-modal-row-meta", text: operation.target });
        if (operation.risk) row.createDiv({ cls: "knowledgeos-modal-row-description", text: `风险：${operation.risk}` });
        if (operation.error) row.createDiv({ cls: "knowledgeos-modal-row-description knowledgeos-error-text", text: operation.error });
      }
    }
    if (run.reviews.length) {
      const reviews = root.createEl("section", { cls: "knowledgeos-modal-section" });
      reviews.createEl("h4", { text: `创建审核 (${run.reviews.length})` });
      const list = reviews.createDiv({ cls: "knowledgeos-modal-list" });
      for (const review of run.reviews) {
        const row = list.createEl("article", { cls: "knowledgeos-modal-row" });
      const button = row.createEl("button", { cls: "knowledgeos-link", text: friendlyAction(review.action, review.source_module) });
        button.onclick = () => { this.close(); this.plugin.activateReviews(review.review_id); };
        row.createDiv({ cls: "knowledgeos-modal-row-meta", text: review.review_id });
      }
    }
    const recovery = root.createEl("section", { cls: "knowledgeos-modal-section" });
    recovery.createEl("h4", { text: "恢复能力" });
    const assessment = recovery.createDiv({ cls: `knowledgeos-modal-alert rollback-${run.rollback.level}` });
    assessment.createEl("strong", { text: rollbackLabel(run.rollback) });
    for (const reason of run.rollback.reasons || []) assessment.createDiv({ text: reason });
    if (run.rollback.changed_paths?.length) assessment.createDiv({ text: `已变化：${run.rollback.changed_paths.join("、")}` });
    if (run.rollback.later_dependent_runs?.length) assessment.createDiv({ text: `后续关联运行：${run.rollback.later_dependent_runs.join("、")}` });
    assessment.createDiv({ cls: "knowledgeos-modal-row-meta", text: `Git 快照：${run.git_snapshot || "无"}` });

    if (this.plugin.settings.developerMode && run.developer) {
      const details = root.createEl("details", { cls: "knowledgeos-modal-disclosure knowledgeos-modal-technical" });
      details.createEl("summary", { text: "开发者数据" });
      details.createEl("pre", { text: displayJson(run.developer) });
    }
    renderDeveloperDetails(root, this.plugin, [["Run ID", run.run_id], ["Task ID", run.task_id], ["Plan ID", run.plan_id]]);
    const actions = root.createDiv({ cls: "knowledgeos-modal-actions" });
    const rollback = actions.createEl("button", { cls: run.rollback.requires_confirmation ? "mod-warning" : "", text: rollbackLabel(run.rollback) });
    rollback.disabled = !run.rollback.can_rollback;
    if (!run.rollback.can_rollback) rollback.setAttr("aria-describedby", "knowledgeos-run-rollback-reason");
    rollback.onclick = () => {
      this.close();
      new RollbackConfirmModal(this.app, this.plugin, run, async () => { await this.onChanged(); }).open();
    };
    if (!run.rollback.can_rollback) actions.createSpan({ cls: "knowledgeos-modal-disabled-reason", attr: { id: "knowledgeos-run-rollback-reason" }, text: "当前运行无法自动撤销" });
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
    root.addClass("knowledgeos-review-modal"); root.addClass("knowledgeos-lifecycle-modal");
    root.createEl("h2", { text: this.title });
    const validTransition = Boolean(this.preview?.current_status && this.preview?.target_status);
    const transition = root.createEl("section", { cls: "knowledgeos-modal-title" });
    transition.createDiv({ cls: "knowledgeos-lifecycle-transition", text: validTransition ? `${labelStatus(this.preview.current_status)} → ${labelStatus(this.preview.target_status)}` : "状态变化暂不可用" });
    if (!validTransition) {
      const error = root.createEl("section", { cls: "knowledgeos-modal-alert is-error", attr: { role: "alert" } });
      error.createEl("strong", { text: "无法确认生命周期变化" });
      error.createDiv({ text: "Core 返回的预览缺少当前状态或目标状态。" });
    }
    const effectsSection = root.createEl("section", { cls: "knowledgeos-modal-section" });
    effectsSection.createEl("h4", { text: "执行后会发生什么" });
    const effects = Array.isArray(this.preview?.effects) ? this.preview.effects : [];
    if (effects.length) {
      const list = effectsSection.createEl("ul", { cls: "knowledgeos-lifecycle-effects" });
      for (const effect of effects) list.createEl("li", { text: effect });
    } else effectsSection.createDiv({ cls: "knowledgeos-modal-empty", text: "没有其他已知影响。" });
    if (this.preview.impact) {
      const impactSection = root.createEl("section", { cls: "knowledgeos-modal-section" });
      impactSection.createEl("h4", { text: "影响范围" });
      const impact = impactSection.createEl("dl", { cls: "knowledgeos-modal-facts" });
      if (this.preview.impact.active_instance_count !== undefined) this.renderFact(impact, "活跃实例", this.preview.impact.active_instance_count);
      if (this.preview.impact.inbox_count !== undefined) this.renderFact(impact, "未处理 Inbox", this.preview.impact.inbox_count);
      if (this.preview.impact.pending_review_count !== undefined) this.renderFact(impact, "待审核", this.preview.impact.pending_review_count);
      this.renderFact(impact, "用户数据", this.preview.impact.data_deleted ? "会删除数据" : "不会删除用户数据", this.preview.impact.data_deleted);
    }
    const risky = this.preview.requires_confirmation || this.preview.impact?.data_deleted;
    const confirmation = root.createEl("section", { cls: `knowledgeos-modal-alert ${risky ? "is-warning" : "is-success"}` });
    confirmation.createEl("strong", { text: risky ? "请确认上述影响" : "可以执行此状态变化" });
    confirmation.createDiv({ text: this.preview.impact?.data_deleted ? "此操作会删除数据，请在继续前确认影响。" : "Core 会在执行前创建快照，不会删除用户数据。" });
    this.statusEl = markLiveRegion(root.createDiv({ cls: "knowledgeos-modal-submit-state" }));
    const actions = root.createDiv({ cls: "knowledgeos-modal-actions" });
    this.confirmButton = actions.createEl("button", { cls: risky ? "mod-warning" : "mod-cta", text: "确认执行" });
    this.confirmButton.disabled = !validTransition;
    this.confirmButton.onclick = () => this.submit();
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.onclick = () => this.close();
  }
  async submit() {
    this.confirmButton.disabled = true;
    this.contentEl.setAttr("aria-busy", "true");
    this.statusEl.removeClass("is-error"); this.statusEl.removeClass("is-stale");
    this.statusEl.setText("Core 正在创建快照并执行生命周期变更…");
    const response = await this.plugin.client.invoke(this.method, { ...this.params, confirm: true });
    this.confirmButton.disabled = false;
    this.contentEl.setAttr("aria-busy", "false");
    if (!response.ok) {
      this.statusEl.addClass("is-error");
      if (["INSTANCE_TRANSITION_INVALID", "INSTANCE_CONFIRMATION_REQUIRED", "MODULE_CONFIRMATION_REQUIRED"].includes(response.error?.code)) this.statusEl.addClass("is-stale");
      this.statusEl.setText(response.error?.message || "生命周期操作失败");
      return;
    }
    this.plugin.notify(`状态已更新为 ${response.data.status}`);
    this.close();
    await this.onComplete();
  }
  renderFact(root, label, value, danger = false) {
    const item = root.createDiv({ cls: `knowledgeos-modal-fact${danger ? " is-danger" : ""}` });
    item.createEl("dt", { text: label }); item.createEl("dd", { text: String(value) });
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
  constructor(app, plugin, taskId, onChanged) {
    super(app); this.plugin = plugin; this.taskId = taskId; this.onChanged = onChanged;
    this.details = null; this.loadedAt = null; this.loading = false;
  }
  async onOpen() { await this.load(); }
  renderShell(loading = false) {
    const root = this.contentEl;
    root.empty(); root.addClass("knowledgeos-run-modal"); root.addClass("knowledgeos-task-modal");
    root.setAttr("aria-busy", String(loading));
    const header = root.createEl("header", { cls: "knowledgeos-modal-header" });
    header.createEl("h2", { text: "任务详情" });
    const refresh = createToolbarButton(header, "refresh-cw", "刷新任务详情", { iconOnly: true, cls: "knowledgeos-modal-refresh" });
    refresh.disabled = loading;
    refresh.onclick = () => this.load(true);
    return root.createEl("main", { cls: "knowledgeos-modal-body" });
  }
  async load(preserve = false) {
    if (this.loading) return;
    this.loading = true;
    const body = preserve && this.details ? null : this.renderShell(true);
    if (body) renderLoadingSkeleton(body, "正在加载任务详情…");
    else { this.contentEl.setAttr("aria-busy", "true"); const refresh = this.contentEl.querySelector(".knowledgeos-modal-refresh"); if (refresh) refresh.disabled = true; }
    const response = await this.plugin.client.invoke("getTaskDetails", { task_id: this.taskId });
    this.loading = false;
    this.contentEl.setAttr("aria-busy", "false");
    if (!response.ok) {
      if (preserve && this.details) this.renderStale(response.error);
      else this.renderFailure(response.error);
      return;
    }
    if (!response.data?.task) {
      const error = { message: "Core 返回的任务详情不完整。", impact: "没有执行任何任务操作。", recovery_actions: ["刷新任务详情"] };
      if (preserve && this.details) this.renderStale(error);
      else this.renderFailure(error);
      return;
    }
    const warnings = [];
    const details = { ...response.data };
    if (!Array.isArray(details.runs)) { details.runs = []; warnings.push("运行历史"); }
    if (!Array.isArray(details.codex_invocations)) { details.codex_invocations = []; warnings.push("Codex 调用"); }
    this.details = details;
    this.loadedAt = new Date().toISOString();
    this.renderDetails(warnings);
  }
  renderFailure(error) {
    const body = this.renderShell();
    renderRecoverableError(body, "无法加载任务详情", error, () => this.load());
    const close = body.createEl("button", { text: "关闭" }); close.onclick = () => this.close();
  }
  renderStale(error) {
    this.contentEl.querySelector(".knowledgeos-modal-stale")?.remove();
    const body = this.contentEl.querySelector(".knowledgeos-modal-body");
    const state = markLiveRegion(body.createDiv({ cls: "knowledgeos-modal-stale" }));
    state.createSpan({ text: `显示的是上次成功加载的任务详情${this.loadedAt ? ` · ${formatTime(this.loadedAt)}` : ""}${error?.message ? `：${error.message}` : ""}` });
    const retry = state.createEl("button", { text: "重试" }); retry.onclick = () => this.load(true);
    body.prepend(state);
    const refresh = this.contentEl.querySelector(".knowledgeos-modal-refresh"); if (refresh) refresh.disabled = false;
  }
  renderDetails(warnings = []) {
    const task = this.details.task;
    const body = this.renderShell();
    const title = body.createEl("section", { cls: "knowledgeos-modal-title" });
    const titleRow = title.createDiv({ cls: "knowledgeos-modal-title-row" });
    titleRow.createEl("h3", { text: labelJob(task.job_id, task.module) });
    titleRow.createSpan({ cls: `knowledgeos-status status-${task.status}`, text: labelStatus(task.status) });
    title.createDiv({ cls: "knowledgeos-modal-subtitle", text: `${labelModule(task.module)}${task.instance_id ? ` / ${task.instance_id}` : ""}` });
    if (warnings.length) this.renderPartial(body, `部分任务信息暂时不可用：${warnings.join("、")}。`);
    if (task.last_error) {
      const error = body.createEl("section", { cls: "knowledgeos-modal-alert is-error", attr: { "aria-label": "最近错误" } });
      error.createEl("strong", { text: "最近一次执行未成功" });
      error.createDiv({ text: `${task.last_error.code || "任务错误"}：${task.last_error.message}` });
    }
    const factsSection = body.createEl("section", { cls: "knowledgeos-modal-section" });
    factsSection.createEl("h4", { text: "执行信息" });
    const facts = factsSection.createEl("dl", { cls: "knowledgeos-modal-facts" });
    this.renderFact(facts, "计划时间", task.scheduled_for || "暂不可用", true);
    this.renderFact(facts, "尝试次数", `${task.attempt_count ?? "暂不可用"}/${task.max_attempts ?? "暂不可用"}`);
    this.renderFact(facts, "优先级", task.priority || "暂不可用");
    this.renderFact(facts, "触发方式", task.trigger?.type || "暂不可用");
    const resourcesSection = body.createEl("section", { cls: "knowledgeos-modal-section" });
    resourcesSection.createEl("h4", { text: "所需资源" });
    const resources = resourcesSection.createEl("dl", { cls: "knowledgeos-modal-facts" });
    for (const [key, label] of [["filesystem", "文件系统"], ["network", "网络"], ["codex", "Codex"], ["user", "用户"]]) this.renderFact(resources, label, task.resources?.[key] || "暂不可用");
    if (task.payload?.source_file) {
      const sourceSection = body.createEl("section", { cls: "knowledgeos-modal-section" });
      sourceSection.createEl("h4", { text: "关联内容" });
      const source = sourceSection.createEl("button", { cls: "knowledgeos-link knowledgeos-modal-file", text: task.payload.source_file.split("/").pop() || task.payload.source_file });
      source.onclick = () => this.app.workspace.openLinkText(task.payload.source_file, "", false);
      renderDeveloperDetails(sourceSection, this.plugin, [["Vault 路径", task.payload.source_file]]);
    }
    const runsSection = body.createEl("section", { cls: "knowledgeos-modal-section" });
    runsSection.createEl("h4", { text: `运行历史 (${this.details.runs.length})` });
    if (!this.details.runs.length) this.renderSectionEmpty(runsSection, "这个任务尚未开始执行。");
    else {
      const list = runsSection.createDiv({ cls: "knowledgeos-modal-list" });
      for (const run of [...this.details.runs].reverse()) {
        const row = list.createEl("article", { cls: `knowledgeos-modal-row status-${run.status}` });
        const heading = row.createDiv({ cls: "knowledgeos-modal-row-heading" });
        heading.createEl("strong", { text: `第 ${run.attempt_number} 次尝试` });
        heading.createSpan({ cls: `knowledgeos-status status-${run.status}`, text: labelStatus(run.status) });
        if (run.started_at) createTime(row.createDiv({ cls: "knowledgeos-modal-row-meta" }), run.started_at, "开始于 ");
        if (run.error?.message) row.createDiv({ cls: "knowledgeos-modal-row-description knowledgeos-error-text", text: run.error.message });
      }
    }
    if (this.details.codex_invocations.length) {
      const calls = body.createEl("details", { cls: "knowledgeos-modal-disclosure" });
      calls.createEl("summary", { text: `Codex 调用 (${this.details.codex_invocations.length})` });
      const list = calls.createDiv({ cls: "knowledgeos-modal-list" });
      for (const call of this.details.codex_invocations) {
        const row = list.createEl("article", { cls: "knowledgeos-modal-row" });
        row.createEl("strong", { text: `${call.prompt_id || "未知 Prompt"}@${call.prompt_version || "unknown"}` });
        row.createDiv({ cls: "knowledgeos-modal-row-meta", text: `${call.model || call.adapter || "unknown"} · ${labelStatus(call.status)}` });
      }
    }
    renderDeveloperDetails(body, this.plugin, [["Task ID", task.task_id], ["Job ID", task.job_id]]);
    const actions = body.createDiv({ cls: "knowledgeos-modal-actions" });
    if (["failed", "waiting-for-network", "waiting-for-ai", "waiting-for-user", "deferred", "interrupted"].includes(task.status)) this.actionButton(actions, "重试", "retry");
    if (!["completed", "cancelled"].includes(task.status)) {
      if (task.priority !== "high") this.actionButton(actions, "提升为高优先级", "set-priority", { priority: "high" });
      if (task.priority !== "normal") this.actionButton(actions, "恢复普通优先级", "set-priority", { priority: "normal" });
      this.actionButton(actions, "延后一天", "defer", { defer_until: new Date(Date.now() + 86_400_000).toISOString() });
      this.actionButton(actions, task.status === "running" ? "请求取消" : "取消", "cancel", {}, "mod-warning");
    }
    const close = actions.createEl("button", { text: "关闭" }); close.onclick = () => this.close();
  }
  renderPartial(root, text) { const state = markLiveRegion(root.createDiv({ cls: "knowledgeos-modal-partial", text })); return state; }
  renderSectionEmpty(root, text) { root.createDiv({ cls: "knowledgeos-modal-empty", text }); }
  renderFact(root, label, value, time = false) {
    const item = root.createDiv({ cls: "knowledgeos-modal-fact" });
    item.createEl("dt", { text: label });
    const description = item.createEl("dd");
    if (time && value !== "暂不可用") createTime(description, value);
    else description.setText(String(value));
  }
  actionButton(root, label, action, extra = {}, cls = "") {
    const button = root.createEl("button", { cls, text: label });
    button.onclick = async () => {
      button.disabled = true;
      const response = await this.plugin.client.invoke("manageTask", { task_id: this.taskId, action, ...extra });
      if (!response.ok) { button.disabled = false; this.plugin.notify(response.error?.message || "任务操作失败", { error: true }); return; }
      this.plugin.notify(`任务已更新为 ${response.data.status}`);
      this.close(); await this.onChanged();
    };
  }
}

class LegacyAccessPolicyMigrationModal extends Modal {
  constructor(app, plugin, onChanged) {
    super(app); this.plugin = plugin; this.onChanged = onChanged; this.preview = null; this.reviewed = new Set(); this.loading = false;
  }
  async onOpen() { await this.loadPreview(); }
  shell() {
    const root = this.contentEl; root.empty(); root.addClass("knowledgeos-lifecycle-modal"); root.addClass("knowledgeos-access-migration-modal");
    root.createEl("h2", { text: "迁移旧访问策略" });
    return root.createDiv({ cls: "knowledgeos-modal-body" });
  }
  async loadPreview() {
    if (this.loading) return; this.loading = true;
    const body = this.shell(); this.contentEl.setAttr("aria-busy", "true"); renderLoadingSkeleton(body, "正在扫描旧 read_level 文件…");
    const response = await this.plugin.client.invoke("migrateLegacyAccessPolicies", { action: "preview" });
    this.loading = false; this.contentEl.setAttr("aria-busy", "false");
    if (!response.ok) { renderRecoverableError(body, "无法创建迁移预览", response.error, () => this.loadPreview()); return; }
    this.preview = response.data; this.renderPreview();
  }
  renderPreview() {
    const body = this.shell(); const candidates = Array.isArray(this.preview?.candidates) ? this.preview.candidates : [];
    body.createEl("p", { cls: "knowledgeos-modal-intro", text: "迁移会将旧的 read_level 拆分为隐私敏感度和允许读取范围。扫描本身不会修改任何文件。" });
    if (!candidates.length) {
      const empty = body.createDiv({ cls: "knowledgeos-modal-empty" }); empty.createEl("strong", { text: "没有待迁移的旧访问策略" }); empty.createDiv({ text: "当前 Vault 没有发现 legacy read_level 文件或附件 Sidecar。" });
      const close = body.createEl("button", { text: "关闭" }); close.onclick = () => this.close(); return;
    }
    const sensitive = candidates.filter((candidate) => candidate.requires_review);
    const facts = body.createEl("dl", { cls: "knowledgeos-modal-facts" });
    this.fact(facts, "待迁移", candidates.length); this.fact(facts, "需要逐项确认", sensitive.length); this.fact(facts, "可自动迁移", candidates.filter((candidate) => candidate.migratable).length);
    if (sensitive.length) {
      const review = body.createEl("section", { cls: "knowledgeos-modal-section" }); review.createEl("h4", { text: "敏感目录需要确认" });
      review.createDiv({ cls: "knowledgeos-modal-row-description", text: "Journal、Private、Medical、Identity 等目录默认迁移为「高度敏感 / 仅元数据」。确认每一项后才能应用迁移。" });
      const list = review.createDiv({ cls: "knowledgeos-modal-list" });
      for (const candidate of sensitive) {
        const row = list.createEl("label", { cls: "knowledgeos-modal-row knowledgeos-access-migration-review" });
        const check = row.createEl("input", { type: "checkbox" }); check.checked = this.reviewed.has(candidate.path);
        check.onchange = () => { if (check.checked) this.reviewed.add(candidate.path); else this.reviewed.delete(candidate.path); apply.disabled = this.reviewed.size !== sensitive.length; };
        row.createSpan({ text: candidate.path }); row.createDiv({ cls: "knowledgeos-modal-row-meta", text: "迁移后：高度敏感 · 仅元数据" });
      }
    }
    const disclosure = body.createEl("details", { cls: "knowledgeos-modal-disclosure" }); disclosure.createEl("summary", { text: `查看全部候选文件（${candidates.length}）` });
    const candidateList = disclosure.createDiv({ cls: "knowledgeos-modal-list" });
    for (const candidate of candidates) {
      const row = candidateList.createDiv({ cls: "knowledgeos-modal-row" }); row.createEl("strong", { text: candidate.path });
      row.createDiv({ cls: "knowledgeos-modal-row-meta", text: `${candidate.kind === "sidecar" ? "附件 Sidecar" : "Markdown"} · ${candidate.requires_review ? "需确认" : "可迁移"}` });
    }
    const status = markLiveRegion(body.createDiv({ cls: "knowledgeos-modal-submit-state" }));
    const actions = body.createDiv({ cls: "knowledgeos-modal-actions" });
    const apply = actions.createEl("button", { cls: "mod-cta", text: "应用迁移" }); apply.disabled = this.reviewed.size !== sensitive.length;
    apply.onclick = async () => {
      if (!window.confirm(`将更新 ${candidates.length} 个旧访问策略。系统会先创建 Git 快照，并保留可撤销备份。是否继续？`)) return;
      apply.disabled = true; status.setText("正在创建快照并迁移访问策略…");
      const response = await this.plugin.client.invoke("migrateLegacyAccessPolicies", { action: "apply", preview_id: this.preview.migration_id, reviewed_paths: [...this.reviewed], confirm: true });
      if (!response.ok) { status.addClass("is-error"); status.setText(response.error?.message || "迁移失败"); apply.disabled = false; return; }
      this.plugin.notify(`已迁移 ${response.data.changed} 个旧访问策略`); this.close(); await this.onChanged();
    };
    const cancel = actions.createEl("button", { text: "取消" }); cancel.onclick = () => this.close();
  }
  fact(root, label, value) { const item = root.createDiv({ cls: "knowledgeos-modal-fact" }); item.createEl("dt", { text: label }); item.createEl("dd", { text: String(value) }); }
}

class SystemCenterView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.data = null;
    this.refreshPromise = null;
    this.refreshQueued = false;
    this.backgroundStatus = null;
    this.activeSection = "overview";
    this.sectionData = new Map();
    this.sectionFetchedAt = new Map();
    this.sectionWarnings = new Map();
    this.refreshGate = new LatestRequestGate();
  }
  getViewType() { return SYSTEM_VIEW_TYPE; }
  getDisplayText() { return "KnowledgeOS System"; }
  getIcon() { return "activity"; }
  async onOpen() { await this.refresh(); }

  async refresh(options = {}) {
    this.refreshGate.request();
    const background = options.background === true;
    if (options.preserveCache !== true) this.sectionData.clear();
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
    const section = this.activeSection;
    const currentData = this.data?.section === section ? this.data : this.sectionData.get(section);
    const preserveContent = Boolean(currentData && this.contentEl.childElementCount > 0);
    this.contentEl.setAttr("aria-busy", "true");
    if (preserveContent) this.renderBackgroundStatus("更新中…");
    else this.renderLoading();
    const response = await this.plugin.client.invoke("getSystemCenterSnapshot", {
      section, ...(["tasks", "history"].includes(section) ? { page_size: section === "tasks" ? LIST_PAGE_SIZE : 20 } : {}),
    });
    if (!this.refreshGate.isCurrent(generation)) return;
    this.contentEl.removeAttribute("aria-busy");
    if (!response.ok) {
      if (preserveContent) this.renderStaleStatus(response.error);
      else this.renderFailure(response.error);
      return;
    }
    if (Array.isArray(response.data?.modules)) moduleUiMetadata.update(response.data.modules);
    const normalized = this.normalizeSectionData(section, response.data);
    if (!normalized) {
      const error = { message: "Core 返回的分区数据缺少必要内容。", impact: "上次成功取得的系统状态没有被替换。", recovery_actions: ["重试加载当前分区"] };
      if (preserveContent) this.renderStaleStatus(error);
      else this.renderFailure(error);
      return;
    }
    this.sectionData.set(section, normalized);
    this.sectionFetchedAt.set(section, new Date().toISOString());
    if (this.activeSection === section) {
      this.data = normalized;
      this.render();
    }
  }

  async openSection(section) {
    if (this.activeSection === section) return;
    this.activeSection = section;
    this.refreshGate.request();
    const cached = this.sectionData.get(section);
    if (cached) {
      this.data = cached;
      this.render();
      return;
    }
    this.data = null;
    await this.refresh({ background: true, preserveCache: true });
  }

  async loadNextPage(button) {
    const section = this.activeSection;
    const cursor = this.data?.page?.next_cursor;
    if (!cursor || !["tasks", "history"].includes(section)) return;
    const generation = this.refreshGate.request();
    button.disabled = true;
    button.setText("正在加载…");
    const response = await this.plugin.client.invoke("getSystemCenterSnapshot", {
      section, page_size: section === "tasks" ? LIST_PAGE_SIZE : 20, cursor,
    });
    if (!this.refreshGate.isCurrent(generation) || this.activeSection !== section) return;
    if (!response.ok) {
      button.disabled = false;
      button.setText("重试加载更多");
      this.plugin.notify(response.error?.message || "无法加载下一页", { error: true });
      return;
    }
    const next = this.normalizeSectionData(section, response.data);
    if (!next) { button.disabled = false; button.setText("重试加载更多"); return; }
    const key = section === "tasks" ? "tasks" : "runs";
    const id = section === "tasks" ? "task_id" : "run_id";
    const merged = new Map([...(this.data[key] || []), ...(next[key] || [])].map((item) => [item[id], item]));
    next[key] = [...merged.values()];
    this.data = next;
    this.sectionData.set(section, next);
    this.sectionFetchedAt.set(section, new Date().toISOString());
    this.render();
  }

  renderBackgroundStatus(text, failed = false, retry = false) {
    this.backgroundStatus?.remove();
    const status = markLiveRegion(this.contentEl.createDiv({ cls: `knowledgeos-system-refresh-state${failed ? " is-error is-stale" : ""}` }));
    status.createSpan({ text });
    if (retry) {
      const button = status.createEl("button", { text: "重试" });
      button.onclick = () => this.refresh();
    }
    const body = this.contentEl.querySelector(".knowledgeos-system-body");
    if (body) this.contentEl.insertBefore(status, body);
    else this.contentEl.prepend(status);
    const refresh = this.contentEl.querySelector(".knowledgeos-system-refresh");
    if (refresh) refresh.disabled = !failed;
    this.backgroundStatus = status;
  }

  renderStaleStatus(error) {
    const updated = this.sectionFetchedAt.get(this.activeSection);
    const reason = error?.message ? `：${error.message}` : "";
    this.renderBackgroundStatus(`显示的是上次成功取得的系统状态${updated ? ` · ${formatTime(updated)}` : ""}${reason}`, true, true);
  }

  openDetails(openRunId = null, openTaskId = null) {
    if (openRunId) new RunDetailsModal(this.app, this.plugin, openRunId, () => this.refresh()).open();
    if (openTaskId) new TaskDetailsModal(this.app, this.plugin, openTaskId, () => this.refresh()).open();
  }

  renderFailure(error) {
    const body = this.renderShell();
    const failure = body.createDiv({ cls: "knowledgeos-system-failure" });
    renderRecoverableError(failure, "System Center 暂时不可用", error, () => this.refresh());
  }

  normalizeSectionData(section, snapshot) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
    const normalized = { ...snapshot, section };
    const warnings = [];
    const requireObject = (key) => normalized[key] && typeof normalized[key] === "object" && !Array.isArray(normalized[key]);
    const requireArray = (key) => Array.isArray(normalized[key]);
    const normalizeRuntime = () => {
      normalized.runtime = { ...normalized.runtime };
      if (!normalized.runtime.counts || typeof normalized.runtime.counts !== "object") { normalized.runtime.counts = {}; warnings.push("runtime counts"); }
      if (!Array.isArray(normalized.runtime.jobs)) { normalized.runtime.jobs = []; warnings.push("scheduled jobs"); }
    };
    const normalizeInbox = () => {
      if (!requireObject("inbox")) { normalized.inbox = { items: [], counts: { total: 0 } }; warnings.push("inbox"); return; }
      normalized.inbox = { ...normalized.inbox };
      if (!Array.isArray(normalized.inbox.items)) { normalized.inbox.items = []; warnings.push("inbox items"); }
      if (!normalized.inbox.counts || typeof normalized.inbox.counts !== "object") { normalized.inbox.counts = { total: normalized.inbox.items.length }; warnings.push("inbox counts"); }
    };
    if (section === "overview") {
      if (!requireObject("runtime") || !requireObject("quality") || !normalized.quality?.overview) return null;
      normalizeRuntime();
      normalized.quality = { ...normalized.quality, overview: { ...normalized.quality.overview } };
      for (const key of ["tasks", "reviews", "modules", "instances", "runs"]) if (!requireArray(key)) { normalized[key] = []; warnings.push(key); }
      normalizeInbox();
    }
    if (section === "tasks") {
      if (!requireArray("tasks") || !requireObject("runtime")) return null;
      normalizeRuntime();
      if (!requireObject("page")) normalized.page = { has_more: false, next_cursor: null };
    }
    if (section === "quality") {
      if (!requireObject("quality") || !normalized.quality?.overview) return null;
      normalized.quality = { ...normalized.quality, overview: { ...normalized.quality.overview } };
      for (const key of ["freshness", "provenance", "reviews", "links_ownership", "schemas_migrations", "ai_quality"]) {
        if (!normalized.quality[key] || typeof normalized.quality[key] !== "object" || Array.isArray(normalized.quality[key])) { normalized.quality[key] = {}; warnings.push(key); }
      }
      if (!Array.isArray(normalized.quality.audit_history)) { normalized.quality.audit_history = []; warnings.push("audit history"); }
    }
    if (section === "modules") {
      if (!requireArray("modules") || !requireArray("instances")) return null;
      for (const key of ["reviews", "runs"]) if (!requireArray(key)) { normalized[key] = []; warnings.push(key); }
      normalizeInbox();
    }
    if (section === "history") {
      if (!requireArray("runs")) return null;
      if (!requireObject("page")) normalized.page = { has_more: false, next_cursor: null };
    }
    this.sectionWarnings.set(section, [...new Set(warnings)]);
    return normalized;
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

  renderPageHeader(root, loading = false) {
    const header = root.createDiv({ cls: "knowledgeos-page-header knowledgeos-system-header" });
    const heading = header.createDiv({ cls: "knowledgeos-system-heading" });
    const titleRow = heading.createDiv({ cls: "knowledgeos-title-row" });
    const titleIcon = titleRow.createSpan({ cls: "knowledgeos-title-icon", attr: { "aria-hidden": "true" } }); setIcon(titleIcon, "activity");
    titleRow.createEl("h2", { text: "系统中心" });
    heading.createDiv({ cls: "knowledgeos-page-subtitle", text: "自动化、知识质量与模块状态" });
    const fetchedAt = this.sectionFetchedAt.get(this.activeSection);
    if (fetchedAt) createTime(heading.createDiv({ cls: "knowledgeos-system-updated" }), fetchedAt, "更新于 ");
    const headerActions = header.createDiv({ cls: "knowledgeos-header-actions" });
    const refresh = createToolbarButton(headerActions, "refresh-cw", "刷新", { iconOnly: true, cls: "knowledgeos-system-refresh" });
    refresh.disabled = loading;
    refresh.onclick = () => this.refresh();
  }

  renderNavigation(root) {
    const navigation = root.createEl("nav", { cls: "knowledgeos-system-nav", attr: { role: "tablist", "aria-label": "系统中心导航" } });
    const sections = [["overview", "概览", "layout-dashboard"], ["tasks", "任务", "list-checks"], ["quality", "知识质量", "shield-check"], ["modules", "模块与实例", "boxes"], ["history", "运行历史", "history"]];
    sections.forEach(([id, label, icon], index) => {
      const button = navigation.createEl("button", { cls: this.activeSection === id ? "is-active" : "", attr: { id: `knowledgeos-system-tab-${id}`, role: "tab", "aria-controls": `knowledgeos-system-panel-${id}`, "aria-selected": String(this.activeSection === id), tabindex: this.activeSection === id ? "0" : "-1" } });
      setIcon(button, icon);
      button.createSpan({ text: label });
      button.onclick = () => { void this.openSection(id); };
      button.onkeydown = (event) => {
        const keys = { ArrowRight: index + 1, ArrowDown: index + 1, ArrowLeft: index - 1, ArrowUp: index - 1, Home: 0, End: sections.length - 1 };
        if (!(event.key in keys)) return;
        event.preventDefault();
        const nextIndex = (keys[event.key] + sections.length) % sections.length;
        const nextSection = sections[nextIndex][0];
        void this.openSection(nextSection).then(() => this.contentEl.querySelector(`#knowledgeos-system-tab-${nextSection}`)?.focus());
      };
    });
  }

  renderShell(loading = false) {
    const root = this.contentEl;
    root.empty();
    this.backgroundStatus = null;
    root.addClass("knowledgeos-system-center");
    this.renderPageHeader(root, loading);
    this.renderNavigation(root);
    return root.createEl("main", { cls: "knowledgeos-system-body", attr: { id: `knowledgeos-system-panel-${this.activeSection}`, role: "tabpanel", "aria-labelledby": `knowledgeos-system-tab-${this.activeSection}`, tabindex: "0" } });
  }

  renderLoading() {
    const body = this.renderShell(true);
    const labels = { overview: "正在检查系统状态…", tasks: "正在读取任务队列…", quality: "正在读取知识质量…", modules: "正在发现模块与实例…", history: "正在读取运行历史…" };
    const loading = body.createDiv({ cls: "knowledgeos-system-loading" });
    renderLoadingSkeleton(loading, labels[this.activeSection] || "正在加载…");
  }

  renderPartialState(root) {
    const warnings = this.sectionWarnings.get(this.activeSection) || [];
    if (!warnings.length) return;
    const labels = { tasks: "任务", reviews: "审核", modules: "模块", instances: "实例", runs: "运行历史", inbox: "Inbox", "runtime counts": "运行计数", "scheduled jobs": "自动计划", "inbox items": "Inbox 项目", "inbox counts": "Inbox 计数", freshness: "信息新鲜度", provenance: "来源与证据", links_ownership: "链接与归属", schemas_migrations: "数据结构", ai_quality: "AI 质量", "audit history": "审计历史" };
    const state = markLiveRegion(root.createDiv({ cls: "knowledgeos-system-partial" }));
    state.createSpan({ text: `部分系统信息暂时不可用：${warnings.map((key) => labels[key] || key).join("、")}。其他信息仍可查看。` });
    const retry = state.createEl("button", { text: "重试" });
    retry.onclick = () => this.refresh();
  }

  render() {
    const body = this.renderShell();
    this.renderPartialState(body);
    if (this.activeSection === "overview") this.renderOverview(body);
    if (this.activeSection === "tasks") this.renderTasks(body);
    if (this.activeSection === "quality") this.renderQuality(body);
    if (this.activeSection === "modules") this.renderModules(body);
    if (this.activeSection === "history") this.renderHistory(body);
  }

  renderOverview(root) {
    const counts = this.data.runtime.counts || {};
    const quality = this.data.quality?.overview || {};
    const needsAttention = (counts.failed || 0) + (counts["waiting-for-user"] || 0) + (quality.critical || 0) + (quality.high || 0) + this.data.reviews.length;
    const status = root.createEl("section", { cls: `knowledgeos-system-health-summary ${needsAttention ? "is-warning" : "is-good"}`, attr: { "aria-label": "系统状态" } });
    const statusIcon = status.createSpan({ cls: "knowledgeos-system-health-icon", attr: { "aria-hidden": "true" } }); setIcon(statusIcon, needsAttention ? "circle-alert" : "circle-check");
    const statusText = status.createDiv();
    statusText.createEl("strong", { text: needsAttention ? "有事项需要关注" : "系统运行正常" });
    statusText.createDiv({ text: needsAttention ? `${needsAttention} 项待处理或异常` : "自动化与数据检查均正常" });

    const metrics = root.createEl("section", { cls: "knowledgeos-system-metrics", attr: { "aria-label": "系统摘要" } });
    this.renderMetric(metrics, "自动化", `${(counts.queued || 0) + (counts.running || 0)} 个进行中`, `等待 AI ${counts["waiting-for-ai"] || 0} · 失败 ${counts.failed || 0}`);
    this.renderMetric(metrics, "知识质量", `${quality.active_issues || 0} 个活跃问题`, `严重 ${quality.critical || 0} · 高优先级 ${quality.high || 0}`);
    this.renderMetric(metrics, "工作区", `${this.data.instances.length} 个实例`, `${this.data.modules.filter((item) => item.status === "enabled").length} 个模块已启用 · Inbox ${this.data.inbox.counts?.total || 0}`);
    this.renderMetric(metrics, "人工处理", `${this.data.reviews.length + (counts["waiting-for-user"] || 0)} 项`, `待审核 ${this.data.reviews.length} · 等待用户 ${counts["waiting-for-user"] || 0}`);

    const attentionSection = root.createEl("section", { cls: "knowledgeos-system-section", attr: { "aria-label": "需要关注" } });
    attentionSection.createEl("h3", { text: "需要关注" });
    const attentionList = attentionSection.createDiv({ cls: "knowledgeos-system-list" });
    const attention = this.data.tasks.filter((task) => ["failed", "waiting-for-user", "interrupted"].includes(task.status)).slice(0, 5);
    if (!attention.length && !(quality.critical || quality.high) && !this.data.reviews.length) {
      this.renderEmptyState(attentionSection, "circle-check", "当前没有需要你处理的系统事项", "新的失败任务、质量问题或待审核事项会显示在这里。", true);
      attentionList.remove();
    } else {
      for (const task of attention) this.renderTask(attentionList, task);
      if (quality.critical || quality.high) {
        const row = attentionList.createEl("article", { cls: "knowledgeos-system-row is-warning" });
        row.createEl("strong", { text: "知识质量需要检查" });
        row.createDiv({ cls: "knowledgeos-system-row-description", text: `严重 ${quality.critical || 0} · 高优先级 ${quality.high || 0}` });
        const open = createToolbarButton(row, "arrow-right", "查看知识质量");
        open.onclick = () => { void this.openSection("quality"); };
      }
      if (this.data.reviews.length) {
        const row = attentionList.createEl("article", { cls: "knowledgeos-system-row" });
        row.createEl("strong", { text: `${this.data.reviews.length} 项等待审核` });
        row.createDiv({ cls: "knowledgeos-system-row-description", text: "需要你确认系统建议后才能继续。" });
        const open = createToolbarButton(row, "arrow-right", "打开审核中心");
        open.onclick = () => this.plugin.activateReviews();
      }
    }
    const latest = this.data.runs[0];
    if (latest) {
      const recent = root.createEl("section", { cls: "knowledgeos-system-section", attr: { "aria-label": "最近活动" } });
      recent.createEl("h3", { text: "最近活动" });
      const list = recent.createDiv({ cls: "knowledgeos-system-list" });
      this.renderRun(list, latest);
    }
    renderDeveloperDetails(root, this.plugin, [
      ["Core API", "Command API v1"],
      ["Runtime integrity", this.data.runtime.integrity],
      ["已注册任务", (this.data.runtime.jobs || []).length],
    ]);
  }

  renderMetric(root, label, value, description) {
    const metric = root.createDiv({ cls: "knowledgeos-system-metric" });
    metric.createDiv({ cls: "knowledgeos-system-metric-label", text: label });
    metric.createEl("strong", { text: value });
    metric.createDiv({ cls: "knowledgeos-system-metric-description", text: description });
  }

  renderEmptyState(root, iconName, title, description, positive = false) {
    const empty = root.createDiv({ cls: `knowledgeos-system-empty${positive ? " is-positive" : ""}` });
    const icon = empty.createSpan({ cls: "knowledgeos-system-empty-icon", attr: { "aria-hidden": "true" } }); setIcon(icon, iconName);
    empty.createEl("h3", { text: title });
    if (description) empty.createDiv({ text: description });
    return empty;
  }

  renderTask(root, task) {
    const card = root.createEl("article", { cls: `knowledgeos-system-row knowledgeos-system-task-row task-${task.status}` });
    const title = card.createDiv({ cls: "knowledgeos-system-row-heading" });
    const open = title.createEl("button", { cls: "knowledgeos-link", text: labelJob(task.job_id, task.module) });
    open.onclick = () => new TaskDetailsModal(this.app, this.plugin, task.task_id, () => this.refresh()).open();
    title.createSpan({ cls: `knowledgeos-status status-${task.status}`, text: labelStatus(task.status) });
    const meta = card.createDiv({ cls: "knowledgeos-system-row-meta" });
    meta.createSpan({ text: labelModule(task.module) });
    createTime(meta, task.scheduled_for, " · ");
    if (task.last_error) card.createDiv({ cls: "knowledgeos-system-row-description knowledgeos-error-text", text: task.last_error.message });
    renderDeveloperDetails(card, this.plugin, [["Task ID", task.task_id], ["Job ID", task.job_id], ["尝试次数", `${task.attempt_count}/${task.max_attempts}`], ["计划时间", task.scheduled_for]]);
  }

  renderTasks(root) {
    const actions = root.createDiv({ cls: "knowledgeos-section-heading" });
    actions.createEl("h3", { text: "任务" });
    const runTasks = createToolbarButton(actions, "play", "运行队列");
    runTasks.onclick = async () => {
      runTasks.disabled = true;
      const response = await this.plugin.taskClient.invoke("runTaskCycle", {
        limit: 2,
        codex_model: this.plugin.settings.codexModel,
        codex_reasoning_effort: this.plugin.settings.codexReasoningEffort,
      });
      runTasks.disabled = false;
      if (!response.ok) this.plugin.notify(response.error?.message || "任务运行失败", { error: true });
      await this.refresh();
    };
    const groups = [
      ["正在进行", ["queued", "running"]],
      ["等待条件", ["waiting-for-network", "waiting-for-ai", "waiting-for-user", "deferred", "interrupted"]],
      ["需要处理的失败", ["failed"]],
    ];
    const summary = root.createDiv({ cls: "knowledgeos-system-section-summary" });
    const taskCounts = this.data.runtime.counts || {};
    summary.setText(`运行中 ${taskCounts.running || 0} · 已排队 ${taskCounts.queued || 0} · 等待条件 ${(taskCounts["waiting-for-network"] || 0) + (taskCounts["waiting-for-ai"] || 0) + (taskCounts["waiting-for-user"] || 0) + (taskCounts.deferred || 0)} · 失败 ${taskCounts.failed || 0}`);
    let shown = 0;
    for (const [label, statuses] of groups) {
      const tasks = this.data.tasks.filter((task) => statuses.includes(task.status));
      if (!tasks.length) continue;
      shown += tasks.length;
      const section = root.createEl("section", { cls: "knowledgeos-system-section", attr: { "aria-label": label } });
      section.createEl("h4", { text: `${label} · ${tasks.length}` });
      const list = section.createDiv({ cls: "knowledgeos-system-list" });
      for (const task of tasks) this.renderTask(list, task);
    }
    if (!shown) this.renderEmptyState(root, "circle-check", "当前没有运行中或等待处理的任务", "新的手动任务和自动任务会显示在这里。", true);
    if (this.data.page?.has_more && this.data.page?.next_cursor) {
      const more = root.createEl("button", { cls: "knowledgeos-system-load-more", text: "加载更多任务" });
      more.onclick = () => this.loadNextPage(more);
    }
    const jobs = (this.data.runtime.jobs || []).filter((job) => job.enabled && job.trigger?.type !== "startup");
    if (jobs.length) {
      const details = root.createEl("details", { cls: "knowledgeos-system-disclosure knowledgeos-scheduled-jobs" });
      details.createEl("summary", { text: `自动计划 · ${jobs.length}` });
      const list = details.createDiv({ cls: "knowledgeos-system-list" });
      for (const job of jobs) {
        const card = list.createEl("article", { cls: "knowledgeos-system-row knowledgeos-system-job-row" });
        card.createEl("strong", { text: labelJob(job.job_id, job.module) });
        card.createDiv({ cls: "knowledgeos-system-row-description", text: job.trigger?.type === "field-due" ? "在信息到期时检查" : "按计划自动运行" });
        const run = card.createEl("button", { text: "立即运行" });
        run.onclick = async () => { run.disabled = true; const response = await this.plugin.taskClient.invoke("enqueueTask", { job_id: job.job_id }); if (!response.ok) this.plugin.notify(response.error?.message || "任务创建失败", { error: true }); else this.plugin.notify(response.data.deduplicated ? "任务已在队列中" : "任务已加入队列"); await this.refresh(); };
        renderDeveloperDetails(card, this.plugin, [["Job ID", job.job_id], ["Workflow", job.workflow], ["Trigger", job.trigger?.type], ["Priority", job.priority]]);
      }
    }
  }

  renderModules(root) {
    const heading = root.createDiv({ cls: "knowledgeos-section-heading" });
    heading.createEl("h3", { text: "模块" });
    const create = createToolbarButton(heading, "plus", "创建实例", { cls: "mod-cta" });
    create.disabled = !this.data.modules.some((module) => module.status === "enabled" && module.instance_form);
    create.onclick = () => new CreateInstanceModal(this.app, this.plugin, this.data.modules, () => this.refresh()).open();
    const moduleList = root.createDiv({ cls: "knowledgeos-system-list knowledgeos-system-module-list" });
    if (!this.data.modules.length) {
      moduleList.remove();
      this.renderEmptyState(root, "boxes", "尚未发现可用模块", "安装并启用模块后，它们会显示在这里。");
    }
    for (const module of this.data.modules) {
      const stats = this.moduleStats(module.id);
      const card = moduleList.createEl("article", { cls: "knowledgeos-system-row knowledgeos-system-module-row" });
      const title = card.createDiv({ cls: "knowledgeos-system-row-heading" });
      const moduleIcon = moduleUiMetadata.icon(module.id);
      if (moduleIcon) {
        const icon = title.createSpan({ cls: "knowledgeos-module-icon", attr: { "aria-hidden": "true" } });
        setIcon(icon, moduleIcon);
      }
      title.createEl("strong", { text: module.name || labelModule(module.id) });
      title.createSpan({ cls: `knowledgeos-status status-${module.status}`, text: labelStatus(module.status) });
      if (module.description) card.createDiv({ cls: "knowledgeos-system-row-description", text: module.description.trim() });
      card.createDiv({ cls: "knowledgeos-system-row-meta", text: `活跃实例 ${module.active_instance_count} · Inbox ${stats.inbox} · 待审核 ${stats.reviews}` });
      const actions = card.createDiv({ cls: "knowledgeos-system-row-actions" });
      if (module.status === "enabled" && module.instance_form) { const add = actions.createEl("button", { text: "创建实例" }); add.onclick = () => new CreateInstanceModal(this.app, this.plugin, this.data.modules, () => this.refresh(), module.id).open(); }
      if (this.plugin.settings.developerMode) {
        const validate = actions.createEl("button", { text: "验证模块" }); validate.onclick = () => this.validateModule(module);
        const toggle = actions.createEl("button", { text: module.status === "enabled" ? "停用模块" : "启用模块" }); toggle.onclick = () => this.moduleAction(module, module.status === "enabled" ? "disable" : "enable");
        const upgrade = actions.createEl("button", { text: "升级模块包" });
        upgrade.onclick = async () => {
          const packagePath = window.prompt("本地 .pkb-module 文件路径");
          if (!packagePath) return;
          let response = await this.plugin.client.invoke("manageModule", { module_id: module.id, action: "upgrade", package_path: packagePath });
          if (!response.ok && response.error?.code === "MODULE_UPGRADE_CONFIRMATION_REQUIRED" && window.confirm(response.error.message)) {
            response = await this.plugin.client.invoke("manageModule", { module_id: module.id, action: "upgrade", package_path: packagePath, confirm: true });
          }
          if (!response.ok) this.plugin.notify(response.error?.message || "模块升级失败", { error: true });
          else this.plugin.notify(`${module.name} 已升级到 ${response.data.version}`);
          await this.refresh();
        };
        if ((module.available_actions || []).includes("rollback")) {
          const rollback = actions.createEl("button", { text: "回滚模块" });
          rollback.onclick = async () => {
            if (!window.confirm(`将 ${module.name} 回滚到 ${module.previous_version}？`)) return;
            const response = await this.plugin.client.invoke("manageModule", { module_id: module.id, action: "rollback", confirm: true });
            if (!response.ok) this.plugin.notify(response.error?.message || "模块回滚失败", { error: true });
            else this.plugin.notify(`${module.name} 已回滚到 ${response.data.version}`);
            await this.refresh();
          };
        }
      }
      renderDeveloperDetails(card, this.plugin, [["Module ID", module.id], ["Version", module.version], ["Maturity", module.maturity], ["Schema", module.schema_version], ["Core API", module.engine_api_version], ["最近 Run", stats.latest?.run_id]]);
    }
    const instanceSection = root.createEl("section", { cls: "knowledgeos-system-section", attr: { "aria-label": "实例" } });
    instanceSection.createEl("h3", { text: "实例" });
    const instanceList = instanceSection.createDiv({ cls: "knowledgeos-system-list knowledgeos-system-instance-list" });
    if (!this.data.instances.length) {
      instanceList.remove();
      this.renderEmptyState(instanceSection, "folder-plus", "还没有创建实例", "创建实例后，可在这里查看状态和生命周期操作。");
    }
    for (const instance of this.data.instances) {
      const stats = this.instanceStats(instance.instance_id);
      const card = instanceList.createEl("article", { cls: "knowledgeos-system-row knowledgeos-system-instance-row" });
      const title = card.createDiv({ cls: "knowledgeos-system-row-heading" });
      const open = title.createEl("button", { cls: "knowledgeos-link", text: instance.display_name });
      open.onclick = () => this.app.workspace.openLinkText(instance.content_root, "", false);
      title.createSpan({ cls: `knowledgeos-status status-${instance.status}`, text: labelStatus(instance.status) });
      card.createDiv({ cls: "knowledgeos-system-row-meta", text: `${labelModule(instance.module_id)} · Inbox ${stats.inbox} · 待审核 ${stats.reviews}` });
      if (stats.latest) createTime(card.createDiv({ cls: "knowledgeos-system-row-description" }), stats.latest.completed_at, "最近更新 ");
      const actions = card.createDiv({ cls: "knowledgeos-system-row-actions" });
      for (const action of instance.available_actions || []) { const labels = { activate: "激活", pause: "暂停", resume: "恢复", complete: "标记完成", archive: "归档" }; const button = actions.createEl("button", { text: labels[action] || action }); button.onclick = () => this.instanceAction(instance, action); }
      renderDeveloperDetails(card, this.plugin, [["Instance ID", instance.instance_id], ["内容目录", instance.content_root], ["最近 Run", stats.latest?.run_id]]);
    }
  }

  renderHistory(root) {
    root.createEl("h3", { text: "运行历史" });
    root.createDiv({ cls: "knowledgeos-system-section-summary", text: "查看系统执行结果、文件修改和失败恢复信息。" });
    if (!this.data.runs.length) {
      this.renderEmptyState(root, "history", "尚无运行记录", "任务完成或失败后，运行记录会显示在这里。");
      return;
    }
    const list = root.createDiv({ cls: "knowledgeos-system-list knowledgeos-system-history-list" });
    for (const run of this.data.runs) this.renderRun(list, run);
    if (this.data.page?.has_more && this.data.page?.next_cursor) {
      const more = root.createEl("button", { cls: "knowledgeos-system-load-more", text: "加载更多运行记录" });
      more.onclick = () => this.loadNextPage(more);
    }
  }

  renderQuality(root) {
    const quality = this.data.quality;
    const section = root.createDiv({ cls: "knowledgeos-quality" });
    const header = section.createDiv({ cls: "knowledgeos-section-heading" });
    const heading = header.createDiv();
    heading.createEl("h3", { text: "知识质量" });
    heading.createDiv({ cls: "knowledgeos-page-subtitle", text: "来源、新鲜度、审核与数据一致性" });
    const audit = header.createEl("button", { text: "运行每周审计" });
    audit.onclick = async () => { audit.disabled = true; const response = await this.plugin.taskClient.invoke("runQualityAudit", { frequency: "weekly" }); if (!response.ok) this.plugin.notify(response.error?.message || "质量审计失败", { error: true }); await this.refresh(); };
    const overview = section.createEl("section", { cls: "knowledgeos-system-metrics knowledgeos-quality-grid", attr: { "aria-label": "知识质量摘要" } });
    this.renderMetric(overview, "需要关注", String(quality.overview.active_issues || 0), "当前活跃问题");
    this.renderMetric(overview, "严重问题", String(quality.overview.critical || 0), "需要立即检查");
    this.renderMetric(overview, "高优先级", String(quality.overview.high || 0), "建议优先处理");
    this.renderMetric(overview, "本周已解决", String(quality.overview.resolved_this_week || 0), "最近七天");
    const observation = quality.observation || {};
    const evaluation = observation.evaluation || {};
    const coverage = evaluation.coverage || {};
    if (this.plugin.settings.developerMode) {
      const observationPanel = section.createEl("details", { cls: "knowledgeos-technical" });
      observationPanel.createEl("summary", { text: "I14 真实观察" });
      observationPanel.createDiv({ cls: "knowledgeos-review-meta", text: `状态 ${observation.status || "未开始"} · 时区 ${evaluation.timezone || observation.timezone || "Asia/Shanghai"} · 已观察 ${observation.elapsed_days || 0}/${observation.minimum_days || 14} 天 · 实测日期 ${coverage.unique_days || 0}/${coverage.required_unique_days || 7} · 周审计 ${coverage.weekly_audits || 0}/${coverage.required_weekly_audits || 2}` });
      observationPanel.createDiv({ cls: "knowledgeos-review-meta", text: `初步结论 ${evaluation.overall || "insufficient-evidence"} · 最终评估资格 ${evaluation.eligible_for_final_review ? "已满足" : "未满足"}` });
      for (const [criterion, result] of Object.entries(evaluation.criteria || {})) observationPanel.createDiv({ cls: "knowledgeos-review-meta", text: `${criterion}: ${result?.status || "insufficient-evidence"}` });
    }
    const panels = [
      ["信息新鲜度", quality.freshness, [["due_soon", "即将到期"], ["stale", "需要复核"]]],
      ["来源与证据", quality.provenance, [["missing", "缺少来源"], ["conflicts", "来源冲突"], ["unavailable", "来源不可用"]]],
      ["审核负担", quality.reviews, [["pending", "待审核"], ["overdue", "已超期"]]],
      ["链接与归属", quality.links_ownership, [["broken_links", "失效链接"], ["orphan_files", "孤立文件"], ["unowned_files", "未归类文件"]]],
      ["数据结构", quality.schemas_migrations, [["outdated", "待迁移"], ["invalid", "格式异常"], ["legacy_access_policy.remaining", "旧访问策略"]]],
      ["AI 质量", quality.ai_quality, []],
      ["审计历史", { count: (quality.audit_history || []).length }, [["count", "审计次数"]]],
    ];
    for (const [title, data, fields] of panels) {
      const details = section.createEl("details", { cls: "knowledgeos-system-disclosure knowledgeos-quality-panel" });
      const valueAt = (source, key) => key.split(".").reduce((value, segment) => value && typeof value === "object" ? value[segment] : undefined, source);
      const total = fields.reduce((sum, [key]) => sum + (Number(valueAt(data, key)) || 0), 0);
      details.createEl("summary", { text: `${title}${total ? ` · ${total}` : ""}` });
      if (fields.length) details.createDiv({ cls: "knowledgeos-system-section-summary knowledgeos-quality-summary", text: fields.map(([key, label]) => `${label} ${valueAt(data, key) ?? 0}`).join(" · ") });
      if (title === "数据结构" && data?.legacy_access_policy) {
        const migration = data.legacy_access_policy;
        const actionRow = details.createDiv({ cls: "knowledgeos-system-row-actions" });
        const migrate = actionRow.createEl("button", { text: Number(migration.remaining || 0) ? "迁移旧访问策略" : "查看迁移状态" });
        migrate.onclick = () => new LegacyAccessPolicyMigrationModal(this.app, this.plugin, () => this.refresh()).open();
        if (migration.last_migration_status === "applied" && migration.last_preview_id) {
          const undo = actionRow.createEl("button", { cls: "mod-warning", text: "撤销上次迁移" });
          undo.onclick = async () => {
            if (!window.confirm("将恢复上次迁移前保存的访问策略。是否继续？")) return;
            undo.disabled = true;
            const response = await this.plugin.client.invoke("migrateLegacyAccessPolicies", { action: "rollback", preview_id: migration.last_preview_id, confirm: true });
            if (!response.ok) this.plugin.notify(response.error?.message || "撤销迁移失败", { error: true }); else this.plugin.notify(`已恢复 ${response.data.restored} 个旧访问策略`);
            await this.refresh();
          };
        }
      }
      const issues = (data?.items || data?.anomalies || []).slice(0, 20);
      if (!issues.length) details.createDiv({ cls: "knowledgeos-system-disclosure-empty", text: title === "审计历史" ? "尚无审计记录。" : "当前没有相关问题。" });
      const list = issues.length ? details.createDiv({ cls: "knowledgeos-system-list" }) : null;
      for (const issue of issues) {
        const row = list.createEl("article", { cls: `knowledgeos-system-row knowledgeos-system-quality-row quality-${issue.severity}` });
        row.createEl("strong", { text: issue.title || labelField(issue.target?.field, issue.module) || "质量问题" });
        row.createDiv({ cls: "knowledgeos-system-row-description", text: issue.message || String(issue.target?.path || issue.target?.entity_ref || "需要检查相关信息") });
        const actions = row.createDiv({ cls: "knowledgeos-system-row-actions" });
        for (const [action, label] of [["acknowledge", "知道了"], ["suppress", "暂时忽略"], ["resolve", "标记已解决"]]) { const button = actions.createEl("button", { text: label }); button.onclick = async () => { await this.plugin.client.invoke("manageQualityIssue", { issue_id: issue.issue_id, action }); await this.refresh(); }; }
        renderDeveloperDetails(row, this.plugin, [["Issue ID", issue.issue_id], ["类型", issue.issue_type], ["严重度", issue.severity]]);
      }
    }
  }

  renderRun(root, run) {
    const card = root.createEl("article", { cls: `knowledgeos-system-row knowledgeos-system-run-row run-${run.status}` });
    const heading = card.createDiv({ cls: "knowledgeos-system-row-heading" });
    const title = heading.createEl("button", { cls: "knowledgeos-link", text: friendlyAction(run.source_action, run.source_module) });
    title.onclick = () => new RunDetailsModal(this.app, this.plugin, run.run_id, () => this.refresh()).open();
    heading.createSpan({ cls: `knowledgeos-status status-${run.status}`, text: labelStatus(run.status) });
    const meta = card.createDiv({ cls: "knowledgeos-system-row-meta" });
    meta.createSpan({ text: labelModule(run.source_module) });
    createTime(meta, run.completed_at, " · ");
    const activity = [];
    if (run.modified_file_count) activity.push(`更新 ${run.modified_file_count} 个文件`);
    if (run.review_count) activity.push(`创建 ${run.review_count} 个审核`);
    if (activity.length) card.createDiv({ cls: "knowledgeos-system-row-description", text: activity.join(" · ") });
    if (this.plugin.settings.developerMode || run.status === "failed") {
      const recovery = card.createDiv({ cls: `knowledgeos-rollback-inline rollback-${run.rollback?.level || "check-required"}`, text: run.rollback ? rollbackLabel(run.rollback) : "打开详情后检查回滚条件" });
      if (run.status === "failed") recovery.setText("运行失败 · 查看详情");
    }
    renderDeveloperDetails(card, this.plugin, [["Run ID", run.run_id], ["来源模块", run.source_module], ["实例", run.instance_id], ["完成时间", run.completed_at], ["操作数", run.operation_count]]);
  }

  async validateModule(module) {
    const response = await this.plugin.client.invoke("manageModule", { module_id: module.id, action: "validate" });
    if (!response.ok) { this.plugin.notify(response.error?.message || "模块验证失败", { error: true }); return; }
    const report = response.data.report;
    this.plugin.notify(`${module.name}：${report.overall}（通过 ${report.counts.pass} / 警告 ${report.counts.warning} / 失败 ${report.counts.fail}）`, { error: report.overall === "FAIL" });
    await this.refresh();
    return;
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


  return { SystemCenterView, CreateInstanceModal };
}
module.exports = { createSystemCenterViews };
