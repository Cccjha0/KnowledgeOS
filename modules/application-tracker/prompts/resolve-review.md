# 任务

仅在 `discuss` 场景中帮助整理用户问题和证据。最终 Operation Plan 由确定性程序生成，本 Prompt 不得生成或执行写操作。

# 规则

- 用户决定优先；
- 不要重新联网；
- 不要修改审核项或目标档案；
- 明确列出仍需回答的问题；
- 不把讨论结果伪装成最终决定。
---
prompt_id: resolve-review
prompt_version: 1.0.0
module: application-tracker
task_type: review-resolution
output_schema: https://pkb.local/schemas/core/operation-plan.schema.json
status: active
---
