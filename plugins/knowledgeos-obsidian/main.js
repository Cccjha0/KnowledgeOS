const { ItemView, Modal, Notice, Plugin, PluginSettingTab, Setting, setIcon } = require("obsidian");
const { VIEW_TYPE, REVIEW_VIEW_TYPE, INBOX_VIEW_TYPE, SYSTEM_VIEW_TYPE } = require("./views/view-types");
const { registerKnowledgeViews } = require("./views/register");
const settingsDefaults = require("./settings/defaults");
const { ModuleUiMetadataStore } = require("./services/module-ui-metadata");
const { CoreCommandClient: SharedCoreCommandClient } = require("./services/core-command-client");
const { affectedKnowledgeViewsForPaths } = require("./services/view-refresh-policy");
const { createPresentationFormatters } = require("./formatters/presentation");
const { createReviewCenterViews } = require("./views/review-center");
const { createInboxCenterViews } = require("./views/inbox-center");
const { createSystemCenterViews } = require("./views/system-center");
const { createTodayViews } = require("./views/today");
const { createSettingsViews } = require("./views/settings-tab");
const { createModuleBuilderViews } = require("./views/module-builder-modal");
const { createRollbackModalSupport } = require("./components/rollback-modal");

const moduleUiMetadata = new ModuleUiMetadataStore();
const manifestFormatters = createPresentationFormatters(moduleUiMetadata);

const LIST_PAGE_SIZE = 50;
const FALLBACK_CODEX_MODELS = [
  { id: "gpt-5.6-terra", model: "gpt-5.6-terra", display_name: "GPT-5.6 Terra", description: "KnowledgeOS 默认模型", supported_reasoning_efforts: ["low", "medium", "high", "xhigh"], default_reasoning_effort: "medium", is_default: true },
  { id: "gpt-5.4-mini", model: "gpt-5.4-mini", display_name: "GPT-5.4 Mini", description: "较低延迟的兼容选项", supported_reasoning_efforts: ["low", "medium", "high", "xhigh"], default_reasoning_effort: "medium", is_default: false },
  { id: "gpt-5.4", model: "gpt-5.4", display_name: "GPT-5.4", description: "兼容选项", supported_reasoning_efforts: ["low", "medium", "high", "xhigh"], default_reasoning_effort: "medium", is_default: false },
];

const REASONING_LABELS = {
  none: "无",
  minimal: "最少",
  low: "低",
  medium: "中（推荐）",
  high: "高",
  xhigh: "超高",
  max: "最大",
  ultra: "极致",
};

function markLiveRegion(element, politeness = "polite") {
  element.setAttr("role", "status");
  element.setAttr("aria-live", politeness);
  element.setAttr("aria-atomic", "true");
  return element;
}

function taskCycleChanged(data) {
  const created = [data?.startup_task?.created, data?.field_due?.created, data?.inbox?.created, data?.startup?.scheduler?.created];
  return created.some((items) => Array.isArray(items) && items.length > 0)
    || Array.isArray(data?.dispatch?.tasks) && data.dispatch.tasks.length > 0;
}

const TASK_WAKE_MIN_MS = 1_000;
const TASK_WAKE_MAX_MS = 5 * 60_000;

function taskWakeDelay(data, now = Date.now()) {
  if (data?.has_work === true) return TASK_WAKE_MIN_MS;
  const next = typeof data?.next_wake_at === "string" ? Date.parse(data.next_wake_at) : Number.NaN;
  if (!Number.isFinite(next)) return TASK_WAKE_MAX_MS;
  return Math.min(TASK_WAKE_MAX_MS, Math.max(TASK_WAKE_MIN_MS, next - now));
}

