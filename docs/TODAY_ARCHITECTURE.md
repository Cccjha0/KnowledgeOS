# Today information architecture

`TodaySnapshot` is the only Today read model. Core creates it, `Today.md` renders it, and the Obsidian
sidebar renders the same API response. The plugin has no scanner, ranking algorithm, or Today cache.

## Section order

1. 今日重点 (at most five)
2. 待审核
3. 待处理 Inbox (global, module, instance groups)
4. 即将到期
5. 等待外部操作
6. 异常与失败
7. 最近完成 (at most ten)
8. 模块状态摘要

Empty sections are omitted. A fully quiet Today shows one short empty-state sentence rather than empty
headings.

## Core rules

- Core performs final ranking using priority, deadline, downstream blocking count, age and active context.
- Focus contains only actionable items and is capped at five.
- Duplicate module/Core observations are collapsed by source, target and category.
- Renderers keep a per-page item key set, so an item promoted into Focus is not repeated in a later section.
- Only enabled modules and active instances contribute Inbox and module items.
- Closed reviews do not enter the snapshot; due deferred reviews are requeued before collection.
- Run logs and transaction state are read by Core, never by the plugin.
- All paths returned to UI are Vault-relative.

## Markdown consistency and handwritten content

Core writes the generated sections and preserves this region byte-for-byte between its markers:

```markdown
## 我的笔记

<!-- knowledgeos:user:start -->
personal notes
<!-- knowledgeos:user:end -->
```

Users should put handwritten Today content inside that region. Rebuilding Today cannot overwrite it.
`generated_at` identifies the snapshot used for the Markdown render; the sidebar displays the response
from that same invocation.

## Availability

The persisted Markdown remains readable with the plugin, Codex, or network disabled. Interactive refresh
requires the local Core CLI. If refresh fails, the UI explains the impact and recovery actions while the
existing Markdown remains untouched.
