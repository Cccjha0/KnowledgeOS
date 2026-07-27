# `pkb application process-report` 工程实现说明

## 仓库边界

- engine 仓库保存 CLI、核心 Schema、模块定义和工具；
- Vault 仓库保存个人内容、实例、状态、审核项和日志；
- 运行时通过 `--vault` 显式指定 Vault；
- Git 事务快照仅作用于 Vault 仓库。

Vault 必须先通过 `pkb vault init` 初始化。初始化配置记录于 `90-System/State/vault-config.json`，支持 `initialize`、`existing` 和 `disabled` 三种 Git 模式。

## 当前实现状态

该命令已经跑通以下真实文件链路：

```text
实例 Inbox 中的 Markdown 研究报告
→ YAML Frontmatter 解析
→ research-report JSON Schema 验证
→ 实例配置加载与验证
→ application-record 定位与验证
→ 结构化字段比较
→ update-result 生成与验证
→ Operation Plan 生成与验证
→ Git 快照
→ 申请档案更新
→ 研究报告归档
→ Review Queue 写入
→ processed-reports 状态写入
→ 运行日志生成
→ Today.md 重建
```

## 为什么 MVP 使用确定性比较器

研究报告已经被 `research-report.schema.json` 约束成结构化字段，因此：

- 相同值判断；
- 核验时间更新；
- 下一次检查时间计算；
- 来源合并；
- 关键字段识别；
- Review Item 创建；

都不需要调用语言模型。

这部分由 `DeterministicComparisonAdapter` 完成。它是默认适配器，也是后续 Codex 适配器的安全基线。

```text
src/application/adapter.ts
```

未来增加 Codex 适配器时，只需实现同一个接口：

```ts
interface ComparisonAdapter {
  readonly id: string;
  compare(record, report, options): Promise<UpdateResult>;
}
```

推荐的调用策略是：

```text
确定性比较器先处理结构化字段
→ 发现语义冲突或非结构化差异
→ 只把相关字段和证据交给 Codex
→ Codex仍必须输出 update-result Schema
```

不要让 Codex 绕过 Operation Plan 直接修改 Vault。

## 事务边界

每次运行拥有：

- `TASK-*`；
- `PLAN-*`；
- `RUN-*`；
- Git 快照；
- 临时文件备份；
- 处理日志。

正式写入前先验证所有 Schema。写入失败时恢复目标档案和研究报告。

## 幂等性

`90-System/State/processed-reports.json` 保存：

- `report_id`；
- 文件 Hash；
- 处理时间；
- Run ID；
- 归档位置。

同一个 `report_id + hash` 再次执行时返回：

```json
{
  "status": "already-processed"
}
```

不会重复追加变更记录，也不会重复创建审核项。

## 关键字段策略

以下字段发生变化时不会自动覆盖：

- `application_status`；
- `application_open`；
- `deadline`；
- `tuition`；
- `academic_requirement`；
- `english_requirement`。

系统会创建 Review Item，并在 `Today.md` 中显示。

## 当前桥接层

Node 运行时不依赖第三方 npm 包。YAML 和 JSON Schema 校验暂时通过：

```text
tools/pkb_bridge.py
```

调用 Python 的：

- PyYAML；
- jsonschema；
- referencing。

这样可以先稳定接口与数据链路。后续开发 Obsidian 插件时，可将桥接层替换为 Ajv + YAML npm 包，而不改变业务接口。
