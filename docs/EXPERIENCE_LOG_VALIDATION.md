# experience-log 通用性验证（阶段四）

## 验证结论

experience-log 已作为第二个模块接入。它与 application-tracker 的输入和输出模式明显不同，但仍复用了相同的模块发现、JSON Schema 验证、Vault 相对路径、Operation Plan、文件事务和 Dashboard/Event 契约，没有复制执行系统，也没有向 Core 添加实习专属字段。

## 第一版范围

```text
零散实习记录
  → Experience Entry
  → 按本地日期聚合 Daily Log
  → 按 ISO 周聚合 Weekly Summary
```

明确不实现：简历生成、STAR 故事、技能图谱、月报和最终实习报告。模块规则会把这些输出视为禁止范围。

## 接入内容

| 内容 | 位置 | 作用 |
| --- | --- | --- |
| Manifest | `modules/experience-log/module.yaml` | 声明文本输入、周期汇总、目录、权限、事件和周任务 |
| Schema | `schemas/` | Experience Instance、Entry、Daily Log、Weekly Summary |
| Prompt | `prompts/` | 匹配、日报结构化、周报汇总；限制不得扩展到非目标产物 |
| Workflow | `workflows/` | Capture 到日报、日报到周报 |
| Rules | `rules/` | 路径、日/周边界、幂等聚合和审核范围 |
| Templates | `templates/` | 日报和周报的最小 Markdown 结构 |
| Dashboard provider | `dashboard/` | 未处理条目与到期周报两个简单行动项 |

模块没有新增 `src/core` 执行分支。测试用 `source_module: experience-log` 的标准 Operation Plan，通过已有 `create-file` 操作同时创建并验证日报、周报。

## Core 修改审计

本阶段仅发现一个合理的 Core 契约不足：

| 修改 | 原因 | 为什么属于 Core |
| --- | --- | --- |
| 收紧 `module-manifest.scheduled_jobs` | 原字段允许任意对象，无法验证任务 ID、调度表达式、工作流路径或时区是否存在 | 周期任务是任何模块都可复用的 Manifest 接口，不包含 experience-log 字段或目录 |

结构固定为 `id`、`schedule`、`workflow`、`timezone`，其中工作流仍使用模块相对路径。除此之外，Core 代码和另外九个公共 Schema 均未修改。

不属于 Core 的改动：

- `tools/validate.py` 改为自动验证全部 `modules/*/module.yaml`；这是验证工具泛化。
- 模块发现测试增加 `experience-log` 断言；这是回归覆盖。
- 所有 Experience 字段、Prompt、路径和聚合规则都留在模块目录。

## 执行与调度边界

现有 Core 已能验证和执行模块返回的 Operation Plan。`scheduled_jobs` 目前是稳定的声明契约，但项目还没有常驻时钟调度服务；第一版周报可由用户或外部调度器触发 `build-weekly-summary` 工作流。自动按时唤醒属于后续 Shared Component，不应为 experience-log 写入 Core 特例。

## 验收证据

- Core 可以同时发现 application-tracker 和 experience-log。
- 两个模块 Manifest 均通过同一个公共 Schema。
- 四个 experience-log fixture 均通过模块 Schema。
- 日报与周报通过同一个 Core Operation Plan 执行器创建。
- Core 禁止词和模块副作用边界检查继续通过。
