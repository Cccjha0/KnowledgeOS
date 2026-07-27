# KnowledgeOS Engine

Core 与模块的稳定边界、能力归属和公共 Schema 约定见 `docs/CORE_MODULE_BOUNDARY.md`。
申请模块的日常使用状态机、字段风险、Research Request 和 Dashboard 约定见 `docs/APPLICATION_TRACKER_DAILY.md`。
第二模块 experience-log 的范围、接入方式和 Core 修改审计见 `docs/EXPERIENCE_LOG_VALIDATION.md`。
生产目录边界、事务恢复、Schema 迁移和三层备份策略见 `docs/PRODUCTION_STABILITY.md`。
插件/Core v1 契约和 Today 单一数据模型见 `docs/PLUGIN_CORE_API.md` 与 `docs/TODAY_ARCHITECTURE.md`。
Quick Capture 的用户流程、上下文推断与幂等规则见 `docs/QUICK_CAPTURE.md`。
Review Center、目标字段对比和 Codex 结构化讨论回写见 `docs/REVIEW_CENTER.md`。
Inbox Center 的受管扫描范围、路由预览、批量安全规则和失败恢复见 `docs/INBOX_CENTER.md`。

Milestone F 的统一快捷键、加载/错误/通知规范、离线降级和完整用户旅程见 `docs/MILESTONE_F_DAILY_EXPERIENCE.md`。

Milestone G 的持久任务运行器、调度补偿、资源等待、Task Center、CLI runner 和真实离线验收协议见 `docs/MILESTONE_G_TASK_RUNNER.md`。
System Center 的运行摘要、撤销安全分级和恢复审计见 `docs/SYSTEM_CENTER.md`。
模块启停、实例创建向导和实例状态机见 `docs/LIFECYCLE_MANAGEMENT.md`。

KnowledgeOS 的代码仓库，包含 CLI、核心 Schema、模块定义、测试和设计文档。个人笔记与运行状态保存在相邻的 `knowledgeos-vault` 仓库。

当前可运行模块是 `application-tracker`，主要命令为：

```text
pkb application process-report
```

## 仓库边界

```text
knowledgeos-engine/
├── core/schemas/                  核心平台 Schema
├── modules/application-tracker/  模块定义、规则、Prompt 与 Schema
├── src/                           TypeScript 源码
├── tools/                         Python 桥接和验证工具
├── examples/                      测试 Fixture
├── docs/                          实现说明与系统规范
├── plugins/knowledgeos-obsidian/ Obsidian 交互层
└── dist/                          已编译 CLI
```

Vault 默认位于同级目录：

```text
../knowledgeos-vault
```

所有命令都可以通过 `--vault PATH` 指向其他 Vault。

## 环境要求

- Node.js 20 或以上
- Python 3.11 或以上
- Git

```powershell
python -m pip install -r requirements.txt
```

`dist/` 已包含当前编译结果。重新编译源码需要：

```powershell
npm install
npm run build
```

从 GitHub 克隆后的推荐安装方式：

```powershell
git clone <repository-url> knowledgeos-engine
cd knowledgeos-engine
npm install
npm link
```

`npm install` 会通过 `prepare` 自动构建 `dist/`；`npm link` 会在本机注册 `pkb` 命令。也可以不执行 `npm link`，继续使用 `node dist/cli.js`。

## 验证

```powershell
python tools/validate.py --vault ../knowledgeos-vault
node dist/cli.js validate --vault ../knowledgeos-vault
node --test dist/tests/*.test.js
```

当前自动化测试覆盖确定性比较、Vault/Git 初始化，以及批准、修改后批准、拒绝、延后、讨论和用户直接修改对账。

## Obsidian Today MVP

Milestone F 的首个插件视图只调用 Core Command API，不直接读取 Vault 内部状态：

```powershell
node dist/cli.js api getTodayItems `
  --vault ../knowledgeos-vault `
  --request-id REQ-MANUAL-001
```

本地插件源码位于 `plugins/knowledgeos-obsidian/`。将该目录复制到目标 Vault 的
`.obsidian/plugins/knowledgeos/` 后，在 Obsidian 中启用并配置 `dist/cli.js` 与 Vault 的绝对路径。
当前交付完成 Today、Quick Capture、Inbox Center、Review Center 和 System Center。Inbox Center 支持
执行前预览、显式路由、高置信度批量处理、延后/忽略/移出管理和失败重试；插件不会绕过 Core 直接读写文件。
System Center 支持模块/实例状态、Recent Runs、用户可读 Run 详情以及经过文件冲突和后续依赖检查的安全撤销。
F06b 生命周期接口进一步支持模块启用/停用/验证，以及实例创建、暂停、恢复、完成和无数据删除的归档。
F07 已统一默认快捷键、可访问状态、错误恢复、通知策略和长列表渐进加载；F16 的一周真实使用观察仍需在日常环境中完成。

## 初始化或接入 Vault

新建一个由 KnowledgeOS 管理 Git 快照的 Vault：

```powershell
node dist/cli.js vault init "D:\Obsidian\MyVault" --git-mode initialize
node dist/cli.js vault doctor "D:\Obsidian\MyVault"
```

接入一个已经由用户管理 Git 的现有 Vault：

```powershell
node dist/cli.js vault init "D:\Notes\ExistingVault" --git-mode existing
```

不使用 Git：

```powershell
node dist/cli.js vault init "D:\Notes\ExistingVault" --git-mode disabled
```

初始化是增量且幂等的：只补充缺失目录和状态文件，不覆盖已有笔记、`Today.md` 或 `.gitignore`。首次记录的 Git 模式不会被重复初始化命令静默修改。

Git 模式说明：

- `initialize`：适合 KnowledgeOS 专用 Vault；缺少仓库时自动执行 `git init -b main`，业务运行可自动创建快照提交。
- `existing`：适合用户已有的 Git Vault；KnowledgeOS 不自动提交用户修改，正式处理前要求仓库已有提交且工作区干净。
- `disabled`：不创建 Git 仓库，业务日志中的快照值记为 `disabled`。

初始化后会创建 `90-System/State/vault-config.json`。正式业务处理要求 Vault 已完成初始化。

## 处理研究报告

```powershell
node dist/cli.js application process-report `
  20-Workspace/Applications/australia-masters-2027/Inbox/2026-07-27-Monash-C6007-Update.md `
  --vault ../knowledgeos-vault
```

Dry Run：

```powershell
node dist/cli.js application process-report REPORT.md `
  --vault ../knowledgeos-vault `
  --dry-run
```

业务处理产生的 Git 快照只作用于 Vault 仓库，不会修改 engine 的版本历史。

## 处理人工审核

```powershell
node dist/cli.js review decide REV-2026-000001 approve `
  --comment "已核对官网" `
  --vault ../knowledgeos-vault

node dist/cli.js review reconcile --vault ../knowledgeos-vault
```

支持 `approve`、`approve-with-modification`、`reject`、`defer` 和 `discuss`。完整状态机、字段所有权、执行流程和 Today 规则见 `docs/REVIEW_WORKFLOW.md`。

更多实现细节见 `docs/PROCESS_REPORT_IMPLEMENTATION.md`，系统设计规范位于 `docs/specifications/`。
