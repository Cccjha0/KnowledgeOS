# 匹配规则

根据 capture 的 Vault 路径、`module_id` 提示和文本内容判断是否属于 experience-log。

- 位于模块或实例 Inbox：高置信度匹配；
- 明确包含当日完成、阻塞、学习或下一步行动：可匹配；
- 求职申请、课程笔记或申请跟踪内容：不匹配；
- 不读取 Vault 外内容，不联网。

输出 Core Match Result。
