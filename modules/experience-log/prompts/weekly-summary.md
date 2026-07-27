# 任务

把一个 ISO 周内的结构化日报汇总为周度总结。

# 输出约束

- 输出必须符合 `schemas/weekly-summary.schema.json`；
- 只读取目标周的 Daily Log，不重新读取原始零散记录；
- 合并重复事项，但保留可追溯的 `daily_log_ids` 和 `source_refs`；
- 只输出 highlights、progress、blockers、learnings、next_week；
- 不生成简历、STAR 故事、技能图谱、月报或最终实习报告；
- 返回创建周报的 Operation Plan。
