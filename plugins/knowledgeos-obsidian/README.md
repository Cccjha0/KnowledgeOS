# KnowledgeOS Obsidian Plugin (F02 MVP)

This desktop-only MVP renders the Today sidebar from `getTodayItems`. It does not read or write
KnowledgeOS business files, Review Queue files, transaction state, or Git data directly.

For local installation, copy this directory to `.obsidian/plugins/knowledgeos/`, enable the plugin,
then set the absolute paths to `knowledgeos-engine/dist/cli.js` and the data Vault.
