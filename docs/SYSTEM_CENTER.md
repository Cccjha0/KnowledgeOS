# System Center（F11–F12 / 实施阶段 F06）

System Center 是插件中的健康、运行历史和恢复入口。插件仍然只是 Core Command API 的显示器和遥控器，不读取 `Logs`、`State`、事务备份、模块清单或实例 YAML。

## 第一版范围

System Center 展示：

- Core Command API 连接状态；
- 模块版本、状态、活跃实例数、Inbox/审核数量和最近运行；
- 实例状态、内容根目录、Inbox/审核数量和最近运行；
- 最近 20 次 Run；
- Run 的用户摘要、受影响文件、操作状态、审核、Git 快照和错误摘要；
- 撤销安全等级与执行入口。

模块启停、模块验证、实例创建、暂停、恢复和归档尚未加入冻结的 v1 Command API。插件明确显示这些能力未开放，不会直接修改 `module.yaml` 或 `instance.yaml`。它们属于后续 F06b 生命周期接口。

## Run 读模型

`getRecentRuns` 不再只返回 Run Log frontmatter，而是返回面向用户的摘要：

```text
来源动作
模块 / 实例
开始与完成时间
修改文件数量
操作数量与完成数量
创建审核数量
撤销评估
```

`getRunDetails` 默认返回简化的受影响文件和 Operation 摘要，不返回完整事务 JSON。只有设置中打开开发者模式，并传入 `developer_mode: true`，才返回底层日志、Plan 和事务记录。

历史 Run 没有记录读取级别或 AI 使用情况时，接口明确返回 `null` / `not-recorded`，不会推断或伪造。

## 撤销安全等级

每次显示详情和真正执行撤销时，Core 都重新评估当前文件状态：

### `safe`

- Run 已完成；
- 存在完整事务记录；
- 事务仍是 `completed`；
- 所有受影响文件仍与事务完成时的哈希一致；
- 没有更晚的完成 Run 引用相同文件。

### `confirmation-required`

- 文件仍与事务结果一致；
- 但存在更晚的完成 Run 引用相同文件。

调用方必须再次传入 `confirm: true`。插件会展示后续 Run ID 并要求确认。

### `unavailable`

- Run 失败或没有 Plan；
- 事务不存在、已撤销或不完整；
- 文件在 Run 后被用户或其他程序修改。

Core 会拒绝自动撤销，绝不静默覆盖更新内容。

## 撤销执行与审计

撤销流程为：

```text
重新评估 → 用户确认 → 全局执行锁 → 冲突复核 → 恢复事务快照
→ 清理幂等记录 → 写入新的 rollback Run Log → 重建 Today
```

撤销本身通常会产生新的 `RUN-*` 审计记录。原 Run 和原事务不会被删除；事务状态变为 `rolled-back`，因此不能重复撤销。若文件已成功恢复但审计日志或 Today 刷新随后失败，API 仍返回 `rolled-back`，并在 `warnings` 中明确说明后续记录问题，避免把已经发生的撤销误报为“未执行”。

## 用户错误边界

普通界面只显示：发生了什么、文件是否改变、可执行的恢复动作。技术堆栈保留在 API 的 `technical_details` 和开发者模式中。典型保护包括：

- `RUN_NOT_ROLLBACKABLE`：没有执行撤销；
- `ROLLBACK_CONFIRMATION_REQUIRED`：等待明确确认；
- `ROLLBACK_CONFLICT`：发现 Run 后修改，拒绝覆盖；
- `EXECUTION_LOCKED`：其他 Operation Plan 正在执行，稍后重试。
