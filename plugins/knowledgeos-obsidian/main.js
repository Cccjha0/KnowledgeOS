const { ItemView, Notice, Plugin, PluginSettingTab, Setting } = require("obsidian");
const { execFile } = require("node:child_process");

const VIEW_TYPE = "knowledgeos-today";
const DEFAULT_SETTINGS = {
  coreCliPath: "",
  vaultPath: "",
  openTodayOnStartup: true,
  autoRefresh: true,
};

class CoreCommandClient {
  constructor(settings) {
    this.settings = settings;
  }

  invoke(method, params = {}) {
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
    const requestId = `PLUGIN-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
      execFile(process.execPath, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
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
    this.addCommand({ id: "open-today", name: "Open Today", callback: () => this.activateToday() });
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
};
