const DEFAULT_SETTINGS = {
  coreCliPath: "",
  nodePath: "node",
  vaultPath: "",
  networkProbeUrl: "",
  codexModel: "gpt-5.6-terra",
  codexReasoningEffort: "medium",
  codexModelCatalog: [],
  codexModelsFetchedAt: null,
  openTodayOnStartup: true,
  autoRefresh: true,
  developerMode: false,
  notifyOnCompletion: true,
  allowBatchOperations: true,
};

const FALLBACK_CODEX_MODELS = [
  { id: "gpt-5.6-terra", model: "gpt-5.6-terra", display_name: "GPT-5.6 Terra", description: "KnowledgeOS 默认模型", supported_reasoning_efforts: ["low", "medium", "high", "xhigh"], default_reasoning_effort: "medium", is_default: true },
  { id: "gpt-5.4-mini", model: "gpt-5.4-mini", display_name: "GPT-5.4 Mini", description: "较低延迟的兼容选项", supported_reasoning_efforts: ["low", "medium", "high", "xhigh"], default_reasoning_effort: "medium", is_default: false },
  { id: "gpt-5.4", model: "gpt-5.4", display_name: "GPT-5.4", description: "兼容选项", supported_reasoning_efforts: ["low", "medium", "high", "xhigh"], default_reasoning_effort: "medium", is_default: false },
];

const REASONING_LABELS = {
  none: "无",
  minimal: "最小",
  low: "低",
  medium: "中（推荐）",
  high: "高",
  xhigh: "超高",
  max: "最大",
  ultra: "极致",
};

module.exports = { DEFAULT_SETTINGS, FALLBACK_CODEX_MODELS, REASONING_LABELS };
