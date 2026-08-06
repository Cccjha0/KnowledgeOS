function createModuleBuilderViews(deps) {
  const { Modal, Setting, Notice } = deps;

  class ModuleBuilderModal extends Modal {
    constructor(app, plugin) {
      super(app); this.plugin = plugin; this.preview = null; this.busy = false;
      this.form = { id: "", name: "", description: "", primary: "", excluded: "自动删除文件\n自动发送外部消息", inputs: "markdown", sensitivity: "1", representation: "full", critical: "", weekly: false };
    }
    onOpen() { this.render(); }
    render() {
      const root = this.contentEl; root.empty(); root.addClass("knowledgeos-module-builder-modal");
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
    async create() {
      if (this.preview?.report?.overall !== "PASS") return;
      this.busy = true; this.render();
      const response = await this.plugin.client.invoke("createModuleFromBlueprint", { blueprint: this.blueprint(), confirm: true });
      this.busy = false;
      if (!response.ok) { this.preview = { error: response.error }; this.render(); return; }
      new Notice(`模块 ${response.data.module_id} 已生成`); this.close();
    }
  }
  return { ModuleBuilderModal };
}

module.exports = { createModuleBuilderViews };
