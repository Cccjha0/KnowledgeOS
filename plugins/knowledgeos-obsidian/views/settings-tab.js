function createSettingsViews(deps) {
  const { ItemView, Modal, Notice, PluginSettingTab, Setting, setIcon, VIEW_TYPE, REVIEW_VIEW_TYPE, INBOX_VIEW_TYPE, SYSTEM_VIEW_TYPE, settingsDefaults, moduleUiMetadata, manifestFormatters, LIST_PAGE_SIZE, FALLBACK_CODEX_MODELS, REASONING_LABELS, markLiveRegion, taskCycleChanged, shouldAutoRefreshPath, missingBuiltCliFailure, labelStatus, labelModule, labelJob, labelField, friendlyAction, calendarDayDifference, formatTime, formatVerificationSchedule, createTime, friendlyDashboardDescription, friendlyDashboardTitle, createToolbarButton, renderLoadingSkeleton, addCardArrow, renderDeveloperDetails, renderRecoverableError } = deps;
class KnowledgeOSSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin); this.plugin = plugin;
    this.connectionState = { tone: "idle", message: "尚未测试 Core 连接。" };
    this.setupDoctorReport = null;
    this.modelDiscoveryState = null;
    this.modelDiscoveryRunning = false;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("knowledgeos-settings");
    const header = containerEl.createEl("header", { cls: "knowledgeos-settings-header" });
    header.createEl("h2", { text: "KnowledgeOS" });
    header.createEl("p", { text: "连接本地 Core、选择 Vault，并配置日常自动化行为。" });
    this.settingsStatusEl = markLiveRegion(containerEl.createDiv({ cls: "knowledgeos-settings-save-state" }));

    const connection = this.createSection(containerEl, "Core 连接", "配置 KnowledgeOS Engine 和用户数据所在的 Vault。");
    new Setting(connection).setName("Vault 路径").setDesc("KnowledgeOS 用户数据所在的 Obsidian Vault 绝对路径")
      .addText((text) => text.setPlaceholder("E:\\KnowledgeOS\\knowledgeos-vault").setValue(this.plugin.settings.vaultPath).onChange(async (value) => {
        await this.persistSetting("vaultPath", value.trim(), true);
      }));
    new Setting(connection).setName("Core CLI 路径").setDesc("knowledgeos-engine/dist/cli.js 的绝对路径；源码仓库不提交 dist/，首次使用请先运行 npm ci 与 npm run build")
      .addText((text) => text.setPlaceholder("E:\\KnowledgeOS\\knowledgeos-engine\\dist\\cli.js")
        .setValue(this.plugin.settings.coreCliPath).onChange(async (value) => {
          await this.persistSetting("coreCliPath", value.trim(), true);
        }));
    new Setting(connection).setName("Node.js 可执行文件").setDesc("通常保持为 node；未加入 PATH 时填写 node.exe 的绝对路径")
      .addText((text) => text.setValue(this.plugin.settings.nodePath).onChange(async (value) => {
        await this.persistSetting("nodePath", value.trim() || "node", true);
      }));
    const connectionTest = new Setting(connection).setName("Setup Doctor").setDesc("只读检查 Node、Python、Core CLI、Command API、Vault、配置、Runtime DB 与已启用模块；不会自动修复或覆盖笔记");
    connectionTest.addButton((button) => button.setButtonText("运行检查").onClick(async () => this.testConnection(button)));
    this.connectionStatusEl = markLiveRegion(connection.createDiv({ cls: "knowledgeos-settings-connection-state" }));
    this.renderConnectionState();
    this.setupDoctorEl = connection.createDiv({ cls: "knowledgeos-setup-doctor" });
    this.renderSetupDoctor();

    const daily = this.createSection(containerEl, "日常使用", "控制启动、刷新、通知和 Inbox 批量操作。");
    new Setting(daily).setName("启动时打开 Today").setDesc("Obsidian 工作区加载完成后打开 Knowledge Today")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.openTodayOnStartup).onChange(async (value) => {
        await this.persistSetting("openTodayOnStartup", value);
      }));
    new Setting(daily).setName("自动刷新").setDesc("受管 Vault 文件变化后，后台刷新 Today、Inbox 和 System Center")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.autoRefresh).onChange(async (value) => {
        await this.persistSetting("autoRefresh", value);
      }));
    new Setting(daily).setName("操作完成通知").setDesc("主动操作完成时显示通知；失败和撤销结果始终通知")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.notifyOnCompletion).onChange(async (value) => {
        await this.persistSetting("notifyOnCompletion", value);
      }));
    new Setting(daily).setName("允许批量处理").setDesc("在 Inbox Center 中显示高置信度批量处理入口")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.allowBatchOperations).onChange(async (value) => {
        await this.persistSetting("allowBatchOperations", value);
      }));

    const automation = this.createSection(containerEl, "自动化资源", "为需要外部资源的后台任务提供可用性配置。");
    const modelCatalog = this.codexModelCatalog();
    const selectedModel = this.selectedCodexModel(modelCatalog);
    new Setting(automation).setName("Codex 模型").setDesc("用于新建后台 AI 任务；已创建的任务继续使用其创建时记录的模型与推理强度")
      .addDropdown((dropdown) => {
        for (const model of modelCatalog) dropdown.addOption(model.id, `${model.display_name}${model.id === "gpt-5.6-terra" ? "（默认）" : ""}`);
        dropdown.setValue(this.plugin.settings.codexModel).onChange(async (value) => {
          const next = this.selectedCodexModel(modelCatalog, value);
          const efforts = this.reasoningEfforts(next);
          this.plugin.settings.codexModel = value;
          if (!efforts.includes(this.plugin.settings.codexReasoningEffort)) this.plugin.settings.codexReasoningEffort = next.default_reasoning_effort || efforts[0] || "medium";
          await this.plugin.saveSettings();
          this.display();
        });
      });
    const reasoningEfforts = this.reasoningEfforts(selectedModel);
    new Setting(automation).setName("推理强度").setDesc("更高强度通常更慢；可选值由当前模型的 Codex 目录决定")
      .addDropdown((dropdown) => {
        for (const effort of reasoningEfforts) dropdown.addOption(effort, REASONING_LABELS[effort] || effort);
        if (!reasoningEfforts.includes(this.plugin.settings.codexReasoningEffort)) dropdown.addOption(this.plugin.settings.codexReasoningEffort, this.plugin.settings.codexReasoningEffort);
        dropdown.setValue(this.plugin.settings.codexReasoningEffort).onChange(async (value) => {
          await this.persistSetting("codexReasoningEffort", value);
        });
      });
    let customModel = "";
    new Setting(automation).setName("自定义模型 ID").setDesc("当自动目录尚未列出已获权限的模型时，可以手动指定模型 ID")
      .addText((text) => text.setPlaceholder("例如 gpt-5.6-terra").onChange((value) => { customModel = value.trim(); }))
      .addButton((button) => button.setButtonText("使用").onClick(async () => {
        if (!customModel) { this.plugin.notify("请输入模型 ID", { error: true, force: true }); return; }
        this.plugin.settings.codexModel = customModel;
        await this.plugin.saveSettings();
        this.display();
      }));
    new Setting(automation).setName("可用模型检测").setDesc("通过本机 Codex App Server 获取当前模型目录；离线时继续使用缓存和自定义值")
      .addButton((button) => button.setButtonText("重新检测").onClick(async () => this.refreshCodexModels(button, true)));
    this.modelDiscoveryStatusEl = markLiveRegion(automation.createDiv({ cls: "knowledgeos-settings-connection-state" }));
    this.renderModelDiscoveryState();
    if (this.codexModelCatalogIsStale()) void this.refreshCodexModels(null, false);
    new Setting(automation).setName("网络探测地址").setDesc("联网任务执行前检查的地址；留空时网络状态保持 unknown，联网任务继续等待")
      .addText((text) => text.setPlaceholder("https://example.com/").setValue(this.plugin.settings.networkProbeUrl).onChange(async (value) => {
        await this.persistSetting("networkProbeUrl", value.trim());
      }));

    const advanced = this.createSection(containerEl, "高级选项", "用于排查系统问题和查看底层执行信息。");
    new Setting(advanced).setName("开发者模式").setDesc("显示 ID、Schema、精确时间、底层计划和运行日志；不改变 Core 权限或执行规则")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.developerMode).onChange(async (value) => {
        await this.persistSetting("developerMode", value);
      }));
  }

  codexModelCatalog() {
    const catalog = new Map();
    for (const model of Array.isArray(this.plugin.settings.codexModelCatalog) ? this.plugin.settings.codexModelCatalog : []) {
      if (model && typeof model.id === "string" && model.id) catalog.set(model.id, model);
    }
    for (const model of FALLBACK_CODEX_MODELS) if (!catalog.has(model.id)) catalog.set(model.id, model);
    const current = String(this.plugin.settings.codexModel || "").trim();
    if (current && !catalog.has(current)) catalog.set(current, {
      id: current, model: current, display_name: current, description: "手动配置的模型",
      supported_reasoning_efforts: ["low", "medium", "high", "xhigh"], default_reasoning_effort: "medium", is_default: false,
    });
    return [...catalog.values()];
  }

  selectedCodexModel(catalog, id = this.plugin.settings.codexModel) {
    return catalog.find((model) => model.id === id) || FALLBACK_CODEX_MODELS[0];
  }

  reasoningEfforts(model) {
    const efforts = Array.isArray(model?.supported_reasoning_efforts) ? model.supported_reasoning_efforts.filter(Boolean) : [];
    return efforts.length ? efforts : ["low", "medium", "high", "xhigh"];
  }

  codexModelCatalogIsStale() {
    const detected = Array.isArray(this.plugin.settings.codexModelCatalog) && this.plugin.settings.codexModelCatalog.length > 0;
    const fetchedAt = Date.parse(this.plugin.settings.codexModelsFetchedAt || "");
    return !detected || !Number.isFinite(fetchedAt) || Date.now() - fetchedAt > 6 * 60 * 60 * 1000;
  }

  renderModelDiscoveryState() {
    if (!this.modelDiscoveryStatusEl) return;
    const detectedModels = Array.isArray(this.plugin.settings.codexModelCatalog) ? this.plugin.settings.codexModelCatalog : [];
    const cached = detectedModels.length;
    const currentDetected = detectedModels.some((model) => model?.id === this.plugin.settings.codexModel);
    const stale = this.codexModelCatalogIsStale();
    const state = this.modelDiscoveryState || (cached
      ? {
        tone: stale || !currentDetected ? "stale" : "success",
        message: `${stale ? "正在使用缓存" : "已检测"} ${cached} 个 Codex 模型。`,
        detail: !currentDetected ? `当前模型 ${this.plugin.settings.codexModel} 未出现在本次目录中；执行时仍会交由 Codex 验证。` : null,
      }
      : { tone: "idle", message: "尚未完成自动检测；当前使用内置兼容列表。" });
    this.modelDiscoveryStatusEl.empty();
    for (const tone of ["idle", "loading", "success", "error", "stale"]) this.modelDiscoveryStatusEl.removeClass(`is-${tone}`);
    this.modelDiscoveryStatusEl.addClass(`is-${state.tone}`);
    this.modelDiscoveryStatusEl.createDiv({ text: state.message });
    if (state.detail) this.modelDiscoveryStatusEl.createDiv({ cls: "knowledgeos-settings-state-detail", text: state.detail });
  }

  async refreshCodexModels(button, force) {
    if (this.modelDiscoveryRunning) return;
    if (!force && !this.codexModelCatalogIsStale()) return;
    this.modelDiscoveryRunning = true;
    button?.setDisabled(true);
    this.modelDiscoveryState = { tone: "loading", message: "正在从本机 Codex 检测可用模型…" };
    this.renderModelDiscoveryState();
    const result = await this.plugin.client.invoke("listCodexModels", {});
    this.modelDiscoveryRunning = false;
    button?.setDisabled(false);
    if (!result.ok || !Array.isArray(result.data?.models)) {
      const hasCache = Array.isArray(this.plugin.settings.codexModelCatalog) && this.plugin.settings.codexModelCatalog.length > 0;
      this.modelDiscoveryState = {
        tone: hasCache ? "stale" : "error",
        message: hasCache ? "模型检测失败，继续使用上次缓存。" : "模型检测失败，继续使用内置兼容列表。",
        detail: result.error?.message || "请确认 Codex CLI 已登录且支持 App Server。",
      };
      this.renderModelDiscoveryState();
      return;
    }
    this.plugin.settings.codexModelCatalog = result.data.models;
    this.plugin.settings.codexModelsFetchedAt = result.data.detected_at || new Date().toISOString();
    await this.plugin.saveSettings();
    this.modelDiscoveryState = null;
    this.display();
  }

  createSection(root, title, description) {
    const section = root.createEl("section", { cls: "knowledgeos-settings-section" });
    section.createEl("h3", { text: title });
    section.createEl("p", { cls: "knowledgeos-settings-section-description", text: description });
    return section;
  }

  async persistSetting(key, value, invalidatesConnection = false) {
    this.plugin.settings[key] = value;
    try {
      await this.plugin.saveSettings();
      this.settingsStatusEl.empty(); this.settingsStatusEl.removeClass("is-error");
      if (invalidatesConnection) this.markConnectionStale();
    } catch (error) {
      this.settingsStatusEl.addClass("is-error");
      this.settingsStatusEl.setText(`设置尚未保存：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  markConnectionStale() {
    if (this.connectionState.tone === "idle") return;
    this.connectionState = { tone: "stale", message: "连接配置已修改，请重新测试连接。" };
    this.renderConnectionState();
  }

  renderConnectionState() {
    if (!this.connectionStatusEl) return;
    this.connectionStatusEl.empty();
    for (const tone of ["idle", "loading", "success", "error", "stale"]) this.connectionStatusEl.removeClass(`is-${tone}`);
    this.connectionStatusEl.addClass(`is-${this.connectionState.tone}`);
    this.connectionStatusEl.createDiv({ text: this.connectionState.message });
    if (this.connectionState.impact) this.connectionStatusEl.createDiv({ cls: "knowledgeos-settings-state-detail", text: this.connectionState.impact });
    if (this.connectionState.actions?.length) this.connectionStatusEl.createDiv({ cls: "knowledgeos-settings-state-detail", text: `建议：${this.connectionState.actions.join("；")}` });
  }

  renderSetupDoctor() {
    if (!this.setupDoctorEl) return;
    this.setupDoctorEl.empty();
    const report = this.setupDoctorReport;
    if (!report || !Array.isArray(report.checks)) return;
    const statusLabels = { ready: "Ready", "needs-action": "Needs action", failed: "Failed" };
    for (const check of report.checks) {
      const card = this.setupDoctorEl.createDiv({ cls: `knowledgeos-setup-check is-${check.status}` });
      const heading = card.createDiv({ cls: "knowledgeos-setup-check-heading" });
      heading.createEl("strong", { text: check.label || check.id });
      heading.createSpan({ cls: "knowledgeos-setup-check-status", text: statusLabels[check.status] || check.status });
      card.createDiv({ text: check.message });
      if (check.impact) card.createDiv({ cls: "knowledgeos-settings-state-detail", text: `影响：${check.impact}` });
      if (Array.isArray(check.recovery_actions) && check.recovery_actions.length) {
        card.createDiv({ cls: "knowledgeos-settings-state-detail", text: `修复：${check.recovery_actions.join("；")}` });
      }
      card.createDiv({ cls: "knowledgeos-settings-state-detail", text: check.will_modify_vault ? "执行建议的修复会修改 Vault；请先备份并明确确认。" : "本项检查和建议不会自动修改 Vault。" });
    }
    if (Array.isArray(report.next_steps) && report.next_steps.length) {
      const next = this.setupDoctorEl.createDiv({ cls: "knowledgeos-setup-next" });
      next.createEl("strong", { text: "可以开始使用" });
      const actions = next.createDiv({ cls: "knowledgeos-settings-actions" });
      const today = actions.createEl("button", { text: "打开 Today" });
      today.onclick = () => this.plugin.activateToday();
      const capture = actions.createEl("button", { text: "Quick Capture" });
      capture.onclick = () => this.plugin.openCapture();
      const inbox = actions.createEl("button", { text: "查看 Inbox" });
      inbox.onclick = () => this.plugin.activateInbox();
    }
  }

  async testConnection(button) {
    button.setDisabled(true);
    this.connectionState = { tone: "loading", message: "正在连接 KnowledgeOS Core…" };
    this.renderConnectionState();
    const result = await this.plugin.client.invoke("getSetupDoctor", {});
    button.setDisabled(false);
    if (result.ok) {
      this.setupDoctorReport = result.data;
      const summary = result.data?.summary || {};
      const healthy = result.data?.status === "ready";
      this.connectionState = {
        tone: healthy ? "success" : result.data?.status === "failed" ? "error" : "stale",
        message: healthy ? "Setup Doctor 全部通过。" : `Setup Doctor：${summary.ready || 0} Ready，${summary.needs_action || 0} Needs action，${summary.failed || 0} Failed。`,
      };
    } else {
      this.connectionState = { tone: "error", message: result.error?.message || "Core 连接失败。", impact: result.error?.impact, actions: result.error?.recovery_actions || [] };
    }
    this.renderConnectionState();
    this.renderSetupDoctor();
    this.plugin.notify(result.ok ? "KnowledgeOS Core 连接正常" : result.error?.message || "连接失败", { error: !result.ok, force: true });
  }
}

  return { KnowledgeOSSettingTab };
}
module.exports = { createSettingsViews };
