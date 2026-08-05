function createPresentationFormatters(metadata) {
  function labelModule(value) { return metadata.labelModule(value); }
  function labelJob(value, moduleId = null) { return metadata.labelJob(value, moduleId); }
  function labelField(value, moduleId = null) { return metadata.labelField(value, moduleId); }

  function friendlyAction(value, moduleId = null) {
    const text = String(value || "").trim();
    if (!text) return "系统任务";
    const dueRequests = text.match(/^Create (\d+) due application Research Request\(s\)\.$/i);
    if (dueRequests) return `已创建 ${dueRequests[1]} 个到期申请核验请求`;
    const createdRequests = text.match(/^Create(?:d)? (\d+) Research Request/i);
    if (createdRequests) return `已创建 ${createdRequests[1]} 个申请核验请求`;
    if (/today/i.test(text) && /build|refresh|update/i.test(text)) return "已更新 Today 页面";
    if (/quality audit/i.test(text)) return "已完成知识质量检查";
    if (/vault audit/i.test(text)) return "已完成 Vault 检查";
    if (/runtime cleanup/i.test(text)) return "已清理运行历史";
    return labelJob(text, moduleId);
  }

  return { labelModule, labelJob, labelField, friendlyAction };
}

module.exports = { createPresentationFormatters };
