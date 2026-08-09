function splitBuilderValues(value, separator = /\r?\n/) {
  return String(value || "").split(separator).map((item) => item.trim()).filter(Boolean);
}

/**
 * Builds a compact, but complete, Blueprint v1.1 record module contract.
 * Exported separately so the Quick path is covered without a live Obsidian UI.
 */
function buildQuickBlueprint(form) {
  const inputs = splitBuilderValues(form.inputs, /[,，]/);
  const attachments = inputs.some((item) => ["pdf", "pptx", "image"].includes(item));
  const criticalNames = splitBuilderValues(form.critical, /[,，]/)
    .map((field) => field.replace(/^knowledge-record\./, ""))
    .filter((field, index, all) => field && all.indexOf(field) === index);
  const recordFields = {
    created: { type: "datetime", required: true, description: "The time the record was created." },
    record_kind: { type: "string", description: "The record category, when it can be determined from the capture." },
  };
  for (const field of criticalNames) recordFields[field] = { type: "string", critical: true, description: `A user-designated critical ${field} value.` };
  const recordOutput = { id: "knowledge-record", entity: "knowledge-record", schema: "knowledge-record", template: "templates/knowledge-record.md", target: "{instance.content_root}/Records/{task.payload.item_id}.md" };
  const recordRole = "record-input";
  const summaryEnabled = form.weekly === true;
  const entities = [{ id: "knowledge-record", ownership: "instance", schema: { fields: recordFields } }];
  const outputs = [recordOutput];
  const workflows = [{
    id: "normalize-record", trigger: "capture", requires_ai: true,
    input_entities: ["capture"], input_roles: [recordRole], output_entity: "knowledge-record",
    read: { representation: form.representation }, prompt: { id: "normalize-record" },
    operation: { type: "create-record", target: recordOutput.target, template: recordOutput.template },
  }];
  if (summaryEnabled) {
    const summaryOutput = { id: "weekly-summary", entity: "weekly-summary", schema: "weekly-summary", template: "templates/weekly-summary.md", target: "{instance.content_root}/Summaries/{schedule.iso_week}.md" };
    entities.push({ id: "weekly-summary", ownership: "instance", schema: { fields: { week: { type: "string", required: true } } } });
    outputs.push(summaryOutput);
    workflows.push({
      id: "weekly-summary", trigger: "schedule", requires_ai: true,
      input_entities: ["knowledge-record"], sources: [{ entity: "knowledge-record", window: "current-week", date_field: "created" }],
      output_entity: "weekly-summary", read: { representation: "summary" }, prompt: { id: "weekly-summary" },
      operation: { type: "create-record", target: summaryOutput.target, template: summaryOutput.template },
    });
  }
  return {
    blueprint_version: 1.1, base_template: summaryEnabled ? "standard-workflow" : "minimal-config",
    capability_packs: ["capture-processing", "structured-entity", "immutable-user-content", ...(attachments ? ["attachment-processing"] : []), ...(summaryEnabled ? ["periodic-summary"] : [])],
    module: { id: String(form.id || "").trim(), display_name: String(form.name || "").trim(), description: String(form.description || "").trim(), intended_users: ["knowledgeos-user"] },
    module_class: { type: summaryEnabled ? "workflow" : "configuration", complexity: summaryEnabled ? "standard" : "minimal" },
    use_cases: { primary: splitBuilderValues(form.primary), excluded: splitBuilderValues(form.excluded) },
    entities, inputs, outputs,
    inbox: { module_level: true, instance_level: true, global_routing: true, default_asset_role: recordRole, roles: { [recordRole]: { inbox_subpath: "Records", access_policy: { sensitivity_class: Number(form.sensitivity), max_representation: form.representation }, entrypoint: "normalize-record", allow_codex: true } } },
    privacy: { default_sensitivity_class: Number(form.sensitivity), default_max_representation: form.representation, network_allowed: false, user_original_content_mutable: false, input_roles: { [recordRole]: { sensitivity_class: Number(form.sensitivity), max_representation: form.representation, allow_codex: true } } },
    workflows,
    review_policy: { critical_fields: criticalNames.map((field) => `knowledge-record.${field}`), ambiguous_input: "review", destructive_operations: "forbidden" },
    jobs: summaryEnabled ? [{ id: "weekly-summary", workflow_id: "weekly-summary", schedule: "weekly", weekday: "Sun", at: "18:00", timezone: "instance", scope: "instance", catch_up: "latest", retry: { max_attempts: 3, strategy: "exponential" }, concurrency: { policy: "forbid", key: "{module}:{instance}:weekly-summary" }, max_age_days: 21 }] : [],
    events: { publishes: [], subscribes: [] }, dashboard: { items: [
      { id: "recent-records", kind: "recent", entity: "knowledge-record", date_field: "created", limit: 5, category: "summary", priority: "low", title: "{title}", description: "Record created: {created}", actions: ["open"] },
      { id: "waiting-reviews", kind: "review-summary", category: "status", priority: "high", title: "{count} reviews need a decision", description: "{count} review items are waiting for your decision.", actions: ["open"] },
    ] },
    testing: { normal_input: "required", ambiguous_input: "required", repeat_execution: "required", permission_denied: "required", paused_instance: "required", archived_instance: "required", prompt_regression: "required", periodic_job: summaryEnabled ? "required" : "not-applicable", event_publication: "not-applicable", event_consumption: "not-applicable", migration: "not-applicable", attachment_policy: attachments ? "required" : "not-applicable" },
  };
}

