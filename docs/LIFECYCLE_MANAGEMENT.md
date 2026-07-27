# Module and Instance Lifecycle（F06b）

F06b 在冻结的 Command API v1 上增加三个通用接口：

```text
manageModule
createInstance
manageInstance
```

插件只提交结构化意图。Core 负责验证状态、生成预览和 Operation Plan、创建 Git 快照、执行事务、写日志并刷新 Today。

## Vault 级模块状态

Engine 仓库中的 `module.yaml` 是模块发布配置，不保存某个用户的启停选择。用户选择保存在 Vault：

```text
90-System/Modules/installed.json
```

`discoverModulesForVault` 将发布清单与 Vault 覆盖合并。配置同步和模块升级会保留现有 `enabled` / `disabled` 状态。

停用模块的影响：

- 停止该模块的 Inbox 路由和处理；
- 隐藏该模块和活跃实例贡献的 Today 项；
- 不删除实例、业务文件、Inbox 文件、审核或运行历史；
- 直接打开用户数据仍然可用。

停用必须先预览并明确确认。重新启用后，活跃实例的 Inbox 与 Today 贡献恢复。`validate` 只读验证模块清单、实例 Schema 和依赖声明格式；组件安装可用性仍由配置同步和 Vault Doctor 负责。

## 模块声明实例表单

实例向导不在插件中硬编码申请或实习字段。每个模块可在 `module.yaml` 中声明通用 `instance_form`：

- 内容根目录和 Inbox 路径模板；
- 字段键、用户标签、类型、必填性、默认值和选项。

Core 根据声明构造实例数据，并使用模块自己的 instance Schema 验证。插件只渲染字段描述。

实例创建流程：

```text
选择模块 → 填写通用字段 → Core 预览路径和配置
→ Git 快照 → 创建目录标记和 instance.yaml → Schema 复核
→ Run Log → Today
```

实例 ID 和所有路径都经过 Vault 相对路径检查。已有实例或目标文件不会被覆盖。

## 实例状态机

第一版固定允许：

```text
planned  → active | archived
active   → paused | completed | archived
paused   → active | completed | archived
completed → archived
error    → archived
archived → 无后续自动转换
```

操作名称为 `activate`、`pause`、`resume`、`complete`、`archive`。非法转换由 Core 拒绝。

暂停或归档后：

- 实例 Inbox 不再进入自动发现；
- 实例 Today 提醒停止；
- 内容根目录、Inbox 和审核记录全部保留。

归档前 Core 统计实例 Inbox 和 Pending/Deferred/Error Review。存在未处理事项时必须 `confirm: true`，界面会明确展示数量。

## 可回滚执行

模块状态写入使用 `update-file` JSON Operation；实例状态使用 `update-instance` YAML Operation；实例创建使用受限的 `create-file` text/YAML Operation。所有目标均列入执行权限白名单和耐久事务快照。

因此模块启停、实例创建和状态变化都会出现在 Recent Runs，并可在文件未发生后续修改时通过 System Center 安全撤销。
