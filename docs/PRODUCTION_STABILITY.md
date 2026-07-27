# Milestone E：生产稳定化

## 数据与配置边界

Vault 中的所有内容按所有权分为三层：

```text
90-System/
├── Core/                 已安装 Engine 与备份策略
├── Modules/              按 module/version 保存的只读配置快照
├── Components/           已安装公共组件清单
├── Instances/            用户启用的模块实例配置
├── State/                可恢复的运行状态
│   ├── Plans/
│   ├── Transactions/
│   ├── Migrations/
│   └── Locks/
├── Logs/                 每次业务运行和迁移的审计日志
└── Cache/                可删除、可重建，不作为唯一数据来源

20-Workspace/             用户工作数据
30-Knowledge/             用户沉淀的长期知识
```

Engine 升级只允许更新 `90-System/Core`、`Modules` 和 `Components`。`pkb config sync` 以 `module/version` 写入配置快照，不扫描或覆盖 `20-Workspace`、`30-Knowledge`。运行状态与缓存也不混入模块安装目录。

## 持久化事务

每个 Operation Plan 都在 `90-System/State/Transactions/{PLAN_ID}` 保存：

- `transaction.json`：计划、每个 Operation 的状态、错误、Git 快照；
- `backups/`：修改前文件的逐字节副本，包括不进入 Git 的附件；
- 幂等键完成账本：`90-System/State/idempotency.json`。

每次状态写入同时镜像到 `90-System/Logs/Transactions/{PLAN_ID}.json`，因此即使上层工作流在写业务 Run Log 前失败，也能按 Plan ID 找到审计记录。

状态固定为：

| 状态 | 含义 | 是否自动重放 |
| --- | --- | --- |
| `not-started` | 已登记，但尚未开始修改 | 否 |
| `in-progress` | 已建立完整磁盘快照，正在逐项执行 | 否；重启后先恢复 |
| `completed` | 全部操作完成，幂等键已登记 | 重复执行同一 Plan 直接返回 |
| `partially-failed` | 至少一个操作失败，正在进入恢复 | 否 |
| `rolled-back` | 已恢复到执行前字节状态 | 否；重新生成新 Plan |
| `manual-action-required` | 文件占用或介质错误导致自动回滚不完整 | 否；保留快照和错误供人工处理 |

同一时刻只有一个进程可持有 `90-System/State/Locks/operation-plan.lock.json`。活进程持锁时拒绝并发执行；死进程留下的锁会触发中断事务恢复。每个操作在执行前写入 `in-progress`，完成后再写 `completed`，因此断电位置可定位。

常用恢复命令：

```powershell
pkb vault doctor --vault D:\Notes\MyVault
pkb transaction recover --vault D:\Notes\MyVault
pkb transaction rollback PLAN-2026-000001 --vault D:\Notes\MyVault
```

## Schema 迁移

模块迁移定义保存在 `modules/{module}/migrations/`，只允许相邻版本迁移。流程固定为：

```text
检测旧 schema_version
→ 写入 Migration Run 和最终 Operation Plan
→ 创建 Git 快照
→ 建立持久化文件快照
→ 执行 migrate-frontmatter
→ 用目标 Schema 逐文件验证
→ 写 Run Log
→ 完成；或自动回滚
```

```powershell
pkb migration plan --vault D:\Notes\MyVault
pkb migration apply MIG-2026-000001 --vault D:\Notes\MyVault
```

迁移步骤只支持通用的 `set`、`remove`、`rename`，业务字段和目标路径必须留在模块迁移文件。迁移后的 Schema 仍应在兼容窗口内读取旧版本，直到备份和迁移验证完成。当前示范迁移为 application-record v1→v2。

## 异常恢复矩阵

| 故障 | 识别方式 | 恢复行为 |
| --- | --- | --- |
| Codex 或进程中途退出 | 锁的 PID 已失效，事务为 `in-progress` | 下次恢复扫描按持久快照回滚 |
| 文件写入失败或被占用 | Operation 标记 `failed` | 回滚全部目标；仍占用则 `manual-action-required` |
| 电脑突然关机 | 磁盘事务日志最后状态不是终态 | 不自动重放，先恢复再由新 Plan 重试 |
| Operation Plan 执行一半 | 每步状态和全部执行前快照已落盘 | 逆序恢复全部目标 |
| Git 提交失败 | Migration/Plan 保持未执行，错误写入状态 | 不开始数据修改 |
| Schema 验证失败 | 修改写入前或迁移后验证失败 | Transaction 自动回滚；迁移标记 `rolled-back` |
| 重复提交同一任务 | Plan 终态和全局幂等账本命中 | 跳过已完成操作，不重复追加或创建 |
| 完成后用户又修改目标 | 回滚前比对事务完成时 SHA-256 | 拒绝覆盖新修改并标记 `manual-action-required` |

`vault doctor` 会报告缺失配置、目录、Git 问题，以及 `not-started`、`in-progress`、`partially-failed`、`manual-action-required` 事务。

## 三层备份策略

### 1. Git 本地历史

- 每次正式执行和迁移前创建 Git 快照。
- `initialize` 模式由 KnowledgeOS 自动维护本地提交。
- `existing` 模式要求用户工作区干净，不擅自提交用户修改。
- 不进入 Git 的大附件仍由下面的压缩备份覆盖。

### 2. Vault 压缩备份

```powershell
pkb backup create E:\KnowledgeOS-Backups --vault D:\Notes\MyVault
pkb backup verify E:\KnowledgeOS-Backups\KnowledgeOS-Vault-YYYYMMDDTHHMMSSZ.zip
```

ZIP 包含配置、用户数据、运行状态、日志和附件；排除 `.git`、可重建 Cache 与临时文件。包内 manifest 保存每个文件的大小和 SHA-256，校验失败时禁止恢复。建议至少每周一次，并保留 4 个周备份和 3 个月备份。

### 3. 异地或云端

将已验证的 ZIP 同步到与本机不同的存储位置，例如对象存储、NAS 异地副本或端到端加密云盘。KnowledgeOS 第一版不保存云端凭据，也不假定具体供应商；`90-System/Core/backup-policy.json` 明确要求异地副本。大附件必须包含在 ZIP 或使用独立、可校验的附件备份，不能只依赖 Git。

## 灾难恢复演练

删除整个运行环境后：

1. 重新克隆 Engine 仓库并安装依赖；
2. 验证备份：`pkb backup verify ARCHIVE.zip`；
3. 恢复到空目录：`pkb backup restore ARCHIVE.zip NEW_VAULT`；
4. 运行 `pkb vault doctor --vault NEW_VAULT`；
5. 运行 `pkb transaction recover --vault NEW_VAULT`；
6. 运行 `pkb config sync --vault NEW_VAULT`，保留旧的版本化模块快照；
7. 运行 `pkb migration plan` 和 `pkb validate`。

只有完成一次“备份、校验、恢复到新目录、doctor/validate 通过”的演练，才算备份策略有效。
