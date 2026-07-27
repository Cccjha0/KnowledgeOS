const { ItemView, Modal, Notice, Plugin, PluginSettingTab, Setting } = require("obsidian");
const { execFile } = require("node:child_process");

const VIEW_TYPE = "knowledgeos-today";
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
      button.onclick = () => item.target && this.app.workspace.openLinkText(item.target, "", false);
      if (item.description) card.createDiv({ cls: "knowledgeos-description", text: item.description });
      card.createSpan({ cls: "knowledgeos-module", text: item.source_module });
    }
  }

  renderInbox(root, groups) {
    if (!groups?.length) return;
    root.createEl("h3", { text: "待处理 Inbox" });
    for (const group of groups) {
      root.createDiv({ cls: "knowledgeos-card", text: `${group.label}：${group.count} 项` });
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
    this.addRibbonIcon("calendar-check", "打开 KnowledgeOS Today", () => this.activateToday());
    this.addRibbonIcon("plus-circle", "Quick Capture", () => this.openCapture());
    this.addCommand({ id: "open-today", name: "Open Today", callback: () => this.activateToday() });
    this.addCommand({ id: "quick-capture", name: "Quick Capture", callback: () => this.openCapture() });
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
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) leaf.view.refresh();
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
};
