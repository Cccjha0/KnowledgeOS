function rollbackLabel(assessment) {
  if (!assessment?.can_rollback) return "不可自动撤销";
  return assessment.requires_confirmation ? "撤销（需要确认）" : "安全撤销";
}

function createRollbackModalSupport({ Modal, markLiveRegion, friendlyAction }) {
  class RollbackConfirmModal extends Modal {
    constructor(app, plugin, run, onComplete) {
      super(app); this.plugin = plugin; this.run = run; this.onComplete = onComplete;
    }
    onOpen() {
      const root = this.contentEl;
      root.empty(); root.addClass("knowledgeos-review-modal"); root.addClass("knowledgeos-rollback-modal");
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
      const cancel = actions.createEl("button", { text: "取消" }); cancel.onclick = () => this.close();
    }
    async submit() {
      this.confirmButton.disabled = true; this.contentEl.setAttr("aria-busy", "true");
      this.statusEl.setText("Core 正在检查文件状态并执行撤销…");
      const response = await this.plugin.client.invoke("rollbackRun", { run_id: this.run.run_id, confirm: true });
      this.confirmButton.disabled = false; this.contentEl.setAttr("aria-busy", "false");
      if (!response.ok) {
        this.statusEl.addClass("is-error");
        if (["ROLLBACK_CONFLICT", "RUN_NOT_ROLLBACKABLE"].includes(response.error?.code)) this.statusEl.addClass("is-stale");
        this.statusEl.setText(response.error?.message || "撤销失败；现有文件保持不变。");
        return;
      }
      const warning = response.data.warnings?.length ? `：${response.data.warnings.join("；")}` : "";
      this.plugin.notify(`已撤销 ${this.run.run_id}${warning}`, { force: true });
      this.close(); await this.onComplete(response.data);
    }
  }
  return { RollbackConfirmModal, rollbackLabel };
}

module.exports = { createRollbackModalSupport, rollbackLabel };
