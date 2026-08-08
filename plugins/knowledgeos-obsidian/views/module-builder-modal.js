function createModuleBuilderViews(deps) {
  const { Modal, Setting, Notice } = deps;

  class ModuleBuilderModal extends Modal {
    constructor(app, plugin) {
      super(app); this.plugin = plugin; this.preview = null; this.busy = false; this.readiness = null; this.readinessError = null;
      this.form = { id: "", name: "", description: "", primary: "", excluded: "自动删除文件\n自动发送外部消息", inputs: "markdown", sensitivity: "1", representation: "full", critical: "", weekly: false };
    }
    onOpen() { this.render(); }
    render() {
      const root = this.contentEl; root.empty(); root.addClass("knowledgeos-module-builder-modal");
      if (this.readiness) { this.renderReadiness(root); return; }
      root.createEl("h2", { text: "创建 KnowledgeOS 模块" });
      root.createEl("p", { cls: "knowledgeos-builder-intro", text: "先描述用途和权限边界。Core 会验证 Blueprint；只有确认后才生成模块文件。" });
      const form = root.createDiv({ cls: "knowledgeos-builder-form" });
      this.text(form, "模块 ID", "小写英文和连字符，例如 reading-list", "id");
      this.text(form, "显示名称", "用户看到的模块名称", "name");
      this.text(form, "用途", "这个模块解决什么问题", "description");
      this.area(form, "主要使用场景", "每行一个日常场景", "primary");
      this.area(form, "明确不做", "每行一个排除项", "excluded");
      this.text(form, "输入格式", "逗号分隔，例如 markdown,pdf,pptx", "inputs");
      this.text(form, "关键字段", "逗号分隔；这些字段必须审核", "critical");
      new Setting(form).setName("隐私等级").setDesc("0 公开，1 普通，2 敏感，3 高度敏感").addDropdown((control) => {
        for (const [value, label] of [["0", "公开"], ["1", "普通"], ["2", "敏感"], ["3", "高度敏感"]]) control.addOption(value, label);
        control.setValue(this.form.sensitivity).onChange((value) => { this.form.sensitivity = value; this.invalidate(); });
      });
      new Setting(form).setName("允许读取").setDesc("Workflow 实际可以读取的最大内容范围").addDropdown((control) => {
        for (const [value, label] of [["metadata", "仅元数据"], ["summary", "安全摘要"], ["full", "全文"], ["sensitive-original", "敏感原文"]]) control.addOption(value, label);
        control.setValue(this.form.representation).onChange((value) => { this.form.representation = value; this.invalidate(); });
      });
      new Setting(form).setName("周期总结").setDesc("每周创建一次受管总结任务").addToggle((control) => control.setValue(this.form.weekly).onChange((value) => { this.form.weekly = value; this.invalidate(); }));

      this.stateEl = root.createDiv({ cls: "knowledgeos-builder-state", attr: { role: "status", "aria-live": "polite" } });
      if (this.preview) this.renderPreview(root);
      const actions = root.createDiv({ cls: "knowledgeos-builder-actions" });
      const preview = actions.createEl("button", { text: this.busy ? "正在验证…" : "验证设计" });
      preview.disabled = this.busy; preview.onclick = () => this.validate();
      const create = actions.createEl("button", { cls: "mod-cta", text: this.busy ? "请稍候…" : "确认并生成" });
      create.disabled = this.busy || this.preview?.report?.overall !== "PASS"; create.onclick = () => this.create();
      const close = actions.createEl("button", { text: "取消" }); close.disabled = this.busy; close.onclick = () => this.close();
    }
    text(parent, name, description, key) {
      new Setting(parent).setName(name).setDesc(description).addText((control) => control.setValue(this.form[key]).onChange((value) => { this.form[key] = value; this.invalidate(); }));
    }
    area(parent, name, description, key) {
      new Setting(parent).setName(name).setDesc(description).addTextArea((control) => control.setValue(this.form[key]).onChange((value) => { this.form[key] = value; this.invalidate(); }));
    }
    invalidate() { if (this.preview) { this.preview = null; this.render(); } }
    lines(value, separator = /\r?\n/) { return String(value || "").split(separator).map((item) => item.trim()).filter(Boolean); }
    blueprint() {
      const inputs = this.lines(this.form.inputs, /[,，]/); const attachments = inputs.some((item) => ["pdf", "pptx", "image"].includes(item));
      const packs = ["capture-processing", "structured-entity", "immutable-user-content", ...(attachments ? ["attachment-processing"] : []), ...(this.form.weekly ? ["periodic-summary"] : [])];
      return {
        blueprint_version: 1, base_template: this.form.weekly ? "standard-workflow" : "minimal-config", capability_packs: packs,
        module: { id: this.form.id.trim(), display_name: this.form.name.trim(), description: this.form.description.trim(), intended_users: ["knowledgeos-user"] },
        module_class: { type: this.form.weekly ? "workflow" : "configuration", complexity: this.form.weekly ? "standard" : "minimal" },
        use_cases: { primary: this.lines(this.form.primary), excluded: this.lines(this.form.excluded) },
        entities: [{ id: "knowledge-record", ownership: "instance" }], inputs, outputs: ["knowledge-record"],
        inbox: { module_level: true, instance_level: true, global_routing: true },
        privacy: { default_sensitivity_class: Number(this.form.sensitivity), default_max_representation: this.form.representation, network_allowed: false, user_original_content_mutable: false },
        workflows: [{ id: "normalize-record", trigger: "capture", requires_ai: true }, ...(this.form.weekly ? [{ id: "weekly-summary", trigger: "schedule", requires_ai: true }] : [])],
        review_policy: { critical_fields: this.lines(this.form.critical, /[,，]/), ambiguous_input: "review", destructive_operations: "forbidden" },
        jobs: this.form.weekly ? [{ id: "weekly-summary", schedule: "weekly", catch_up: "latest" }] : [], events: { publishes: [], subscribes: [] },
        dashboard: { sections: ["recent-records", "waiting-reviews"] },
        testing: { normal_input: "required", ambiguous_input: "required", repeat_execution: "required", permission_denied: "required", paused_instance: "required", archived_instance: "required", prompt_regression: "required", periodic_job: this.form.weekly ? "required" : "not-applicable", event_publication: "not-applicable", event_consumption: "not-applicable", migration: "not-applicable", attachment_policy: attachments ? "required" : "not-applicable" },
      };
    }
    async validate() {
      this.busy = true; this.preview = null; this.render();
      const response = await this.plugin.client.invoke("previewModuleBlueprint", { blueprint: this.blueprint() });
      this.busy = false;
      if (!response.ok) { this.preview = { error: response.error }; this.render(); return; }
      this.preview = response.data; this.render();
    }
    renderPreview(root) {
      const section = root.createEl("section", { cls: "knowledgeos-builder-preview" });
      if (this.preview.error) { section.createEl("strong", { text: "无法验证设计" }); section.createEl("p", { text: this.preview.error.message || "Core 返回错误。" }); return; }
      const report = this.preview.report; section.createEl("h3", { text: report.overall === "PASS" ? "设计可以生成" : "设计需要修改" });
      section.createEl("p", { text: `基础模板：${this.preview.scaffold_template} · Capability Packs：${(report.resolved_capability_packs || []).join("、")}` });
      const failed = (report.checks || []).filter((item) => item.status !== "pass");
      if (failed.length) { const list = section.createEl("ul"); for (const item of failed) list.createEl("li", { text: item.message }); }
      const details = section.createEl("details"); details.createEl("summary", { text: "查看 Blueprint JSON" }); details.createEl("pre", { text: JSON.stringify(this.blueprint(), null, 2) });
    }
    actionLabel(action) {
      return ({ validate: "运行校验", test: "运行模块测试", sandbox: "运行隔离沙箱", pack: "打包模块", install: "安装模块" })[action] || action;
    }
    stateLabel(state) {
      return ({ draft: "草稿", "implementation-required": "需要完成实现", "test-failed": "需要修复", "ready-to-package": "可以打包", installed: "已安装" })[state] || state;
    }
    stepLabel(step) {
      return ({ blueprint: "Blueprint", scaffold: "脚手架", validation: "校验", test: "模块测试", sandbox: "隔离沙箱", package: "模块包", installation: "安装" })[step] || step;
    }
    async refreshReadiness() {
      if (!this.readiness?.module_id) return;
      this.busy = true; this.readinessError = null; this.render();
      const response = await this.plugin.client.invoke("getModuleReadiness", { module_id: this.readiness.module_id });
      this.busy = false;
      if (!response.ok) this.readinessError = response.error;
      else this.readiness = response.data;
      this.render();
    }
    async runReadinessAction(action) {
      if (!this.readiness?.module_id || this.busy) return;
      this.busy = true; this.readinessError = null; this.render();
      const response = await this.plugin.client.invoke("runModuleReadinessAction", { module_id: this.readiness.module_id, action });
      this.busy = false;
      if (!response.ok) this.readinessError = response.error;
      else this.readiness = response.data.readiness;
      this.render();
    }
    renderReadiness(root) {
      root.createEl("h2", { text: "模块交付状态" });
      const summary = root.createDiv({ cls: "knowledgeos-builder-readiness-summary" });
      summary.createEl("strong", { text: this.readiness.module_id });
      summary.createEl("span", { cls: `knowledgeos-builder-readiness-state state-${this.readiness.state}`, text: this.stateLabel(this.readiness.state) });
      root.createEl("p", { cls: "knowledgeos-builder-intro", text: "模块仍位于开发工作区。只有完成校验、测试、沙箱、打包和明确安装后，才会在此 Vault 中启用。" });
      const workspace = root.createEl("p", { cls: "knowledgeos-builder-workspace" });
      workspace.createEl("span", { text: "工作区：" }); workspace.createEl("code", { text: this.readiness.workspace_path || "—" });
      const list = root.createEl("ol", { cls: "knowledgeos-builder-readiness-list" });
      for (const step of this.readiness.steps || []) {
        const row = list.createEl("li", { cls: `knowledgeos-builder-readiness-step is-${step.status}` });
        const heading = row.createDiv({ cls: "knowledgeos-builder-readiness-heading" });
        heading.createEl("strong", { text: this.stepLabel(step.id) });
        heading.createEl("span", { text: step.status === "complete" ? "已完成" : step.status === "failed" ? "需要处理" : "未完成" });
        row.createEl("div", { cls: "knowledgeos-builder-readiness-message", text: step.message });
      }
      if (this.readinessError) root.createEl("div", { cls: "knowledgeos-builder-state is-error", attr: { role: "alert" }, text: this.readinessError.message || "无法更新模块状态。" });
      else if (this.busy) root.createEl("div", { cls: "knowledgeos-builder-state", attr: { role: "status", "aria-live": "polite" }, text: "正在执行下一步，请保持此窗口打开。" });
      const actions = root.createDiv({ cls: "knowledgeos-builder-actions" });
      const next = (this.readiness.available_actions || [])[0];
      if (next) {
        const button = actions.createEl("button", { cls: "mod-cta", text: this.busy ? "正在处理…" : this.actionLabel(next) });
        button.disabled = this.busy; button.onclick = () => this.runReadinessAction(next);
      }
      const refresh = actions.createEl("button", { text: "刷新状态" }); refresh.disabled = this.busy; refresh.onclick = () => this.refreshReadiness();
      const close = actions.createEl("button", { text: "完成" }); close.disabled = this.busy; close.onclick = () => this.close();
    }
    async create() {
      if (this.preview?.report?.overall !== "PASS") return;
      this.busy = true; this.render();
      const response = await this.plugin.client.invoke("createModuleFromBlueprint", { blueprint: this.blueprint(), confirm: true });
      this.busy = false;
      if (!response.ok) { this.preview = { error: response.error }; this.render(); return; }
      this.readinessError = null;
      const readiness = await this.plugin.client.invoke("getModuleReadiness", { module_id: response.data.module_id });
      if (!readiness.ok) { this.preview = { error: readiness.error }; this.render(); return; }
      this.readiness = readiness.data;
      new Notice(`模块 ${response.data.module_id} 已创建到开发工作区。`); this.render();
    }
  }
  return { ModuleBuilderModal };
}

module.exports = { createModuleBuilderViews };
