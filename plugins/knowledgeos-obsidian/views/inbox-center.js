function createInboxCenterViews(deps) {
  const { ItemView, Modal, Notice, PluginSettingTab, Setting, setIcon, VIEW_TYPE, REVIEW_VIEW_TYPE, INBOX_VIEW_TYPE, SYSTEM_VIEW_TYPE, settingsDefaults, moduleUiMetadata, manifestFormatters, LIST_PAGE_SIZE, FALLBACK_CODEX_MODELS, REASONING_LABELS, markLiveRegion, taskCycleChanged, shouldAutoRefreshPath, missingBuiltCliFailure, labelStatus, labelModule, labelJob, labelField, friendlyAction, calendarDayDifference, formatTime, formatVerificationSchedule, createTime, friendlyDashboardDescription, friendlyDashboardTitle, createToolbarButton, renderLoadingSkeleton, addCardArrow, renderDeveloperDetails, renderRecoverableError } = deps;
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
    const eligible = this.listing.items.filter((item) => item.state === "pending" && item.confidence >= item.auto_route_threshold && !item.requires_ai);

    const overview = root.createDiv({ cls: "knowledgeos-inbox-overview" });
    const summaryParts = [];
    if (this.listing.counts.total) summaryParts.push(`${this.listing.counts.total} 个待整理`);
    if (this.listing.counts.needs_routing) summaryParts.push(`${this.listing.counts.needs_routing} 个需要选择归属`);
    if (this.listing.counts.failed) summaryParts.push(`${this.listing.counts.failed} 个失败`);
    const emptyCopies = this.listing.items.filter((item) => item.state === "empty").length;
    if (emptyCopies) summaryParts.push(`${emptyCopies} 个空白副本`);
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
      ["attention", "需要处理", (item) => ["failed", "empty", "waiting-for-user"].includes(item.state)],
      ["ready", "可以整理", (item) => item.state === "pending"],
      ["waiting", "等待系统", (item) => ["waiting-for-ai", "processing"].includes(item.state)],
      ["deferred", "已延后", (item) => item.state === "deferred"],
      ["other", "其他", (item) => !["failed", "empty", "waiting-for-user", "pending", "waiting-for-ai", "processing", "deferred"].includes(item.state)],
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

  inboxStateLabel(state, blockedByOpenEditor = false) {
    if (blockedByOpenEditor) return "等待关闭笔记";
    return ({ pending: "可以处理", processing: "正在处理", "waiting-for-user": "需要选择", "waiting-for-ai": "等待 AI", failed: "处理失败", empty: "空白副本", deferred: "已延后" })[state] || labelStatus(state);
  }

  friendlyReason(item) {
    const labels = {
      "located-in-instance-inbox": "来自实例 Inbox",
      "located-in-module-inbox": "来自模块 Inbox",
      "valid-instance-hint": "文件包含有效实例信息",
      "valid-module-hint": "文件包含有效模块信息",
      "structured-application-research-report": "识别为结构化申请研究报告",
      "obsidian-file-open": "该笔记仍在 Obsidian 编辑器中打开，系统已暂停移动以保护内容",
      "no-reliable-route": "尚无可靠归属",
      "empty-source": "文件为空，没有可供处理的正文",
      "empty-normalization-artifact": "检测到此前针对空文件生成的属性，原始正文不存在",
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
    heading.createSpan({ cls: `knowledgeos-inbox-item-status state-${item.state}`, text: this.inboxStateLabel(item.state, item.blocked_by_open_editor) });
    card.createDiv({ cls: `knowledgeos-inbox-ownership${item.suggested_module_id ? "" : " is-unresolved"}`, text: this.ownershipText(item) });
    card.createDiv({ cls: "knowledgeos-inbox-reason", text: this.friendlyReason(item) });
    const visibleError = this.itemActionErrors.get(item.item_id) || item.error;
    if (visibleError) markLiveRegion(card.createDiv({ cls: "knowledgeos-inbox-item-error", text: visibleError }), "assertive");
    if (item.state === "empty") card.createDiv({ cls: "knowledgeos-inbox-empty-source", text: "系统不会将空白副本交给 AI。移至恢复区后可通过 System Center 的运行记录撤销。" });
    if (item.blocked_by_open_editor) card.createDiv({ cls: "knowledgeos-inbox-open-file", text: "先保存并关闭这篇笔记。若它已有后台任务，系统会在下一次检查时继续；也可随后点击“已关闭，继续”。" });
    if (item.requires_ai) card.createDiv({ cls: "knowledgeos-inbox-ai", text: "需要 Codex 或模块工作流继续处理。" });

    const footer = card.createDiv({ cls: "knowledgeos-inbox-item-footer" });
    const meta = footer.createDiv({ cls: "knowledgeos-inbox-item-meta" });
    meta.createSpan({ text: item.content_type || "文件" });
    const time = createTime(meta, item.created_at, " · ");
    time.addClass("knowledgeos-inbox-created");
    const primary = footer.createEl("button", { cls: `${item.state === "empty" ? "mod-warning" : "mod-cta"} knowledgeos-inbox-primary`, text: pending ? "处理中…" : item.state === "empty" ? "移至恢复区" : item.blocked_by_open_editor ? "已关闭，继续" : item.state === "failed" ? "重试" : item.state === "waiting-for-user" ? "选择归属" : item.state === "waiting-for-ai" ? "继续处理" : item.state === "deferred" ? "立即处理" : "处理" });
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

    if (item.state === "empty") {
      routeFieldset.createDiv({ cls: "knowledgeos-inbox-empty-source", text: "该文件没有正文，无需选择归属。" });
      moduleSelect.disabled = true;
      instanceSelect.disabled = true;
      primary.onclick = () => this.processItem(item, "quarantine-empty", {}, card);
    } else if (item.blocked_by_open_editor) {
      routeFieldset.createDiv({ cls: "knowledgeos-inbox-open-file", text: "为避免 Obsidian 的编辑器状态重新创建旧文件，归属不能在此状态下修改。保存并关闭笔记后再继续。" });
      moduleSelect.disabled = true;
      instanceSelect.disabled = true;
      primary.onclick = () => this.processItem(item, "process", {}, card);
    } else if (item.state === "waiting-for-user") {
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
    if (item.state !== "empty" && !item.blocked_by_open_editor) {
      const defer = actions.createEl("button", { text: "明天提醒" });
      defer.disabled = pending;
      defer.onclick = () => this.processItem(item, "defer", { review_after: new Date(Date.now() + 86_400_000).toISOString() }, card);
    }
    const ignore = actions.createEl("button", { text: "忽略" });
    ignore.disabled = pending;
    ignore.onclick = () => this.processItem(item, "ignore", {}, card);
    if (item.state !== "empty") {
      const unmanage = actions.createEl("button", { cls: "mod-warning knowledgeos-inbox-unmanage", text: "移出系统管理" });
      unmanage.disabled = pending;
      unmanage.onclick = () => this.processItem(item, "unmanage", {}, card);
    }

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
    renderDeveloperDetails(detailBody, this.plugin, [["Item ID", item.item_id], ["Task ID", item.task_id], ["原始状态", item.state], ["置信度", `${Math.round(item.confidence * 100)}%`], ["读取级别", item.required_read_level], ["Processor", item.processor], ["原始判断依据", item.reasons.join("；")]]);
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
    if (card) this.setItemBusy(card, action === "quarantine-empty" ? "正在移至恢复区…" : action === "retry" ? "正在重试处理…" : item.blocked_by_open_editor ? "正在确认笔记已关闭…" : "正在处理条目…");
    const route = this.selectedRoute(item);
    const response = await this.plugin.client.invoke("processInboxItem", {
      item_id: item.item_id, action,
      codex_model: this.plugin.settings.codexModel,
      codex_reasoning_effort: this.plugin.settings.codexReasoningEffort,
      obsidian_open_paths: this.plugin.getOpenMarkdownPaths(),
      ...route, ...extra,
    });
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
    this.resultMessage = response.data.status === "quarantined-empty-source"
      ? "空白副本已移至恢复区；原始文件内容不会被删除，可在 System Center 中通过该次运行撤销。"
      : response.data.status === "waiting-for-user" && response.data.reason?.includes("Close the open Obsidian note")
      ? "笔记仍处于打开状态，系统没有移动它。请保存并关闭后再继续。"
      : response.data.task_id
      ? `AI 任务 ${response.data.task_id} 已${response.data.status === "queued" ? "进入队列" : "更新"}；Codex 可用时将自动继续。`
      : response.data.status === "waiting-for-ai" ? "条目已安全保留，等待 Codex / 模块工作流。" : `Inbox 状态已更新：${response.data.status}`;
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
    title.createEl("h3", { text: friendlyAction(this.run.source_action || "系统运行", this.run.source_module) });
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


  return { InboxCenterView };
}
module.exports = { createInboxCenterViews };