const { ItemView, Modal, Notice, Plugin, PluginSettingTab, Setting, setIcon } = require("obsidian");
const { execFile, spawn } = require("node:child_process");

const VIEW_TYPE = "knowledgeos-today";
const REVIEW_VIEW_TYPE = "knowledgeos-reviews";
const INBOX_VIEW_TYPE = "knowledgeos-inbox";
const SYSTEM_VIEW_TYPE = "knowledgeos-system";
const LIST_PAGE_SIZE = 50;
const DEFAULT_SETTINGS = {
  coreCliPath: "",
  nodePath: "node",
  vaultPath: "",
  networkProbeUrl: "",
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

function taskCycleChanged(data) {
  const created = [data?.startup_task?.created, data?.field_due?.created, data?.startup?.scheduler?.created];
  return created.some((items) => Array.isArray(items) && items.length > 0)
    || Array.isArray(data?.dispatch?.tasks) && data.dispatch.tasks.length > 0;
}

function shouldAutoRefreshPath(filePath) {
  const normalized = String(filePath || "").replaceAll("\\", "/");
  if (!normalized || normalized === "Today.md" || normalized.startsWith(".obsidian/")) return false;
  return !["90-System/Logs/", "90-System/Cache/", "90-System/Backups/"].some((prefix) => normalized.startsWith(prefix));
}

const STATUS_LABELS = {
  "not-open": "尚未开放",
  open: "开放申请",
  watching: "关注中",
  preparing: "准备中",
  submitted: "已提交",
  queued: "等待执行",
  running: "正在执行",
  "waiting-for-network": "等待网络",
  "waiting-for-ai": "等待 AI 可用",
  "waiting-for-user": "需要你的处理",
  deferred: "已延后",
  interrupted: "等待恢复",
  completed: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
  enabled: "已启用",
  disabled: "已停用",
  active: "使用中",
  paused: "已暂停",
  archived: "已归档",
  approved: "已批准",
  rejected: "已拒绝",
  pending: "待处理",
};

const MODULE_LABELS = {
  core: "KnowledgeOS",
  "application-tracker": "申请跟踪",
  "experience-log": "经历记录",
  "reading-log": "阅读记录",
};

const JOB_LABELS = {
  "core.daily-today": "更新今日页面",
  "core.startup-today": "启动时更新今日页面",
  "core.daily-quality-audit": "每日知识检查",
  "core.weekly-quality-audit": "每周知识检查",
  "core.monthly-quality-audit": "每月知识检查",
  "core.weekly-vault-audit": "每周 Vault 检查",
  "core.monthly-runtime-cleanup": "清理运行历史",
  "experience-log.weekly-review": "生成经历周报",
  "application-tracker.due-check": "检查到期申请",
};

const FIELD_LABELS = {
  tuition: "学费",
  deadline: "申请截止日期",
  application_open: "申请开放状态",
  application_status: "申请状态",
  english_requirement: "英语要求",
  academic_requirement: "学术要求",
};

function labelStatus(value) { return STATUS_LABELS[value] || String(value || "未知"); }
function labelModule(value) { return MODULE_LABELS[value] || String(value || "系统"); }
function labelJob(value) { return JOB_LABELS[value] || String(value || "系统任务").replaceAll("-", " "); }
function labelField(value) { return FIELD_LABELS[value] || String(value || "信息").replaceAll("_", " "); }

function friendlyAction(value) {
  const text = String(value || "").trim();
  if (!text) return "系统任务";
  const dueRequests = text.match(/^Create (\d+) due application Research Request\(s\)\.$/i);
  if (dueRequests) return `已创建 ${dueRequests[1]} 个到期申请核验请求`;
  const createdRequests = text.match(/^Create(?:d)? (\d+) Research Request/i);
  if (createdRequests) return `已创建 ${createdRequests[1]} 个申请核验请求`;
  if (/today/i.test(text) && /build|refresh|update/i.test(text)) return "已更新今日页面";
  if (/quality audit/i.test(text)) return "已完成知识质量检查";
  if (/vault audit/i.test(text)) return "已完成 Vault 检查";
  if (/runtime cleanup/i.test(text)) return "已清理运行历史";
  return labelJob(text);
}

function calendarDayDifference(value, now = new Date()) {
  const date = new Date(value);
  const reference = new Date(now);
  if (Number.isNaN(date.getTime()) || Number.isNaN(reference.getTime())) return null;
  const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
  const currentDay = Date.parse(`${dateKey.format(reference)}T00:00:00Z`);
  const targetDay = Date.parse(`${dateKey.format(date)}T00:00:00Z`);
  return Math.round((targetDay - currentDay) / 86_400_000);
}

function formatTime(value, options = {}) {
  if (!value) return "时间未设置";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const now = options.now ? new Date(options.now) : new Date();
  const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
  const current = dateKey.format(now);
  const target = dateKey.format(date);
  const currentDay = Date.parse(`${current}T00:00:00Z`);
  const targetDay = Date.parse(`${target}T00:00:00Z`);
  const days = Math.round((targetDay - currentDay) / 86_400_000);
  const time = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  if (days === 0) return `今天 ${time}`;
  if (days === 1) return `明天 ${time}`;
  if (days === -1) return `昨天 ${time}`;
  if (days > 1 && days < 7) return `${days} 天后`;
  if (days < -1 && days > -7) return `${Math.abs(days)} 天前`;
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function formatVerificationSchedule(value) {
  const days = calendarDayDifference(value);
  if (days !== null && days < 0) return `核验已逾期 ${Math.abs(days)} 天`;
  return `下次核验：${formatTime(value)}`;
}

function createTime(element, value, prefix = "") {
  const node = element.createSpan({ cls: "knowledgeos-time", text: `${prefix}${formatTime(value)}` });
  if (value) node.setAttr("title", String(value));
  return node;
}

function friendlyDashboardDescription(description) {
  const text = String(description || "").trim();
  if (!text) return "";
  const verify = text.match(/^Verify:\s*(.+)$/i);
  if (verify) return `需要核验：${labelField(verify[1])}`;
  const researchPending = text.match(/^Research pending:\s*(.+)$/i);
  if (researchPending) return `核验请求已创建，等待研究结果：${labelField(researchPending[1])}`;
  const parts = text.split(" | ");
  if (parts.length === 1) {
    if (text === "assign-owner") return "选择这个文件的归属位置";
    if (text === "unowned-file") return "这个文件还没有归类";
    return text;
  }
  const values = {};
  for (const part of parts) {
    const index = part.indexOf(":");
    if (index > 0) values[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  const result = [];
  const openResearchRequest = values["Research request"] && values["Research request"] !== "none";
  if (openResearchRequest) {
    result.push("核验请求已创建，等待研究结果");
    delete values["Next check"];
  } else if (values["Next check"] && calendarDayDifference(values["Next check"]) < 0) {
    result.push(formatVerificationSchedule(values["Next check"]));
    delete values["Next check"];
  }
  if (values["Next action"]) result.push(values["Next action"]);
  if (values.Status && !String(values["Next action"] || "").includes(labelStatus(values.Status))) result.push(`当前状态：${labelStatus(values.Status)}`);
  if (values["Next check"]) result.push(`下次核验：${formatTime(values["Next check"])}`);
  if (Number(values["Pending reviews"]) > 0) result.push(`待审核 ${values["Pending reviews"]} 项`);
  if (values.Materials && values.Materials !== "0/0") result.push(`材料 ${values.Materials}`);
  return result.join(" · ") || text;
}

function friendlyDashboardTitle(title) {
  const text = String(title || "").trim();
  if (text === "unowned-file") return "文件尚未归类";
  if (text === "assign-owner") return "选择文件归属";
  if (/^Research Request(?:\s+REQ-[\w-]+)?$/i.test(text)) return "申请信息核验";
  return text || "待处理事项";
}

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

class CoreCommandClient {
  constructor(settings) {
    this.settings = settings;
    this.server = null;
    this.serverKey = null;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.pending = new Map();
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
    if (this.ensureServer()) {
      return new Promise((resolve) => {
        this.pending.set(requestId, resolve);
        try {
          this.server.stdin.write(`${JSON.stringify({ request_id: requestId, method, params })}\n`, (error) => {
            if (!error) return;
            this.pending.delete(requestId);
            resolve(this.failure(error.message));
          });
        } catch (error) {
          this.pending.delete(requestId);
          resolve(this.failure(error instanceof Error ? error.message : String(error)));
        }
      });
    }
    return this.invokeOnce(method, params, requestId);
  }

  invokeOnce(method, params, requestId) {
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

  ensureServer() {
    const key = JSON.stringify([this.settings.nodePath || "node", this.settings.coreCliPath, this.settings.vaultPath]);
    if (this.server && this.serverKey === key && !this.server.killed) return true;
    this.close();
    try {
      this.server = spawn(this.settings.nodePath || "node", [
        this.settings.coreCliPath,
        "api-server",
        "--vault",
        this.settings.vaultPath,
      ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      this.serverKey = key;
      this.stdoutBuffer = "";
      this.stderrBuffer = "";
      const server = this.server;
      server.stdout.on("data", (chunk) => this.handleServerOutput(String(chunk)));
      server.stderr.on("data", (chunk) => { this.stderrBuffer = `${this.stderrBuffer}${String(chunk)}`.slice(-4096); });
      server.on("error", (error) => this.handleServerExit(server, error));
      server.on("exit", (code) => this.handleServerExit(server, new Error(this.stderrBuffer || `Core API server exited with status ${code}.`)));
      return true;
    } catch {
      this.server = null;
      this.serverKey = null;
      return false;
    }
  }

  handleServerOutput(chunk) {
    this.stdoutBuffer += chunk;
    while (this.stdoutBuffer.includes("\n")) {
      const newline = this.stdoutBuffer.indexOf("\n");
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        const response = JSON.parse(line);
        const resolve = this.pending.get(response.request_id);
        if (!resolve) continue;
        this.pending.delete(response.request_id);
        resolve(response);
      } catch { /* Wait for the next valid response; process exit reports malformed output. */ }
    }
  }

  handleServerExit(server, error) {
    if (this.server !== server) return;
    this.server = null;
    this.serverKey = null;
    for (const resolve of this.pending.values()) resolve(this.failure(error.message));
    this.pending.clear();
  }

  failure(message) {
    return {
      ok: false,
      state: "failed",
      error: {
        message,
        impact: "本次界面操作没有得到 Core 确认。",
        recovery_actions: ["检查 Core CLI 路径", "在设置页测试连接"],
      },
    };
  }

  close() {
    const server = this.server;
    this.server = null;
    this.serverKey = null;
    for (const resolve of this.pending.values()) resolve(this.failure("Core API server is restarting."));
    this.pending.clear();
    if (server && !server.killed) server.stdin.end();
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
    this.modules = [];
    this.instances = [];
    this.contextTouched = false;
    this.contextLoading = false;
    this.previewLoadedAt = null;
    this.preview = { destination_label: "正在识别当前上下文…", module_id: null, instance_id: null };
    this.renderForm();
    await this.loadContext();
  }

  async loadContext(preserve = false) {
    if (this.contextLoading) return;
    this.contextLoading = true;
    this.renderDestinationState("正在识别当前上下文…", "loading");
    const [modulesResponse, instancesResponse, previewResponse] = await Promise.all([
      this.plugin.client.invoke("getModules", {}),
      this.plugin.client.invoke("getInstances", {}),
      this.plugin.client.invoke("createCapture", { preview_only: true, active_path: this.contextPath }, this.requestId),
    ]);
    this.contextLoading = false;
    const warnings = [];
    if (modulesResponse.ok && Array.isArray(modulesResponse.data)) this.modules = modulesResponse.data.filter((module) => module.status === "enabled");
    else warnings.push("模块列表");
    if (instancesResponse.ok && Array.isArray(instancesResponse.data)) this.instances = instancesResponse.data.filter((instance) => instance.status === "active");
    else warnings.push("实例列表");
    if (previewResponse.ok && previewResponse.data) {
      this.preview = previewResponse.data;
      this.previewLoadedAt = new Date().toISOString();
    } else warnings.push("保存位置预览");
    this.populateModuleOptions();
    if (this.contextTouched) {
      this.refreshInstanceOptions(this.instanceSelect.value);
      this.renderManualDestination();
    } else if (this.preview.instance_id && this.hasModuleOption(this.preview.module_id) && this.hasInstanceOption(this.preview.instance_id)) {
      this.moduleSelect.value = this.preview.module_id;
      this.refreshInstanceOptions(this.preview.instance_id);
    } else if (this.preview.module_id && this.hasModuleOption(this.preview.module_id)) {
      this.moduleSelect.value = this.preview.module_id;
      this.refreshInstanceOptions("__none__");
    } else if (!previewResponse.ok) {
      this.moduleSelect.value = "__auto__";
      this.refreshInstanceOptions("__auto__");
    } else {
      this.moduleSelect.value = "__global__";
      this.refreshInstanceOptions("__none__");
    }
    if (!this.contextTouched) {
      if (previewResponse.ok) this.renderDestinationState(`将保存到：${this.preview.destination_label}`, "ready");
      else if (preserve && this.previewLoadedAt) this.renderDestinationState(`显示的是上次识别的保存位置：${this.preview.destination_label}`, "stale", true);
      else this.renderDestinationState("保存位置暂时无法预览；保存时将由 Core 再次判断。", "warning", true);
    }
    this.renderContextNotice(warnings, modulesResponse.error || instancesResponse.error || previewResponse.error);
    if (warnings.length) this.routingDetails.open = true;
  }

  renderForm() {
    const root = this.contentEl;
    const header = root.createEl("header", { cls: "knowledgeos-capture-header" });
    header.createEl("h2", { text: "快速记录" });
    if (this.contextPath) header.createDiv({ cls: "knowledgeos-capture-context", text: `基于当前文件：${this.contextPath.split("/").pop() || this.contextPath}` });
    this.destinationEl = markLiveRegion(root.createDiv({ cls: "knowledgeos-destination" }));
    this.contextNoticeEl = root.createDiv({ cls: "knowledgeos-capture-context-notice" });

    const contentLabel = root.createEl("label", { cls: "knowledgeos-capture-field" });
    contentLabel.createSpan({ cls: "knowledgeos-capture-label", text: "内容" });
    this.contentInput = contentLabel.createEl("textarea", { placeholder: "记录此刻的想法…" });
    this.contentInput.rows = 8;

    const titleLabel = root.createEl("label", { cls: "knowledgeos-capture-field" });
    titleLabel.createSpan({ cls: "knowledgeos-capture-label", text: "标题" });
    titleLabel.createSpan({ cls: "knowledgeos-capture-help", text: "留空时使用内容第一行" });
    this.titleInput = titleLabel.createEl("input", { type: "text", placeholder: "可选标题" });

    this.routingDetails = root.createEl("details", { cls: "knowledgeos-capture-disclosure" });
    this.routingDetails.createEl("summary", { text: "保存位置与类型" });
    const row = this.routingDetails.createDiv({ cls: "knowledgeos-capture-row" });
    const moduleLabel = row.createEl("label", { cls: "knowledgeos-capture-field" });
    moduleLabel.createSpan({ cls: "knowledgeos-capture-label", text: "模块" });
    this.moduleSelect = moduleLabel.createEl("select");
    this.populateModuleOptions();

    const instanceLabel = row.createEl("label", { cls: "knowledgeos-capture-field" });
    instanceLabel.createSpan({ cls: "knowledgeos-capture-label", text: "实例" });
    this.instanceSelect = instanceLabel.createEl("select");
    this.refreshInstanceOptions();

    this.moduleSelect.onchange = () => { this.contextTouched = true; this.refreshInstanceOptions("__none__"); this.renderManualDestination(); };
    this.instanceSelect.onchange = () => { this.contextTouched = true; this.renderManualDestination(); };

    const typeLabel = row.createEl("label", { cls: "knowledgeos-capture-field" });
    typeLabel.createSpan({ cls: "knowledgeos-capture-label", text: "类型" });
    this.typeSelect = typeLabel.createEl("select");
    for (const [value, label] of [["note", "笔记"], ["idea", "想法"], ["task", "任务"], ["log", "记录"], ["other", "其他"]]) {
      this.typeSelect.createEl("option", { value, text: label });
    }

    const attachments = root.createEl("details", { cls: "knowledgeos-capture-disclosure" });
    attachments.createEl("summary", { text: "附件 · 0 个" });
    const attachmentLabel = attachments.createEl("label", { cls: "knowledgeos-capture-field" });
    attachmentLabel.createSpan({ cls: "knowledgeos-capture-label", text: "Vault 相对路径" });
    attachmentLabel.createSpan({ cls: "knowledgeos-capture-help", text: "多个路径使用逗号分隔" });
    this.attachmentInput = attachmentLabel.createEl("input", { type: "text", placeholder: "Attachments/example.pdf" });
    this.attachmentInput.oninput = () => {
      const count = this.attachmentInput.value.split(",").map((item) => item.trim()).filter(Boolean).length;
      attachments.querySelector("summary").setText(`附件 · ${count} 个`);
    };

    this.statusEl = markLiveRegion(root.createDiv({ cls: "knowledgeos-capture-status" }), "assertive");
    const actions = root.createDiv({ cls: "knowledgeos-capture-actions" });
    this.saveButton = actions.createEl("button", { cls: "mod-cta", text: "保存" });
    this.saveButton.onclick = () => this.save();
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.onclick = () => this.close();
    root.onkeydown = (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void this.save(); }
    };
    this.contentInput.focus();
  }

  renderDestinationState(text, tone = "ready", retry = false) {
    this.destinationEl.empty();
    this.destinationEl.removeClass("is-loading"); this.destinationEl.removeClass("is-warning"); this.destinationEl.removeClass("is-stale"); this.destinationEl.removeClass("is-ready");
    this.destinationEl.addClass(`is-${tone}`);
    this.destinationEl.createSpan({ text });
    if (retry) {
      const button = this.destinationEl.createEl("button", { text: "重试识别" });
      button.onclick = () => this.loadContext(true);
    }
  }

  renderContextNotice(warnings, error) {
    this.contextNoticeEl.empty();
    this.contextNoticeEl.removeClass("is-warning");
    if (!warnings.length) return;
    this.contextNoticeEl.addClass("is-warning");
    this.contextNoticeEl.createDiv({ text: `部分上下文暂时不可用：${warnings.join("、")}。表单仍可保存。` });
    if (error?.message) this.contextNoticeEl.createDiv({ cls: "knowledgeos-capture-help", text: error.message });
  }

  renderManualDestination() {
    const moduleValue = this.moduleSelect.value;
    const instanceValue = this.instanceSelect.value;
    if (moduleValue === "__auto__" && instanceValue === "__auto__") this.renderDestinationState("保存时将根据当前上下文自动判断位置。", "stale");
    else if (moduleValue === "__global__") this.renderDestinationState("将保存到：全局 Inbox", "ready");
    else {
      const moduleLabel = this.moduleSelect.selectedOptions?.[0]?.text || "所选模块";
      const instanceLabel = instanceValue.startsWith("__") ? "不指定实例" : this.instanceSelect.selectedOptions?.[0]?.text || "所选实例";
      this.renderDestinationState(`将按你的选择保存：${moduleLabel} / ${instanceLabel}`, "ready");
    }
  }

  populateModuleOptions() {
    if (!this.moduleSelect) return;
    const selected = this.moduleSelect.value || "__auto__";
    this.moduleSelect.empty();
    this.moduleSelect.createEl("option", { value: "__auto__", text: "自动判断" });
    this.moduleSelect.createEl("option", { value: "__global__", text: "全局 Inbox" });
    for (const module of this.modules || []) this.moduleSelect.createEl("option", { value: module.id, text: module.name });
    this.moduleSelect.value = selected;
    if (!this.moduleSelect.value) this.moduleSelect.value = "__auto__";
  }

  hasModuleOption(moduleId) {
    return Boolean(moduleId && (this.modules || []).some((module) => module.id === moduleId));
  }

  hasInstanceOption(instanceId) {
    return Boolean(instanceId && (this.instances || []).some((instance) => instance.instance_id === instanceId));
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
    if (!this.instanceSelect.value) this.instanceSelect.value = "__auto__";
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
    if (this.saveButton.disabled) return;
    if (!this.contentInput.value.trim()) {
      this.setCaptureStatus("请输入内容。", "error");
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
    this.contentEl.setAttr("aria-busy", "true");
    this.setCaptureStatus("正在保存；可以关闭窗口，Core 会继续处理…", "loading");
    const response = await this.plugin.client.invoke("createCapture", params, this.requestId);
    this.saveButton.disabled = false;
    this.contentEl.setAttr("aria-busy", "false");
    if (!response.ok) {
      this.setCaptureStatus(response.error?.message || "保存失败，输入内容已保留。", "error");
      if (response.error?.impact) this.statusEl.createDiv({ cls: "knowledgeos-impact", text: response.error.impact });
      if (response.error?.recovery_actions?.length) this.statusEl.createDiv({ cls: "knowledgeos-capture-help", text: `建议：${response.error.recovery_actions.join("；")}` });
      this.saveButton.focus();
      return;
    }
    this.renderSuccess(response.data);
  }

  setCaptureStatus(text, tone = "normal") {
    this.statusEl.empty();
    this.statusEl.removeClass("is-error"); this.statusEl.removeClass("is-loading"); this.statusEl.removeClass("is-warning");
    if (tone !== "normal") this.statusEl.addClass(`is-${tone}`);
    if (text) this.statusEl.createDiv({ text });
  }

  renderSuccess(result) {
    const root = this.contentEl;
    root.empty();
    root.setAttr("aria-busy", "false");
    const success = root.createEl("section", { cls: "knowledgeos-capture-success" });
    const icon = success.createSpan({ cls: "knowledgeos-capture-success-icon", attr: { "aria-hidden": "true" } }); setIcon(icon, "circle-check");
    success.createEl("h2", { text: "已保存" });
    success.createEl("p", { text: `已保存到 ${result.destination_label}` });
    success.createEl("code", { text: result.path });
    const actions = root.createDiv({ cls: "knowledgeos-capture-actions" });
    const open = actions.createEl("button", { cls: "mod-cta", text: "打开文件" });
    open.onclick = async () => { await this.app.workspace.openLinkText(result.path, "", false); this.close(); };
    const again = actions.createEl("button", { text: "继续记录" });
    again.onclick = () => { this.close(); new QuickCaptureModal(this.app, this.plugin, this.contextPath).open(); };
    const done = actions.createEl("button", { text: "完成" });
    done.onclick = () => this.close();
    open.focus();
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
    if (selectedReviewId) this.pendingReviewId = selectedReviewId;
    if (this.loadPromise) {
      this.loadQueued = true;
      return this.loadPromise;
    }
    this.loadPromise = (async () => {
      do {
        this.loadQueued = false;
        const nextReviewId = this.pendingReviewId;
        this.pendingReviewId = null;
        await this.performReviewLoad(nextReviewId);
      } while (this.loadQueued);
    })();
    try { await this.loadPromise; }
    finally { this.loadPromise = null; }
  }

  async performReviewLoad(selectedReviewId = null) {
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
    if (selectedReviewId) {
      const selected = this.reviews.find((review) => review.review_id === selectedReviewId);
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
    this.listEl.empty();
    const section = this.listEl.createEl("section", { cls: "knowledgeos-review-results", attr: { "aria-label": "审核事项" } });
    for (const review of this.reviews.slice(0, this.visibleLimit)) {
      const card = section.createEl("article", { cls: `knowledgeos-review-item priority-${review.priority} status-${review.status}` });
      const heading = card.createDiv({ cls: "knowledgeos-review-item-heading" });
      const title = heading.createEl("button", { cls: "knowledgeos-link knowledgeos-review-item-title", text: review.title });
      title.onclick = () => this.renderDetail(review);
      const state = heading.createDiv({ cls: "knowledgeos-review-item-state" });
      state.createSpan({ cls: `knowledgeos-review-priority is-${review.priority}`, text: this.priorityLabel(review.priority) });
      state.createSpan({ text: this.reviewStatusLabel(review.status) });
      const subject = review.field ? `${labelField(review.field)} · ${this.actionLabel(review.action)}` : this.actionLabel(review.action);
      card.createDiv({ cls: "knowledgeos-review-subject", text: subject });
      const context = card.createDiv({ cls: "knowledgeos-review-item-context" });
      context.createSpan({ text: this.moduleName(review.source_module) });
      if (review.instance_id) context.createSpan({ text: this.instanceName(review.instance_id) });
      createTime(context, review.created_at, "创建于 ");
      if (review.target_state === "changed") card.createDiv({ cls: "knowledgeos-review-row-warning", text: "目标文件已修改，需要重新确认。" });
      else if (review.target_state === "unavailable") card.createDiv({ cls: "knowledgeos-review-row-warning is-error", text: "当前无法读取目标字段。" });
      addCardArrow(heading);
    }
    if (this.reviews.length > this.visibleLimit) {
      const more = this.listEl.createEl("button", { cls: "knowledgeos-review-load-more", text: `加载更多（剩余 ${this.reviews.length - this.visibleLimit}）` });
      more.onclick = () => { this.visibleLimit += LIST_PAGE_SIZE; this.renderReviewList(); };
    }
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
    const root = this.listEl;
    root.empty();
    const detail = root.createEl("article", { cls: `knowledgeos-review-detail priority-${review.priority} status-${review.status}` });
    const navigation = detail.createDiv({ cls: "knowledgeos-review-detail-navigation" });
    const back = navigation.createEl("button", { text: "← 返回审核列表" });
    back.onclick = () => this.loadReviews();
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
      discuss.onclick = () => new ReviewDiscussionModal(this.app, this.plugin, review, () => this.loadReviews()).open();
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
    button.onclick = () => new ReviewActionModal(this.app, this.plugin, review, decision, () => this.loadReviews()).open();
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
    await this.loadReviews();
  }
}

class InboxCenterView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.selectedRoutes = new Map();
    this.expandedItems = new Set();
    this.pendingItemIds = new Set();
    this.itemActionErrors = new Map();
    this.visibleLimit = LIST_PAGE_SIZE;
    this.listing = null;
    this.refreshPromise = null;
    this.refreshQueued = false;
    this.pendingSelectedItemId = null;
    this.backgroundStatus = null;
    this.partialWarnings = [];
    this.lastSuccessfulAt = null;
  }
  getViewType() { return INBOX_VIEW_TYPE; }
  getDisplayText() { return "KnowledgeOS Inbox"; }
  getIcon() { return "inbox"; }
  async onOpen() { await this.refresh(); }

  async refresh(selectedItemId = null) {
    if (selectedItemId) this.pendingSelectedItemId = selectedItemId;
    if (this.refreshPromise) {
      this.refreshQueued = true;
      return this.refreshPromise;
    }
    this.refreshPromise = (async () => {
      do {
        this.refreshQueued = false;
        const nextSelectedItemId = this.pendingSelectedItemId;
        this.pendingSelectedItemId = null;
        await this.performRefresh(nextSelectedItemId);
      } while (this.refreshQueued);
    })();
    try { await this.refreshPromise; }
    finally { this.refreshPromise = null; }
  }

  async performRefresh(selectedItemId = null) {
    const root = this.contentEl;
    root.addClass("knowledgeos-inbox-center");
    const preserveContent = this.listing !== null && root.childElementCount > 0;
    if (preserveContent) this.renderBackgroundStatus("更新中…");
    else renderLoadingSkeleton(root, "正在加载 Inbox…");
    if (!preserveContent) this.decorateLoadingShell(root);
    const response = await this.plugin.client.invoke("getInboxCenterSnapshot", {});
    if (!response.ok) {
      const error = response.error;
      if (preserveContent) this.renderStaleStatus(error);
      else this.renderFailure(error);
      return;
    }
    if (!response.data?.inbox) {
      const error = { message: "Core 没有返回可用的 Inbox 数据。", impact: "已有文件没有被修改。", recovery_actions: ["重试加载 Inbox"] };
      if (preserveContent) this.renderStaleStatus(error);
      else this.renderFailure(error);
      return;
    }
    this.listing = response.data.inbox;
    this.partialWarnings = [];
    this.modules = Array.isArray(response.data.modules) ? response.data.modules : [];
    this.instances = Array.isArray(response.data.instances) ? response.data.instances : [];
    if (!Array.isArray(response.data.modules)) this.partialWarnings.push("模块信息暂时不可用");
    if (!Array.isArray(response.data.instances)) this.partialWarnings.push("实例信息暂时不可用");
    this.lastSuccessfulAt = this.listing.generated_at || new Date().toISOString();
    this.render(selectedItemId);
  }

  renderPageHeader(root, loading = false) {
    const header = root.createDiv({ cls: "knowledgeos-page-header knowledgeos-inbox-header" });
    const heading = header.createDiv({ cls: "knowledgeos-inbox-heading" });
    heading.createEl("h2", { text: "Inbox" });
    heading.createDiv({ cls: "knowledgeos-page-subtitle", text: "待整理内容和需要确认的归属" });
    const actions = header.createDiv({ cls: "knowledgeos-header-actions" });
    const refresh = createToolbarButton(actions, "refresh-cw", "刷新 Inbox", { iconOnly: true });
    refresh.disabled = loading;
    refresh.onclick = () => this.refresh();
    return { header, actions };
  }

  decorateLoadingShell(root) {
    root.setAttr("aria-busy", "true");
    this.backgroundStatus = null;
    const { header } = this.renderPageHeader(root, true);
    root.prepend(header);
  }

  renderFailure(error) {
    const root = this.contentEl;
    root.empty();
    root.addClass("knowledgeos-inbox-center");
    root.removeAttribute("aria-busy");
    this.backgroundStatus = null;
    this.renderPageHeader(root);
    const body = root.createDiv({ cls: "knowledgeos-inbox-failure" });
    renderRecoverableError(body, "无法加载 Inbox", error, () => this.refresh());
  }

  renderBackgroundStatus(text, failed = false, retry = false) {
    this.backgroundStatus?.remove();
    const status = markLiveRegion(this.contentEl.createDiv({ cls: `knowledgeos-inbox-refresh-state${failed ? " is-error is-stale" : ""}` }));
    status.createSpan({ text });
    if (retry) {
      const button = status.createEl("button", { text: "重试" });
      button.onclick = () => this.refresh();
    }
    this.contentEl.prepend(status);
    this.backgroundStatus = status;
  }

  renderStaleStatus(error) {
    const updated = this.lastSuccessfulAt ? ` · 上次更新：${formatTime(this.lastSuccessfulAt)}` : "";
    const reason = error?.message ? `：${error.message}` : "";
    this.renderBackgroundStatus(`显示的是上次成功加载的内容${updated}${reason}`, true, true);
  }

  render(selectedItemId = null) {
    const root = this.contentEl;
    const scrollTop = root.scrollTop;
    root.empty();
    root.addClass("knowledgeos-inbox-center");
    root.removeAttribute("aria-busy");
    this.backgroundStatus = null;
    this.renderPageHeader(root);
    const eligible = this.listing.items.filter((item) => item.confidence >= item.auto_route_threshold && !item.requires_ai);

    const overview = root.createDiv({ cls: "knowledgeos-inbox-overview" });
    const summaryParts = [];
    if (this.listing.counts.total) summaryParts.push(`${this.listing.counts.total} 个待整理`);
    if (this.listing.counts.needs_routing) summaryParts.push(`${this.listing.counts.needs_routing} 个需要选择归属`);
    if (this.listing.counts.failed) summaryParts.push(`${this.listing.counts.failed} 个失败`);
    if (this.listing.counts.waiting_for_ai) summaryParts.push(`${this.listing.counts.waiting_for_ai} 个等待 AI`);
    if (summaryParts.length) overview.createDiv({ cls: "knowledgeos-inbox-summary-line", text: summaryParts.join(" · ") });
    if (this.lastSuccessfulAt) {
      const updated = overview.createDiv({ cls: "knowledgeos-inbox-updated" });
      const time = createTime(updated, this.lastSuccessfulAt, "更新于 ");
      time.addClass("knowledgeos-inbox-created");
    }
    if (this.plugin.settings.allowBatchOperations && eligible.length > 0) {
      const batch = overview.createEl("button", { cls: "mod-cta knowledgeos-inbox-batch", text: `处理 ${eligible.length} 个高置信度条目` });
      batch.onclick = () => this.processBatch(eligible, batch);
    }

    if (this.resultMessage) markLiveRegion(root.createDiv({ cls: "knowledgeos-inbox-result", text: this.resultMessage }));
    if (this.partialWarnings.length) {
      const partial = markLiveRegion(root.createDiv({ cls: "knowledgeos-inbox-partial" }));
      partial.createDiv({ text: `部分归属信息暂时不可用：${this.partialWarnings.join("；")}。文件列表仍然可以查看。` });
      const retry = partial.createEl("button", { text: "重试" });
      retry.onclick = () => this.refresh();
    }
    if (!this.listing.items.length) {
      const empty = root.createDiv({ cls: "knowledgeos-inbox-empty" });
      const icon = empty.createSpan({ cls: "knowledgeos-inbox-empty-icon", attr: { "aria-hidden": "true" } });
      setIcon(icon, "circle-check");
      empty.createEl("h3", { text: "Inbox 已整理完毕" });
      empty.createDiv({ text: "当前没有需要处理的内容。" });
      return;
    }

    const sections = [
      ["attention", "需要处理", (item) => ["failed", "waiting-for-user"].includes(item.state)],
      ["ready", "可以整理", (item) => item.state === "pending"],
      ["waiting", "等待系统", (item) => ["waiting-for-ai", "processing"].includes(item.state)],
      ["deferred", "已延后", (item) => item.state === "deferred"],
      ["other", "其他", (item) => !["failed", "waiting-for-user", "pending", "waiting-for-ai", "processing", "deferred"].includes(item.state)],
    ];
    let rendered = 0;
    for (const [id, label, matches] of sections) {
      if (rendered >= this.visibleLimit) break;
      const items = this.listing.items.filter(matches);
      const visibleItems = items.slice(0, this.visibleLimit - rendered);
      if (!visibleItems.length) continue;
      let section;
      if (id === "deferred") {
        const disclosure = root.createEl("details", { cls: "knowledgeos-inbox-section knowledgeos-inbox-deferred" });
        disclosure.createEl("summary", { text: `${label} · ${items.length}` });
        section = disclosure.createDiv({ cls: "knowledgeos-inbox-list" });
      } else {
        const wrapper = root.createEl("section", { cls: `knowledgeos-inbox-section is-${id}`, attr: { "aria-label": label } });
        wrapper.createEl("h3", { text: `${label} · ${items.length}` });
        section = wrapper.createDiv({ cls: "knowledgeos-inbox-list" });
      }
      for (const item of visibleItems) this.renderItem(section, item, item.item_id === selectedItemId);
      rendered += visibleItems.length;
    }
    if (this.listing.items.length > rendered) {
      const more = root.createEl("button", { cls: "knowledgeos-inbox-load-more", text: `加载更多（还有 ${this.listing.items.length - rendered} 项）` });
      more.onclick = () => { this.visibleLimit += LIST_PAGE_SIZE; this.render(selectedItemId); };
    }
    root.scrollTop = scrollTop;
  }

  selectedRoute(item) {
    return this.selectedRoutes.get(item.item_id) || {
      module_id: item.suggested_module_id,
      instance_id: item.suggested_instance_id,
    };
  }

  moduleName(moduleId) {
    return this.modules.find((module) => module.id === moduleId)?.name || (moduleId ? labelModule(moduleId) : null);
  }

  instanceName(instanceId) {
    return this.instances.find((instance) => instance.instance_id === instanceId)?.display_name || instanceId || null;
  }

  ownershipText(item) {
    const route = this.selectedRoute(item);
    const module = this.moduleName(route.module_id);
    const instance = this.instanceName(route.instance_id);
    if (!module) return "需要选择模块或实例";
    return `建议归入：${module}${instance ? ` / ${instance}` : ""}`;
  }

  inboxStateLabel(state) {
    return ({ pending: "可以处理", processing: "正在处理", "waiting-for-user": "需要选择", "waiting-for-ai": "等待 AI", failed: "处理失败", deferred: "已延后" })[state] || labelStatus(state);
  }

  friendlyReason(item) {
    const labels = {
      "located-in-instance-inbox": "来自实例 Inbox",
      "located-in-module-inbox": "来自模块 Inbox",
      "valid-instance-hint": "文件包含有效实例信息",
      "valid-module-hint": "文件包含有效模块信息",
      "structured-application-research-report": "识别为结构化申请研究报告",
      "no-reliable-route": "尚无可靠归属",
    };
    return item.reasons.map((reason) => labels[reason] || reason.replaceAll("-", " ")).join("；") || "尚无可靠路由依据";
  }

  formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  renderItem(root, item, selected) {
    const pending = this.pendingItemIds.has(item.item_id);
    const card = root.createEl("article", { cls: `knowledgeos-inbox-item state-${item.state}${pending ? " is-busy" : ""}`, attr: { "aria-busy": String(pending) } });
    const heading = card.createDiv({ cls: "knowledgeos-inbox-item-heading" });
    const title = heading.createEl("button", { cls: "knowledgeos-link knowledgeos-inbox-item-title", text: item.title });
    title.onclick = () => this.app.workspace.openLinkText(item.path, "", false);
    heading.createSpan({ cls: `knowledgeos-inbox-item-status state-${item.state}`, text: this.inboxStateLabel(item.state) });
    card.createDiv({ cls: `knowledgeos-inbox-ownership${item.suggested_module_id ? "" : " is-unresolved"}`, text: this.ownershipText(item) });
    card.createDiv({ cls: "knowledgeos-inbox-reason", text: this.friendlyReason(item) });
    const visibleError = this.itemActionErrors.get(item.item_id) || item.error;
    if (visibleError) markLiveRegion(card.createDiv({ cls: "knowledgeos-inbox-item-error", text: visibleError }), "assertive");
    if (item.requires_ai) card.createDiv({ cls: "knowledgeos-inbox-ai", text: "需要 Codex 或模块工作流继续处理。" });

    const footer = card.createDiv({ cls: "knowledgeos-inbox-item-footer" });
    const meta = footer.createDiv({ cls: "knowledgeos-inbox-item-meta" });
    meta.createSpan({ text: item.content_type || "文件" });
    const time = createTime(meta, item.created_at, " · ");
    time.addClass("knowledgeos-inbox-created");
    const primary = footer.createEl("button", { cls: "mod-cta knowledgeos-inbox-primary", text: pending ? "处理中…" : item.state === "failed" ? "重试" : item.state === "waiting-for-user" ? "选择归属" : item.state === "waiting-for-ai" ? "继续处理" : item.state === "deferred" ? "立即处理" : "处理" });
    primary.disabled = pending;

    const route = this.selectedRoute(item);
    const details = card.createEl("details", { cls: "knowledgeos-inbox-details" });
    if (selected || this.expandedItems.has(item.item_id)) details.open = true;
    details.createEl("summary", { text: "详细信息" });
    details.ontoggle = () => details.open ? this.expandedItems.add(item.item_id) : this.expandedItems.delete(item.item_id);
    const detailBody = details.createDiv({ cls: "knowledgeos-inbox-detail-body" });
    const routeFieldset = detailBody.createEl("fieldset", { cls: "knowledgeos-inbox-route" });
    routeFieldset.createEl("legend", { text: "归属" });
    const moduleLabel = routeFieldset.createEl("label", { text: "模块" });
    const moduleSelect = moduleLabel.createEl("select");
    moduleSelect.createEl("option", { value: "", text: "选择模块…" });
    for (const module of this.modules) moduleSelect.createEl("option", { value: module.id, text: module.name });
    moduleSelect.value = route.module_id || "";
    const instanceLabel = routeFieldset.createEl("label", { text: "实例" });
    const instanceSelect = instanceLabel.createEl("select");
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
    moduleSelect.onchange = () => { route.instance_id = null; this.selectedRoutes.set(item.item_id, { module_id: moduleSelect.value || null, instance_id: null }); populateInstances(); };
    instanceSelect.onchange = saveRoute;
    moduleSelect.disabled = pending || this.partialWarnings.length > 0;
    instanceSelect.disabled = pending || this.partialWarnings.length > 0;

    if (item.state === "waiting-for-user") {
      primary.onclick = () => { details.open = true; this.expandedItems.add(item.item_id); moduleSelect.focus(); };
      const process = routeFieldset.createEl("button", { cls: "mod-cta knowledgeos-inbox-route-process", text: pending ? "处理中…" : "处理" });
      process.disabled = pending || this.partialWarnings.length > 0;
      process.onclick = () => this.processItem(item, "process", {}, card);
    } else {
      primary.onclick = () => this.processItem(item, item.state === "failed" ? "retry" : "process", {}, card);
    }

    detailBody.createDiv({ cls: "knowledgeos-inbox-detail-label", text: "判断依据" });
    detailBody.createDiv({ cls: "knowledgeos-inbox-detail-value", text: this.friendlyReason(item) });

    const actions = detailBody.createDiv({ cls: "knowledgeos-inbox-secondary-actions" });
    const preview = actions.createEl("button", { text: "预览" });
    preview.disabled = pending;
    preview.onclick = () => this.previewItem(item, card);
    const open = actions.createEl("button", { text: "打开" });
    open.onclick = () => this.app.workspace.openLinkText(item.path, "", false);
    const defer = actions.createEl("button", { text: "明天提醒" });
    defer.disabled = pending;
    defer.onclick = () => this.processItem(item, "defer", { review_after: new Date(Date.now() + 86_400_000).toISOString() }, card);
    const ignore = actions.createEl("button", { text: "忽略" });
    ignore.disabled = pending;
    ignore.onclick = () => this.processItem(item, "ignore", {}, card);
    const unmanage = actions.createEl("button", { cls: "mod-warning knowledgeos-inbox-unmanage", text: "移出系统管理" });
    unmanage.disabled = pending;
    unmanage.onclick = () => this.processItem(item, "unmanage", {}, card);

    const fileInfo = detailBody.createDiv({ cls: "knowledgeos-inbox-file-info" });
    fileInfo.createDiv({ text: item.path });
    fileInfo.createDiv({ text: `${item.content_type || "文件"} · ${this.formatBytes(item.size)}` });

    if (selected && this.previewData?.item_id === item.item_id) {
      const detail = detailBody.createDiv({ cls: "knowledgeos-inbox-preview" });
      detail.createEl("strong", { text: "执行预览" });
      const rows = [
        ["归属", `${this.moduleName(this.previewData.suggested_ownership.module_id) || "未确定"}${this.previewData.suggested_ownership.instance_id ? ` / ${this.instanceName(this.previewData.suggested_ownership.instance_id)}` : ""}`],
        ["目标", this.previewData.operation_summary.target || "等待用户或 AI 决定"],
        ["预计操作", this.previewData.operation_summary.estimated_operations ?? "由模块计划决定"],
        ["风险", `${this.previewData.risk} · ${this.previewData.requires_codex ? "需要 Codex" : "Core 可执行"}`],
      ];
      for (const [label, value] of rows) {
        const row = detail.createDiv({ cls: "knowledgeos-inbox-preview-row" });
        row.createDiv({ cls: "knowledgeos-inbox-preview-label", text: label });
        row.createDiv({ text: String(value) });
      }
    }
    renderDeveloperDetails(detailBody, this.plugin, [["Item ID", item.item_id], ["原始状态", item.state], ["置信度", `${Math.round(item.confidence * 100)}%`], ["读取级别", item.required_read_level], ["Processor", item.processor], ["原始判断依据", item.reasons.join("；")]]);
  }

  setItemBusy(card, message) {
    card.addClass("is-busy");
    card.setAttr("aria-busy", "true");
    for (const control of card.querySelectorAll("button, select")) control.disabled = true;
    markLiveRegion(card.createDiv({ cls: "knowledgeos-inbox-item-progress", text: message }));
  }

  async previewItem(item, card) {
    if (this.pendingItemIds.has(item.item_id)) return;
    this.pendingItemIds.add(item.item_id);
    this.itemActionErrors.delete(item.item_id);
    this.setItemBusy(card, "正在生成执行预览…");
    const route = this.selectedRoute(item);
    const response = await this.plugin.client.invoke("processInboxItem", { item_id: item.item_id, action: "preview", ...route });
    this.pendingItemIds.delete(item.item_id);
    if (!response.ok) {
      const message = response.error?.message || "无法生成预览";
      this.itemActionErrors.set(item.item_id, message);
      this.expandedItems.add(item.item_id);
      this.plugin.notify(message, { error: true });
      this.render(item.item_id);
      return;
    }
    this.previewData = response.data;
    this.expandedItems.add(item.item_id);
    this.render(item.item_id);
  }

  async processItem(item, action, extra = {}, card = null) {
    if (this.pendingItemIds.has(item.item_id)) return;
    this.pendingItemIds.add(item.item_id);
    this.itemActionErrors.delete(item.item_id);
    if (card) this.setItemBusy(card, action === "retry" ? "正在重试处理…" : "正在处理条目…");
    const route = this.selectedRoute(item);
    const response = await this.plugin.client.invoke("processInboxItem", { item_id: item.item_id, action, ...route, ...extra });
    this.pendingItemIds.delete(item.item_id);
    if (!response.ok) {
      const message = response.error?.message || "Inbox 处理失败";
      this.itemActionErrors.set(item.item_id, message);
      this.expandedItems.add(item.item_id);
      this.plugin.notify(message, { error: true });
      this.render(item.item_id);
      return;
    }
    this.itemActionErrors.delete(item.item_id);
    this.resultMessage = response.data.status === "waiting-for-ai" ? "条目已安全保留，等待 Codex / 模块工作流。" : `Inbox 状态已更新：${response.data.status}`;
    await this.refresh();
  }

  async processBatch(items, button = null) {
    const originalText = button?.textContent;
    if (button) { button.disabled = true; button.setText("正在处理…"); }
    const response = await this.plugin.client.invoke("processInboxBatch", { mode: "high-confidence", item_ids: items.map((item) => item.item_id) });
    if (button) { button.disabled = false; button.setText(originalText || "处理高置信度条目"); }
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
    root.addClass("knowledgeos-review-modal"); root.addClass("knowledgeos-rollback-modal");
    root.createEl("h2", { text: "确认撤销" });
    const title = root.createEl("section", { cls: "knowledgeos-modal-title" });
    title.createEl("h3", { text: friendlyAction(this.run.source_action || "系统运行") });
    title.createDiv({ cls: "knowledgeos-modal-subtitle", text: this.run.run_id });
    const assessment = this.run.rollback;
    const warning = root.createEl("section", { cls: `knowledgeos-modal-alert ${assessment.requires_confirmation ? "is-warning" : "is-success"}`, attr: { "aria-label": "撤销影响" } });
    warning.createEl("strong", { text: rollbackLabel(assessment) });
    for (const reason of assessment.reasons || []) warning.createDiv({ text: reason });
    if (assessment.later_dependent_runs?.length) warning.createDiv({ text: `后续关联运行：${assessment.later_dependent_runs.join("、")}` });
    const protection = root.createEl("section", { cls: "knowledgeos-modal-section" });
    protection.createEl("h4", { text: "文件保护" });
    protection.createDiv({ cls: "knowledgeos-modal-row-description", text: "撤销只恢复该事务记录的文件快照；如果文件已被用户修改，Core 会拒绝覆盖。" });
    this.statusEl = markLiveRegion(root.createDiv({ cls: "knowledgeos-modal-submit-state" }));
    const actions = root.createDiv({ cls: "knowledgeos-modal-actions" });
    this.confirmButton = actions.createEl("button", { cls: "mod-warning", text: "确认撤销" });
    this.confirmButton.onclick = () => this.submit();
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.onclick = () => this.close();
  }
  async submit() {
    this.confirmButton.disabled = true;
    this.contentEl.setAttr("aria-busy", "true");
    this.statusEl.removeClass("is-error"); this.statusEl.removeClass("is-stale");
    this.statusEl.setText("Core 正在验证文件状态并执行撤销…");
    const response = await this.plugin.client.invoke("rollbackRun", {
      run_id: this.run.run_id,
      confirm: this.run.rollback.requires_confirmation === true,
    });
    this.confirmButton.disabled = false;
    this.contentEl.setAttr("aria-busy", "false");
    if (!response.ok) {
      this.statusEl.addClass("is-error");
      if (["ROLLBACK_CONFLICT", "RUN_NOT_ROLLBACKABLE"].includes(response.error?.code)) this.statusEl.addClass("is-stale");
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
    titleRow.createEl("h3", { text: friendlyAction(run.source_action || run.input_summary || "Core operation") });
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
        const button = row.createEl("button", { cls: "knowledgeos-link", text: friendlyAction(review.action) });
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
    titleRow.createEl("h3", { text: labelJob(task.job_id) });
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
  }
  getViewType() { return SYSTEM_VIEW_TYPE; }
  getDisplayText() { return "KnowledgeOS System"; }
  getIcon() { return "activity"; }
  async onOpen() { await this.refresh(); }

  async refresh(options = {}) {
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
        await this.performRefresh(nextIsBackground);
        nextIsBackground = true;
      } while (this.refreshQueued);
    })();
    try { await this.refreshPromise; }
    finally { this.refreshPromise = null; }
  }

  async performRefresh(background) {
    const section = this.activeSection;
    const currentData = this.data?.section === section ? this.data : this.sectionData.get(section);
    const preserveContent = Boolean(currentData && this.contentEl.childElementCount > 0);
    this.contentEl.setAttr("aria-busy", "true");
    if (preserveContent) this.renderBackgroundStatus("更新中…");
    else this.renderLoading();
    const response = await this.plugin.client.invoke("getSystemCenterSnapshot", { section });
    this.contentEl.removeAttribute("aria-busy");
    if (!response.ok) {
      if (preserveContent) this.renderStaleStatus(response.error);
      else this.renderFailure(response.error);
      return;
    }
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
    const cached = this.sectionData.get(section);
    if (cached) {
      this.data = cached;
      this.render();
      return;
    }
    this.data = null;
    await this.refresh({ background: true, preserveCache: true });
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
    if (section === "history" && !requireArray("runs")) return null;
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
    const open = title.createEl("button", { cls: "knowledgeos-link", text: labelJob(task.job_id) });
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
    runTasks.onclick = async () => { runTasks.disabled = true; const response = await this.plugin.client.invoke("runTaskCycle", { limit: 2 }); runTasks.disabled = false; if (!response.ok) this.plugin.notify(response.error?.message || "任务运行失败", { error: true }); await this.refresh(); };
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
      const tasks = this.data.tasks.filter((task) => statuses.includes(task.status)).slice(0, 50);
      if (!tasks.length) continue;
      shown += tasks.length;
      const section = root.createEl("section", { cls: "knowledgeos-system-section", attr: { "aria-label": label } });
      section.createEl("h4", { text: `${label} · ${tasks.length}` });
      const list = section.createDiv({ cls: "knowledgeos-system-list" });
      for (const task of tasks) this.renderTask(list, task);
    }
    if (!shown) this.renderEmptyState(root, "circle-check", "当前没有运行中或等待处理的任务", "新的手动任务和自动任务会显示在这里。", true);
    const jobs = (this.data.runtime.jobs || []).filter((job) => job.enabled && job.trigger?.type !== "startup");
    if (jobs.length) {
      const details = root.createEl("details", { cls: "knowledgeos-system-disclosure knowledgeos-scheduled-jobs" });
      details.createEl("summary", { text: `自动计划 · ${jobs.length}` });
      const list = details.createDiv({ cls: "knowledgeos-system-list" });
      for (const job of jobs) {
        const card = list.createEl("article", { cls: "knowledgeos-system-row knowledgeos-system-job-row" });
        card.createEl("strong", { text: labelJob(job.job_id) });
        card.createDiv({ cls: "knowledgeos-system-row-description", text: job.trigger?.type === "field-due" ? "在信息到期时检查" : "按计划自动运行" });
        const run = card.createEl("button", { text: "立即运行" });
        run.onclick = async () => { run.disabled = true; const response = await this.plugin.client.invoke("enqueueTask", { job_id: job.job_id }); if (!response.ok) this.plugin.notify(response.error?.message || "任务创建失败", { error: true }); else this.plugin.notify(response.data.deduplicated ? "任务已在队列中" : "任务已加入队列"); await this.refresh(); };
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
    const limit = this.plugin.settings.developerMode ? this.data.runs.length : 20;
    const list = root.createDiv({ cls: "knowledgeos-system-list knowledgeos-system-history-list" });
    for (const run of this.data.runs.slice(0, limit)) this.renderRun(list, run);
  }

  renderQuality(root) {
    const quality = this.data.quality;
    const section = root.createDiv({ cls: "knowledgeos-quality" });
    const header = section.createDiv({ cls: "knowledgeos-section-heading" });
    const heading = header.createDiv();
    heading.createEl("h3", { text: "知识质量" });
    heading.createDiv({ cls: "knowledgeos-page-subtitle", text: "来源、新鲜度、审核与数据一致性" });
    const audit = header.createEl("button", { text: "运行每周审计" });
    audit.onclick = async () => { audit.disabled = true; const response = await this.plugin.client.invoke("runQualityAudit", { frequency: "weekly" }); if (!response.ok) this.plugin.notify(response.error?.message || "质量审计失败", { error: true }); await this.refresh(); };
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
      ["数据结构", quality.schemas_migrations, [["outdated", "待迁移"], ["invalid", "格式异常"]]],
      ["AI 质量", quality.ai_quality, []],
      ["审计历史", { count: (quality.audit_history || []).length }, [["count", "审计次数"]]],
    ];
    for (const [title, data, fields] of panels) {
      const details = section.createEl("details", { cls: "knowledgeos-system-disclosure knowledgeos-quality-panel" });
      const total = fields.reduce((sum, [key]) => sum + (Number(data?.[key]) || 0), 0);
      details.createEl("summary", { text: `${title}${total ? ` · ${total}` : ""}` });
      if (fields.length) details.createDiv({ cls: "knowledgeos-system-section-summary knowledgeos-quality-summary", text: fields.map(([key, label]) => `${label} ${data?.[key] ?? 0}`).join(" · ") });
      const issues = (data?.items || data?.anomalies || []).slice(0, 20);
      if (!issues.length) details.createDiv({ cls: "knowledgeos-system-disclosure-empty", text: title === "审计历史" ? "尚无审计记录。" : "当前没有相关问题。" });
      const list = issues.length ? details.createDiv({ cls: "knowledgeos-system-list" }) : null;
      for (const issue of issues) {
        const row = list.createEl("article", { cls: `knowledgeos-system-row knowledgeos-system-quality-row quality-${issue.severity}` });
        row.createEl("strong", { text: issue.title || labelField(issue.target?.field) || "质量问题" });
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
    const title = heading.createEl("button", { cls: "knowledgeos-link", text: friendlyAction(run.source_action) });
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
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "KnowledgeOS Today"; }
  getIcon() { return "calendar-check"; }

  async onOpen() { await this.refresh(); }

  async refresh(options = {}) {
    const background = options.background === true;
    if (this.refreshPromise) {
      this.refreshQueued = true;
      return this.refreshPromise;
    }
    this.refreshPromise = (async () => {
      let nextIsBackground = background;
      do {
        this.refreshQueued = false;
        await this.performRefresh(nextIsBackground);
        nextIsBackground = true;
      } while (this.refreshQueued);
    })();
    try { await this.refreshPromise; }
    finally { this.refreshPromise = null; }
  }

  async performRefresh(background) {
    const preserveContent = Boolean(this.snapshot && this.contentEl.childElementCount > 0);
    this.state = "loading";
    this.contentEl.setAttr("aria-busy", "true");
    if (preserveContent) this.renderBackgroundStatus("更新中…");
    else this.renderLoading();
    const response = await this.plugin.client.invoke("getTodayItems", { refresh_markdown: !background });
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
    heading.createDiv({ cls: "knowledgeos-page-subtitle", text: new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric", weekday: "long" }).format(new Date()) });
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
      const description = friendlyDashboardDescription(item.description);
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
      const button = card.createEl("button", { cls: "knowledgeos-link", text: friendlyAction(run.source_action || run.job_id || "系统任务") });
      button.onclick = () => this.plugin.activateSystem(run.run_id);
      const meta = card.createDiv({ cls: "knowledgeos-today-run-meta" });
      meta.createSpan({ text: labelModule(run.source_module) });
      createTime(meta, run.completed_at, " · ");
      renderDeveloperDetails(card, this.plugin, [["Run ID", run.run_id], ["来源模块", run.source_module], ["完成时间", run.completed_at]]);
    }
  }
}

class KnowledgeOSSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin); this.plugin = plugin;
    this.connectionState = { tone: "idle", message: "尚未测试 Core 连接。" };
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
    new Setting(connection).setName("Core CLI 路径").setDesc("knowledgeos-engine/dist/cli.js 的绝对路径")
      .addText((text) => text.setPlaceholder("E:\\KnowledgeOS\\knowledgeos-engine\\dist\\cli.js")
        .setValue(this.plugin.settings.coreCliPath).onChange(async (value) => {
          await this.persistSetting("coreCliPath", value.trim(), true);
        }));
    new Setting(connection).setName("Node.js 可执行文件").setDesc("通常保持为 node；未加入 PATH 时填写 node.exe 的绝对路径")
      .addText((text) => text.setValue(this.plugin.settings.nodePath).onChange(async (value) => {
        await this.persistSetting("nodePath", value.trim() || "node", true);
      }));
    const connectionTest = new Setting(connection).setName("测试连接").setDesc("确认 Core CLI 可以启动、Vault 可以访问且 Command API 能够响应");
    connectionTest.addButton((button) => button.setButtonText("测试连接").onClick(async () => this.testConnection(button)));
    this.connectionStatusEl = markLiveRegion(connection.createDiv({ cls: "knowledgeos-settings-connection-state" }));
    this.renderConnectionState();

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

  async testConnection(button) {
    button.setDisabled(true);
    this.connectionState = { tone: "loading", message: "正在连接 KnowledgeOS Core…" };
    this.renderConnectionState();
    const result = await this.plugin.client.invoke("getModules", {});
    button.setDisabled(false);
    if (result.ok) {
      this.connectionState = { tone: "success", message: "Core 连接正常。网络、Codex 和模块健康状态未在此测试。" };
    } else {
      this.connectionState = { tone: "error", message: result.error?.message || "Core 连接失败。", impact: result.error?.impact, actions: result.error?.recovery_actions || [] };
    }
    this.renderConnectionState();
    this.plugin.notify(result.ok ? "KnowledgeOS Core 连接正常" : result.error?.message || "连接失败", { error: !result.ok, force: true });
  }
}

module.exports = class KnowledgeOSPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.vaultPath && this.app.vault.adapter.basePath) this.settings.vaultPath = this.app.vault.adapter.basePath;
    this.client = new CoreCommandClient(this.settings);
    this.taskClient = new CoreCommandClient(this.settings);
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
      if (!shouldAutoRefreshPath(file.path)) return;
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => {
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) leaf.view.refresh({ background: true });
        for (const leaf of this.app.workspace.getLeavesOfType(INBOX_VIEW_TYPE)) leaf.view.refresh();
        for (const leaf of this.app.workspace.getLeavesOfType(SYSTEM_VIEW_TYPE)) leaf.view.refresh({ background: true });
      }, 1500);
    }));
    this.app.workspace.onLayoutReady(async () => {
      if (this.settings.openTodayOnStartup) await this.activateToday();
      void this.runTaskCycle(true);
    });
    this.registerInterval(setInterval(() => this.runTaskCycle(false), 60_000));
  }

  async saveSettings() {
    this.client.close();
    this.taskClient.close();
    await this.saveData(this.settings);
    this.client.settings = this.settings;
    this.taskClient.settings = this.settings;
  }

  onunload() { this.client?.close(); this.taskClient?.close(); }

  notify(message, options = {}) {
    if (options.error || options.force || this.settings.notifyOnCompletion) new Notice(message);
  }

  async runTaskCycle(startup = false) {
    if (this.taskCycleRunning) return;
    this.taskCycleRunning = true;
    try {
      const response = await this.taskClient.invoke("runTaskCycle", { startup, limit: 2, network_probe_url: this.settings.networkProbeUrl || undefined });
      if (!response.ok) return;
      if (!taskCycleChanged(response.data)) return;
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) await leaf.view.refresh({ background: true });
      for (const leaf of this.app.workspace.getLeavesOfType(SYSTEM_VIEW_TYPE)) await leaf.view.refresh({ background: true });
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
    const leaves = this.app.workspace.getLeavesOfType(SYSTEM_VIEW_TYPE);
    let leaf = leaves.find((candidate) => !candidate.containerEl?.closest?.(".mod-sidedock"));
    if (!leaf) {
      for (const sidedockLeaf of leaves) sidedockLeaf.detach();
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: SYSTEM_VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    if (leaf.view?.openDetails) leaf.view.openDetails(runId, taskId);
  }
};
