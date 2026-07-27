# KnowledgeOS Obsidian Plugin (Milestone F MVP)

This desktop-only MVP renders Today, provides Quick Capture, and completes Review decisions through the
Core Command API. It does not read or write KnowledgeOS business files, Review Queue files, transaction
state, or Git data directly.

For local installation, copy this directory to `.obsidian/plugins/knowledgeos/`, enable the plugin,
then set the absolute paths to `knowledgeos-engine/dist/cli.js` and the data Vault.

Quick Capture is available from the ribbon, command palette, and file context menu. Core previews the
current instance and performs the actual save; failed saves keep the form text intact.

Review Center is available from the ribbon and command palette. “Discuss with Codex” copies a minimal,
versioned context package and requires the final structured outcome to be submitted back through Core.

Inbox Center is available from the ribbon, command palette, and Today Inbox summaries. It displays
Core routing explanations and execution previews, supports explicit module/instance overrides,
high-confidence batch processing, defer/ignore/unmanage, and failed-item retry. AI-dependent items stay
visible as waiting for Codex instead of being reported as completed.

System Center shows Core connectivity, module and instance status, recent runs, affected files,
operation summaries, errors, Git snapshots, and rollback safety. Rollback is revalidated by Core and
creates a separate audit Run. Developer mode reveals the underlying Plan and transaction only on demand.

Lifecycle controls use Core previews for module enable/disable/validation and instance creation,
pause/resume/complete/archive. Instance forms come from module declarations, and archive keeps all user
data while requiring confirmation when Inbox or Review work remains.

## F07 daily-use conventions

- Default shortcuts: `Ctrl/Cmd+Shift+C` opens Quick Capture and `Ctrl/Cmd+Shift+T` opens Today. They can be changed in Obsidian's Hotkeys settings.
- Inbox and Review lists render 50 items at a time, with an explicit “加载更多” control.
- Buttons, forms, focus outlines, live status regions, and theme colors use Obsidian-native controls and variables.
- Completion notices are configurable. Failures and rollback results always surface immediately; new Inbox work and ordinary background refreshes stay in Today.
- If Core is unavailable, forms retain user input and centers show a retry path. Today additionally opens the last generated `Today.md`, so persisted work remains usable offline.
- The plugin does not keep a second business-state cache. Reloading the plugin reconstructs every view from Core and Vault state.