function missingBuiltCliFailure(message, cliPath) {
  const detail = String(message || "");
  const configuredPath = String(cliPath || "").replaceAll("\\", "/");
  const looksLikeCli = /(?:^|\/)dist\/cli\.js$/i.test(configuredPath);
  const notFound = /cannot find module|module not found|enoent/i.test(detail);
  if (!looksLikeCli || !notFound) return null;
  return {
    message: "找不到已编译的 Core CLI（dist/cli.js）。",
    impact: "当前仓库不提交 dist/；插件尚不能启动 Core，已有 Vault 内容不会被修改。",
    recovery_actions: ["在 knowledgeos-engine 目录执行 npm ci", "执行 npm run build", "在设置中将 Core CLI 路径指向 dist/cli.js 后重新测试"],
  };
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

function labelStatus(value) { return STATUS_LABELS[value] || String(value || "未知"); }
function labelModule(value) { return manifestFormatters.labelModule(value); }
function labelJob(value, moduleId = null) { return manifestFormatters.labelJob(value, moduleId); }
function labelField(value, moduleId = null) { return manifestFormatters.labelField(value, moduleId); }

function friendlyAction(value, moduleId = null) {
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
  return manifestFormatters.friendlyAction(text, moduleId);
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

function friendlyDashboardDescription(description, moduleId = null) {
  const text = String(description || "").trim();
  if (!text) return "";
  const verify = text.match(/^Verify:\s*(.+)$/i);
  if (verify) return `需要核验：${labelField(verify[1], moduleId)}`;
  const researchPending = text.match(/^Research pending:\s*(.+)$/i);
  if (researchPending) return `核验请求已创建，等待研究结果：${labelField(researchPending[1], moduleId)}`;
  const parts = text.split(" | ");
  if (parts.length === 1) {
    if (text === "assign-owner") return "选择这个文件的归属位置";
    if (text === "unowned-file") return "这个文件还没有归类";
    if (text === "create-research-request") return "确认后会创建申请核验请求，研究结果仍需审核，不会直接覆盖正式档案";
    if (text === "stale-critical-field") return "重要申请信息已超过建议核验周期，需要重新核验";
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
  if (text === "stale-critical-field") return "重要申请信息需要重新核验";
  if (text === "quality.stale-field-followup") return "申请信息需要重新核验";
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

function createViewDependencies() {
  return {
    ItemView, Modal, Notice, PluginSettingTab, Setting, setIcon,
    VIEW_TYPE, REVIEW_VIEW_TYPE, INBOX_VIEW_TYPE, SYSTEM_VIEW_TYPE,
    settingsDefaults, moduleUiMetadata, manifestFormatters, LIST_PAGE_SIZE, FALLBACK_CODEX_MODELS, REASONING_LABELS,
    markLiveRegion, taskCycleChanged, missingBuiltCliFailure,
    labelStatus, labelModule, labelJob, labelField, friendlyAction, calendarDayDifference, formatTime, formatVerificationSchedule, createTime,
    friendlyDashboardDescription, friendlyDashboardTitle, createToolbarButton, renderLoadingSkeleton, addCardArrow, renderDeveloperDetails, renderRecoverableError,
    displayJson,
  };
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

module.exports = class KnowledgeOSPlugin extends Plugin {
  async onload() {
    const viewDependencies = createViewDependencies();
    Object.assign(viewDependencies, createRollbackModalSupport(viewDependencies));
    this.viewConstructors = {
      ...createReviewCenterViews(viewDependencies),
      ...createInboxCenterViews(viewDependencies),
      ...createSystemCenterViews(viewDependencies),
      ...createTodayViews(viewDependencies),
      ...createSettingsViews(viewDependencies),
      ...createModuleBuilderViews(viewDependencies),
    };
    const savedSettings = await this.loadData() || {};
    this.settings = Object.assign({}, settingsDefaults.DEFAULT_SETTINGS, savedSettings);
    if (!savedSettings.codexReasoningEffort && (!savedSettings.codexModel || savedSettings.codexModel === "gpt-5.4-mini")) {
      this.settings.codexModel = "gpt-5.6-terra";
      this.settings.codexReasoningEffort = "medium";
      await this.saveData(this.settings);
    }
    if (!this.settings.vaultPath && this.app.vault.adapter.basePath) this.settings.vaultPath = this.app.vault.adapter.basePath;
    const clientOptions = {
      onModulesLoaded: (modules) => moduleUiMetadata.update(modules), missingBuiltCliFailure,
      onOperationSettled: (event) => this.handleOperationSettled(event),
    };
    this.client = new SharedCoreCommandClient(this.settings, clientOptions);
    this.taskClient = new SharedCoreCommandClient(this.settings, clientOptions);
    registerKnowledgeViews(this, {
      today: VIEW_TYPE,
      reviews: REVIEW_VIEW_TYPE,
      inbox: INBOX_VIEW_TYPE,
      system: SYSTEM_VIEW_TYPE,
    }, this.viewConstructors);
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
    this.addCommand({ id: "module-builder", name: "Create KnowledgeOS module", callback: () => this.openModuleBuilder() });
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      menu.addItem((item) => item.setTitle("Quick Capture 到此上下文").setIcon("plus-circle")
        .onClick(() => this.openCapture(file.path)));
    }));
    this.addSettingTab(new this.viewConstructors.KnowledgeOSSettingTab(this.app, this));
    this.registerEvent(this.app.vault.on("modify", (file) => this.handleVaultPathsChanged([file.path])));
    this.registerEvent(this.app.vault.on("create", (file) => this.handleVaultPathsChanged([file.path])));
    this.registerEvent(this.app.vault.on("delete", (file) => this.handleVaultPathsChanged([file.path])));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.handleVaultPathsChanged([oldPath, file.path])));
    this.app.workspace.onLayoutReady(async () => {
      if (this.settings.openTodayOnStartup) await this.activateToday();
      void this.refreshModuleUiMetadata();
      void this.runTaskCycle(true);
    });
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.wakeTaskCycle()));
  }

  async saveSettings() {
    this.client.close();
    this.taskClient.close();
    await this.saveData(this.settings);
    this.client.settings = this.settings;
    this.taskClient.settings = this.settings;
  }

  handleVaultPathsChanged(paths) {
    this.wakeTaskCycle();
    if (!this.settings.autoRefresh) return;
    const affectedViews = affectedKnowledgeViewsForPaths(paths);
    if (!affectedViews.length) return;
    this.pendingRefreshViews ??= new Set();
    for (const view of affectedViews) this.pendingRefreshViews.add(view);
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      const views = new Set(this.pendingRefreshViews);
      this.pendingRefreshViews.clear();
      if (views.has("today")) for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) leaf.view.refresh({ background: true });
      if (views.has("reviews")) for (const leaf of this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)) leaf.view.loadReviews();
      if (views.has("inbox")) for (const leaf of this.app.workspace.getLeavesOfType(INBOX_VIEW_TYPE)) leaf.view.refresh();
      if (views.has("system")) for (const leaf of this.app.workspace.getLeavesOfType(SYSTEM_VIEW_TYPE)) leaf.view.refresh({ background: true });
    }, 1500);
  }

  onunload() { clearTimeout(this.refreshTimer); clearTimeout(this.taskWakeTimer); this.client?.close(); this.taskClient?.close(); }

  async refreshModuleUiMetadata() {
    if (this.moduleUiMetadataPromise) return this.moduleUiMetadataPromise;
    this.moduleUiMetadataPromise = this.client.invoke("getModules", {}).finally(() => { this.moduleUiMetadataPromise = null; });
    return this.moduleUiMetadataPromise;
  }

  notify(message, options = {}) {
    if (options.error || options.force || this.settings.notifyOnCompletion) new Notice(message);
  }

  async handleOperationSettled({ method, response }) {
    const affected = new Set(({
      createCapture: ["today", "inbox", "system"],
      processInboxItem: ["today", "inbox", "system"], processInboxBatch: ["today", "inbox", "system"],
      classifyInboxAttachment: ["today", "inbox", "system"], reviewPartialInboxExtraction: ["today", "inbox", "system"],
      resolveReview: ["today", "reviews", "system"], manageTask: ["today", "system"], enqueueTask: ["today", "system"],
      runTaskCycle: ["today", "system"], manageQualityIssue: ["today", "system"], runQualityAudit: ["today", "system"],
      manageModule: ["today", "inbox", "reviews", "system"], manageInstance: ["today", "inbox", "reviews", "system"],
      createInstance: ["today", "inbox", "reviews", "system"],
    })[method] || ["system"]);
    const refreshes = [];
    if (affected.has("today")) for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) refreshes.push(leaf.view.refresh({ background: true }));
    if (affected.has("reviews")) for (const leaf of this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)) refreshes.push(leaf.view.loadReviews());
    if (affected.has("inbox")) for (const leaf of this.app.workspace.getLeavesOfType(INBOX_VIEW_TYPE)) refreshes.push(leaf.view.refresh());
    if (affected.has("system")) for (const leaf of this.app.workspace.getLeavesOfType(SYSTEM_VIEW_TYPE)) refreshes.push(leaf.view.refresh({ background: true }));
    await Promise.allSettled(refreshes);
    if (method === "runTaskCycle") return;
    if (response?.ok) this.notify("后台操作已完成。", { force: true });
    else this.notify(`后台操作失败：${response?.error?.message || "Core 未返回成功结果。"}`, { error: true, force: true });
  }

  openModuleBuilder() { new this.viewConstructors.ModuleBuilderModal(this.app, this).open(); }

  async openInstanceWizard(initialModuleId = null) {
    const response = await this.client.invoke("getModules", {});
    if (!response.ok) { this.notify(response.error?.message || "Could not load modules for the Instance Wizard.", { error: true }); return; }
    const modules = Array.isArray(response.data?.modules) ? response.data.modules : Array.isArray(response.data) ? response.data : [];
    new this.viewConstructors.CreateInstanceModal(this.app, this, modules, () => this.activateSystem(), initialModuleId).open();
  }

  getOpenMarkdownPaths() {
    return [...new Set(this.app.workspace.getLeavesOfType("markdown")
      .map((leaf) => leaf.view?.file?.path)
      .filter((filePath) => typeof filePath === "string" && filePath.endsWith(".md")))].sort();
  }

  scheduleTaskCycle(data = null, delayOverride = null) {
    clearTimeout(this.taskWakeTimer);
    const delay = delayOverride ?? taskWakeDelay(data);
    this.taskWakeTimer = setTimeout(() => {
      this.taskWakeTimer = null;
      void this.runTaskCycle(false);
    }, delay);
  }

  wakeTaskCycle() {
    if (this.taskCycleRunning) { this.taskCycleWakePending = true; return; }
    this.scheduleTaskCycle(null, TASK_WAKE_MIN_MS);
  }

  async runTaskCycle(startup = false) {
    if (this.taskCycleRunning) { this.taskCycleWakePending = true; return; }
    this.taskCycleRunning = true;
    let wakeData = null;
    try {
      const response = await this.taskClient.invoke("runTaskCycle", {
        startup, limit: 2,
        cycle_requested_at: new Date().toISOString(),
        network_probe_url: this.settings.networkProbeUrl || undefined,
        codex_model: this.settings.codexModel,
        codex_reasoning_effort: this.settings.codexReasoningEffort,
        obsidian_open_paths: this.getOpenMarkdownPaths(),
      });
      if (!response.ok) return;
      wakeData = response.data;
      if (!taskCycleChanged(response.data)) return;
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) await leaf.view.refresh({ background: true });
      for (const leaf of this.app.workspace.getLeavesOfType(SYSTEM_VIEW_TYPE)) await leaf.view.refresh({ background: true });
    } finally {
      this.taskCycleRunning = false;
      if (this.taskCycleWakePending) {
        this.taskCycleWakePending = false;
        this.scheduleTaskCycle(null, TASK_WAKE_MIN_MS);
      } else this.scheduleTaskCycle(wakeData);
    }
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