function createModuleBuilderViews(deps) {
  const { Modal, Setting, Notice } = deps;

  class ModuleBuilderModal extends Modal {
    constructor(app, plugin) {
      super(app);
      this.plugin = plugin;
      this.mode = "guided";
      this.busy = false;
      this.preview = null;
      this.guided = null;
      this.readiness = null;
      this.readinessError = null;
      this.form = {
        id: "", name: "", description: "", primary: "", excluded: "Automatically delete files\nAutomatically send external messages",
        inputs: "markdown", sensitivity: "1", representation: "full", critical: "", weekly: false,
      };
      this.guidedBrief = "";
      this.expertBlueprint = "";
      this.confirmedApprovals = new Set();
      this.platformContract = null;
    }

    onOpen() { this.render(); void this.loadPlatformContract(); }

    async loadPlatformContract() {
      const response = await this.plugin.client.invoke("getModuleBuilderPlatformContract", {});
      if (response.ok) {
        this.platformContract = response.data;
        this.render();
      }
    }

    render() {
      const root = this.contentEl;
      root.empty();
      root.addClass("knowledgeos-module-builder-modal");
      if (this.readiness) { this.renderReadiness(root); return; }
      root.createEl("h2", { text: "Create a KnowledgeOS module" });
      root.createEl("p", { cls: "knowledgeos-builder-intro", text: "Describe the use case first. KnowledgeOS checks the extension boundary and permissions before it creates any module files." });
      if (this.platformContract) {
        root.createEl("p", { cls: "knowledgeos-builder-contract", text: `Platform Contract v${this.platformContract.contract_version} · ${String(this.platformContract.contract_fingerprint || "").slice(0, 12)}` });
      }
      this.renderModePicker(root);
      if (this.mode === "guided") this.renderGuided(root);
      if (this.mode === "quick") this.renderQuick(root);
      if (this.mode === "expert") this.renderExpert(root);
    }

    renderModePicker(root) {
      const picker = root.createDiv({ cls: "knowledgeos-builder-modes", attr: { role: "tablist", "aria-label": "Module builder mode" } });
      const modes = [
        ["guided", "Guided", "Describe what you need; the Module Builder contract proposes the right extension."],
        ["quick", "Quick", "Create a small record-oriented module from a concise form."],
        ["expert", "Expert", "Paste a Blueprint v1.1 you already designed."],
      ];
      for (const [id, label, description] of modes) {
        const button = picker.createEl("button", { text: label, cls: this.mode === id ? "is-selected" : "", attr: { type: "button", role: "tab", "aria-selected": String(this.mode === id), "aria-label": description } });
        button.disabled = this.busy;
        button.onclick = () => { this.mode = id; this.preview = null; this.render(); };
      }
    }

    renderGuided(root) {
      const section = root.createEl("section", { cls: "knowledgeos-builder-guided" });
      section.createEl("h3", { text: "Start with the daily use case" });
      section.createEl("p", { cls: "knowledgeos-builder-intro", text: "Include the normal input, expected output, who owns the data, and anything that must not happen. The analysis runs in a restricted planning workspace and never creates files automatically." });
      new Setting(section).setName("What do you want to manage?").setDesc("For example: “Turn lecture slides and assignment briefs into a weekly course workspace, without modifying original files.”")
        .addTextArea((control) => control.setValue(this.guidedBrief).setPlaceholder("Describe the problem, normal input, output, and exclusions.").onChange((value) => {
          this.guidedBrief = value;
          this.guided = null;
          this.preview = null;
        }));
      if (this.guided) this.renderGuidedResult(section);
      this.renderState(section);
      const actions = section.createDiv({ cls: "knowledgeos-builder-actions" });
      const analyze = actions.createEl("button", { cls: "mod-cta", text: this.busy ? "Analyzing…" : "Analyze requirement" });
      analyze.disabled = this.busy || this.guidedBrief.trim().length < 20;
      analyze.onclick = () => this.analyzeGuided();
      const close = actions.createEl("button", { text: "Cancel" });
      close.disabled = this.busy; close.onclick = () => this.close();
    }

    renderGuidedResult(root) {
      const result = this.guided;
      const boundary = result.boundary || {};
      const section = root.createEl("section", { cls: `knowledgeos-builder-preview boundary-${boundary.kind || "unknown"}` });
      section.createEl("h3", { text: this.boundaryLabel(boundary.kind) });
      section.createEl("p", { text: result.summary || "The requirement was analyzed." });
      section.createEl("p", { text: boundary.rationale || "" });
      const exclusions = Array.isArray(boundary.exclusions) ? boundary.exclusions : [];
      if (exclusions.length) {
        section.createEl("strong", { text: "Explicitly excluded" });
        const list = section.createEl("ul");
        exclusions.forEach((item) => list.createEl("li", { text: item }));
      }
      if (result.capability_gap) {
        section.createEl("strong", { text: "Capability gap" });
        section.createEl("p", { text: result.capability_gap.requested_behavior || "The current platform needs a generic capability before this can be scaffolded." });
        return;
      }
      const notes = Array.isArray(result.questions) ? result.questions : [];
      if (notes.length) {
        section.createEl("strong", { text: "Planning considerations" });
        const list = section.createEl("ul");
        notes.forEach((item) => list.createEl("li", { text: item.question }));
      }
      if (result.proposed_blueprint) {
        const report = result.blueprint_preview?.report;
        const approval = result.blueprint_preview?.approval;
        section.createEl("strong", { text: report?.overall === "PASS" ? "Blueprint is ready for review" : "Blueprint needs revision" });
        if (report?.overall !== "PASS") {
          const failures = (report?.checks || []).filter((item) => item.status !== "pass");
          const list = section.createEl("ul");
          failures.forEach((item) => list.createEl("li", { text: item.message }));
        } else {
          section.createEl("p", { text: `Template: ${result.blueprint_preview.scaffold_template}. Capability Packs: ${(report.resolved_capability_packs || []).join(", ") || "none"}.` });
        }
        const details = section.createEl("details");
        details.createEl("summary", { text: "Review Blueprint JSON" });
        details.createEl("pre", { text: JSON.stringify(result.proposed_blueprint, null, 2) });
        this.renderCoreApprovals(section, approval);
        const actions = section.createDiv({ cls: "knowledgeos-builder-actions" });
        const canCreate = report?.overall === "PASS" && this.hasRequiredApprovals(approval);
        const create = actions.createEl("button", { cls: "mod-cta", text: this.busy ? "Creating…" : "Confirm and create module" });
        create.disabled = this.busy || !canCreate;
        create.onclick = () => this.create(result.proposed_blueprint, approval);
        if (!canCreate && report?.overall === "PASS") actions.createEl("span", { cls: "knowledgeos-builder-action-hint", text: "Approve each Core security requirement before creating this module." });
      }
    }

    renderQuick(root) {
      const form = root.createDiv({ cls: "knowledgeos-builder-form" });
      form.createEl("h3", { text: "Quick record module" });
      form.createEl("p", { cls: "knowledgeos-builder-intro", text: "Use this for a small, record-oriented module. Use Guided when you are unsure whether this should be a module, component, pack, or instance." });
      this.text(form, "Module ID", "Lowercase letters, numbers, and hyphens; for example reading-list.", "id");
      this.text(form, "Display name", "The name shown to users.", "name");
      this.text(form, "Purpose", "What problem does this module solve?", "description");
      this.area(form, "Primary use cases", "One daily use case per line.", "primary");
      this.area(form, "Explicit exclusions", "One thing this module must not do per line.", "excluded");
      this.text(form, "Input formats", "Comma-separated, for example markdown,pdf,pptx.", "inputs");
      this.text(form, "Critical fields", "Comma-separated fields that always need review.", "critical");
      new Setting(form).setName("Sensitivity class").setDesc("0 public, 1 ordinary, 2 sensitive, 3 highly sensitive.").addDropdown((control) => {
        [["0", "Public"], ["1", "Ordinary"], ["2", "Sensitive"], ["3", "Highly sensitive"]].forEach(([value, label]) => control.addOption(value, label));
        control.setValue(this.form.sensitivity).onChange((value) => { this.form.sensitivity = value; this.invalidate(); });
      });
      new Setting(form).setName("Maximum representation").setDesc("The most content a workflow may request.").addDropdown((control) => {
        [["metadata", "Metadata only"], ["summary", "Safe summary"], ["full", "Full text"], ["sensitive-original", "Sensitive original"]].forEach(([value, label]) => control.addOption(value, label));
        control.setValue(this.form.representation).onChange((value) => { this.form.representation = value; this.invalidate(); });
      });
      new Setting(form).setName("Weekly summary").setDesc("Create one managed summary task each week.").addToggle((control) => control.setValue(this.form.weekly).onChange((value) => { this.form.weekly = value; this.invalidate(); }));
      if (this.preview) this.renderBlueprintPreview(root, this.blueprint());
      this.renderState(root);
      const actions = root.createDiv({ cls: "knowledgeos-builder-actions" });
      const preview = actions.createEl("button", { text: this.busy ? "Validating…" : "Validate design" });
      preview.disabled = this.busy; preview.onclick = () => this.validate(this.blueprint());
      const create = actions.createEl("button", { cls: "mod-cta", text: this.busy ? "Please wait…" : "Confirm and create" });
      create.disabled = this.busy || this.preview?.report?.overall !== "PASS" || !this.hasRequiredApprovals(this.preview?.approval); create.onclick = () => this.create(this.blueprint(), this.preview?.approval);
      const close = actions.createEl("button", { text: "Cancel" }); close.disabled = this.busy; close.onclick = () => this.close();
    }

    renderExpert(root) {
      const section = root.createEl("section", { cls: "knowledgeos-builder-expert" });
      section.createEl("h3", { text: "Blueprint v1.1" });
      section.createEl("p", { cls: "knowledgeos-builder-intro", text: "Paste a complete JSON Blueprint. It is validated before any files are generated." });
      new Setting(section).setName("Blueprint JSON").setDesc("Use Expert mode only when you already know the platform contract.")
        .addTextArea((control) => control.setValue(this.expertBlueprint).setPlaceholder("{\n  \"blueprint_version\": 1.1\n}").onChange((value) => { this.expertBlueprint = value; this.invalidate(); }));
      let blueprint = null;
      let parseError = null;
      if (this.expertBlueprint.trim()) {
        try { blueprint = JSON.parse(this.expertBlueprint); } catch { parseError = "Blueprint JSON is not valid yet."; }
      }
      if (parseError) section.createEl("div", { cls: "knowledgeos-builder-state is-error", attr: { role: "alert" }, text: parseError });
      if (this.preview && blueprint) this.renderBlueprintPreview(section, blueprint);
      this.renderState(section);
      const actions = section.createDiv({ cls: "knowledgeos-builder-actions" });
      const preview = actions.createEl("button", { text: this.busy ? "Validating…" : "Validate Blueprint" });
      preview.disabled = this.busy || !blueprint; preview.onclick = () => this.validate(blueprint);
      const create = actions.createEl("button", { cls: "mod-cta", text: this.busy ? "Creating…" : "Confirm and create" });
      create.disabled = this.busy || !blueprint || this.preview?.report?.overall !== "PASS" || !this.hasRequiredApprovals(this.preview?.approval); create.onclick = () => this.create(blueprint, this.preview?.approval);
      const close = actions.createEl("button", { text: "Cancel" }); close.disabled = this.busy; close.onclick = () => this.close();
    }

    renderState(root) {
      if (!this.preview?.error) return;
      root.createEl("div", { cls: "knowledgeos-builder-state is-error", attr: { role: "alert" }, text: this.preview.error.message || "The Core could not complete this request." });
    }

    text(parent, name, description, key) { new Setting(parent).setName(name).setDesc(description).addText((control) => control.setValue(this.form[key]).onChange((value) => { this.form[key] = value; this.invalidate(); })); }
    area(parent, name, description, key) { new Setting(parent).setName(name).setDesc(description).addTextArea((control) => control.setValue(this.form[key]).onChange((value) => { this.form[key] = value; this.invalidate(); })); }
    invalidate() { if (this.preview) { this.preview = null; this.confirmedApprovals.clear(); this.render(); } }
    lines(value, separator = /\r?\n/) { return splitBuilderValues(value, separator); }

    blueprint() { return buildQuickBlueprint(this.form); }

    async analyzeGuided() {
      this.busy = true; this.preview = null; this.guided = null; this.confirmedApprovals.clear(); this.render();
      const response = await this.plugin.client.invoke("analyzeModuleRequirement", {
        brief: this.guidedBrief,
        codex_model: this.plugin.settings.codexModel,
        codex_reasoning_effort: this.plugin.settings.codexReasoningEffort,
      }, null, { timeoutMs: 130_000 });
      this.busy = false;
      if (!response.ok) this.preview = { error: response.error };
      else this.guided = response.data;
      this.render();
    }

    async validate(blueprint) {
      this.busy = true; this.preview = null; this.render();
      const response = await this.plugin.client.invoke("previewModuleBlueprint", { blueprint });
      this.busy = false; this.preview = response.ok ? response.data : { error: response.error }; this.render();
    }

    renderBlueprintPreview(root, blueprint) {
      const section = root.createEl("section", { cls: "knowledgeos-builder-preview" });
      if (this.preview.error) { section.createEl("strong", { text: "Could not validate Blueprint" }); section.createEl("p", { text: this.preview.error.message || "Core returned an error." }); return; }
      const report = this.preview.report;
      section.createEl("h3", { text: report.overall === "PASS" ? "Blueprint is ready" : "Blueprint needs revision" });
      section.createEl("p", { text: `Template: ${this.preview.scaffold_template}. Capability Packs: ${(report.resolved_capability_packs || []).join(", ") || "none"}.` });
      const failed = (report.checks || []).filter((item) => item.status !== "pass");
      if (failed.length) { const list = section.createEl("ul"); failed.forEach((item) => list.createEl("li", { text: item.message })); }
      const details = section.createEl("details"); details.createEl("summary", { text: "Review Blueprint JSON" }); details.createEl("pre", { text: JSON.stringify(blueprint, null, 2) });
      this.renderCoreApprovals(section, this.preview.approval);
    }

    approvalRequirements(approval) { return Array.isArray(approval?.requirements) ? approval.requirements : []; }
    hasRequiredApprovals(approval) { return this.approvalRequirements(approval).every((requirement) => this.confirmedApprovals.has(requirement.id)); }
    renderCoreApprovals(root, approval) {
      const requirements = this.approvalRequirements(approval);
      if (!requirements.length) return;
      root.createEl("strong", { text: "Core security approvals" });
      root.createEl("p", { cls: "knowledgeos-builder-intro", text: "Core derives these requirements for this exact Blueprint. Changing the Blueprint invalidates the approvals." });
      const choices = root.createDiv({ cls: "knowledgeos-builder-confirmations" });
      for (const requirement of requirements) {
        const label = choices.createEl("label", { cls: "knowledgeos-builder-confirmation" });
        const input = label.createEl("input", { type: "checkbox" });
        input.checked = this.confirmedApprovals.has(requirement.id);
        input.onchange = () => { if (input.checked) this.confirmedApprovals.add(requirement.id); else this.confirmedApprovals.delete(requirement.id); this.render(); };
        const content = label.createDiv();
        content.createEl("strong", { text: requirement.title || requirement.id });
        content.createEl("span", { text: requirement.impact || "Core requires explicit approval for this change." });
      }
    }

    boundaryLabel(kind) { return ({ module: "Module recommended", component: "Component recommended", "configuration-pack": "Configuration Pack recommended", instance: "Instance recommended", "capability-gap": "Capability gap found" })[kind] || "Boundary decision"; }
    actionLabel(action) { return ({ validate: "Run validation", test: "Run module tests", sandbox: "Run isolated sandbox", pack: "Package module", install: "Install module" })[action] || action; }
    stateLabel(state) { return ({ draft: "Draft", "implementation-required": "Implementation required", "test-failed": "Needs fixes", "ready-to-package": "Ready to package", installed: "Installed" })[state] || state; }
    stepLabel(step) { return ({ blueprint: "Blueprint", scaffold: "Scaffold", validation: "Validation", test: "Module tests", sandbox: "Isolated sandbox", package: "Package", installation: "Installation" })[step] || step; }

    async create(blueprint, approval) {
      this.busy = true; this.render();
      const response = await this.plugin.client.invoke("createModuleFromBlueprint", { blueprint, confirm: true, approval: { blueprint_hash: approval?.blueprint_hash, approved_requirement_ids: [...this.confirmedApprovals] } });
      this.busy = false;
      if (!response.ok) { this.preview = { error: response.error }; this.render(); return; }
      const readiness = await this.plugin.client.invoke("getModuleReadiness", { module_id: response.data.module_id });
      if (!readiness.ok) { this.preview = { error: readiness.error }; this.render(); return; }
      this.readiness = readiness.data;
      new Notice(`Module ${response.data.module_id} was created in the development workspace.`);
      this.render();
    }

    async refreshReadiness() {
      if (!this.readiness?.module_id) return;
      this.busy = true; this.readinessError = null; this.render();
      const response = await this.plugin.client.invoke("getModuleReadiness", { module_id: this.readiness.module_id });
      this.busy = false; if (!response.ok) this.readinessError = response.error; else this.readiness = response.data; this.render();
    }

    async runReadinessAction(action) {
      if (!this.readiness?.module_id || this.busy) return;
      this.busy = true; this.readinessError = null; this.render();
      const response = await this.plugin.client.invoke("runModuleReadinessAction", { module_id: this.readiness.module_id, action });
      this.busy = false; if (!response.ok) this.readinessError = response.error; else this.readiness = response.data.readiness; this.render();
    }

    renderReadiness(root) {
      root.createEl("h2", { text: "Module readiness" });
      const summary = root.createDiv({ cls: "knowledgeos-builder-readiness-summary" });
      summary.createEl("strong", { text: this.readiness.module_id }); summary.createEl("span", { cls: `knowledgeos-builder-readiness-state state-${this.readiness.state}`, text: this.stateLabel(this.readiness.state) });
      root.createEl("p", { cls: "knowledgeos-builder-intro", text: "The module remains in the development workspace until validation, tests, sandboxing, packaging, and explicit installation are complete." });
      const workspace = root.createEl("p", { cls: "knowledgeos-builder-workspace" }); workspace.createEl("span", { text: "Workspace: " }); workspace.createEl("code", { text: this.readiness.workspace_path || "—" });
      const list = root.createEl("ol", { cls: "knowledgeos-builder-readiness-list" });
      for (const step of this.readiness.steps || []) { const row = list.createEl("li", { cls: `knowledgeos-builder-readiness-step is-${step.status}` }); const heading = row.createDiv({ cls: "knowledgeos-builder-readiness-heading" }); heading.createEl("strong", { text: this.stepLabel(step.id) }); heading.createEl("span", { text: step.status === "complete" ? "Complete" : step.status === "failed" ? "Needs attention" : "Not complete" }); row.createEl("div", { cls: "knowledgeos-builder-readiness-message", text: step.message }); }
      if (this.readinessError) root.createEl("div", { cls: "knowledgeos-builder-state is-error", attr: { role: "alert" }, text: this.readinessError.message || "Could not refresh module status." });
      else if (this.busy) root.createEl("div", { cls: "knowledgeos-builder-state", attr: { role: "status", "aria-live": "polite" }, text: "Working on the next readiness step…" });
      const actions = root.createDiv({ cls: "knowledgeos-builder-actions" }); const next = (this.readiness.available_actions || [])[0];
      if (next) { const button = actions.createEl("button", { cls: "mod-cta", text: this.busy ? "Working…" : this.actionLabel(next) }); button.disabled = this.busy; button.onclick = () => this.runReadinessAction(next); }
      const refresh = actions.createEl("button", { text: "Refresh status" }); refresh.disabled = this.busy; refresh.onclick = () => this.refreshReadiness();
      const close = actions.createEl("button", { text: "Done" }); close.disabled = this.busy; close.onclick = () => this.close();
    }
  }
  return { ModuleBuilderModal };
}

module.exports = { createModuleBuilderViews, buildQuickBlueprint };
