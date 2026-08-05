const CORE_MODULE = {
  display_name: "KnowledgeOS",
  icon: "sparkles",
};

const CORE_JOB_LABELS = {
  "core.daily-today": "更新 Today 页面",
  "core.startup-today": "启动时更新 Today 页面",
  "core.daily-quality-audit": "每日知识检查",
  "core.weekly-quality-audit": "每周知识检查",
  "core.monthly-quality-audit": "每月知识检查",
  "core.weekly-vault-audit": "每周 Vault 检查",
  "core.monthly-runtime-cleanup": "清理运行历史",
};

function humanize(value, fallback) {
  const text = String(value || "").trim();
  return text ? text.replaceAll("_", " ").replaceAll("-", " ") : fallback;
}

class ModuleUiMetadataStore {
  constructor() {
    this.modules = new Map([["core", CORE_MODULE]]);
  }

  update(modules) {
    if (!Array.isArray(modules)) return;
    for (const module of modules) {
      if (!module || typeof module.id !== "string") continue;
      const declared = module.ui && typeof module.ui === "object" ? module.ui : {};
      this.modules.set(module.id, {
        display_name: typeof declared.display_name === "string" && declared.display_name.trim()
          ? declared.display_name.trim()
          : typeof module.name === "string" && module.name.trim() ? module.name.trim() : module.id,
        icon: typeof declared.icon === "string" ? declared.icon : null,
        field_labels: declared.field_labels && typeof declared.field_labels === "object" ? declared.field_labels : {},
        job_labels: declared.job_labels && typeof declared.job_labels === "object" ? declared.job_labels : {},
      });
    }
  }

  module(moduleId) {
    return this.modules.get(String(moduleId || "core")) || null;
  }

  labelModule(moduleId) {
    return this.module(moduleId)?.display_name || humanize(moduleId, "系统");
  }

  icon(moduleId) {
    return this.module(moduleId)?.icon || null;
  }

  labelJob(jobId, moduleId = null) {
    const value = String(jobId || "").trim();
    if (!value) return "系统任务";
    if (CORE_JOB_LABELS[value]) return CORE_JOB_LABELS[value];
    const inferredModule = moduleId || value.split(".")[0];
    const localId = value.startsWith(`${inferredModule}.`) ? value.slice(inferredModule.length + 1) : value;
    const labels = this.module(inferredModule)?.job_labels || {};
    return labels[localId] || labels[value] || humanize(localId, "系统任务");
  }

  labelField(field, moduleId = null) {
    const value = String(field || "").trim();
    if (!value) return "信息";
    const labels = this.module(moduleId)?.field_labels || {};
    return labels[value] || humanize(value, "信息");
  }
}

module.exports = { ModuleUiMetadataStore };
