# KnowledgeOS Obsidian Plugin (F02 MVP)

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
