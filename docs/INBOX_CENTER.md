# Inbox Center（F07–F08 / 实施阶段 F04）

Inbox Center 是所有受管 Inbox 的统一入口。插件只展示和提交动作；发现、路由判断、预览、Operation Plan、Git 快照、执行状态与日志都由 Core 负责。

## 扫描边界

Core 只扫描以下目录，不扫描整个 Vault：

- 全局 `00-Inbox`；
- 已启用模块在 `module.yaml` 声明的模块 Inbox；
- 活跃实例在 `instance.yaml` 声明的实例 Inbox。

每个条目返回稳定的路径派生 `item_id`、来源范围、建议模块/实例、置信度、理由、读取级别、是否需要 AI、处理器类型与持久状态。文件移动到另一层 Inbox 后会成为新路径下的新阶段条目，原阶段记录保留为 `processed`。

## 状态与操作

状态固定为：

```text
pending
waiting-for-user
waiting-for-ai
failed
deferred
processed
ignored
unmanaged
```

- `preview`：只返回归属、目标、内容类型、预计操作数、读取级别、AI 依赖和风险，不写文件。
- `process`：结构化申请研究报告进入 application-tracker 的正式处理器；全局条目可通过一条 `move-file` Operation Plan 路由到模块/实例 Inbox。
- `retry`：仅显式重试失败项。
- `defer`：保存未来 ISO 时间；到期后重新成为 `pending` 或 `waiting-for-ai`。
- `ignore`：文件保留在原处，但默认列表不再显示。
- `unmanage`：文件保留在原处，并明确退出系统管理。

experience-log 当前需要 Codex Prompt。Core 会返回 `ok: true`、`state: waiting-for-ai`，不会把“等待 AI”伪装成“已处理”。

## 批量安全规则

`processInboxBatch` 必须显式提供 `item_ids`，模式只能是 `high-confidence`，单批最多 50 项。Core 对每项重新检查：

- 置信度达到该模块的 `auto_route_threshold`；
- 不依赖 AI；
- 条目仍存在于受管 Inbox。

不满足条件的项逐项标记 `skipped`，其文件保持不变；单项失败不会阻止其余项，返回成功、跳过和失败的汇总。

## 持久化与恢复

条目状态保存在 `90-System/State/Inbox/<item_id>.json`。实际路由和模块处理仍遵循：

```text
用户动作 → 最终 Operation Plan → 权限检查 → Git 快照 → 执行 → 状态/日志 → Today
```

单项锁阻止重复点击并发处理；Operation Plan 事务负责半途失败回滚。失败原因会进入条目状态，Inbox Center 提供显式重试。
