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
