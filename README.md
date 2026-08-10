# KnowledgeOS

KnowledgeOS is a local-first knowledge operating system for Obsidian. It keeps
user notes in a Vault, while the Engine provides durable task execution,
reviewable changes, module workflows, evidence and freshness checks, and an
Obsidian-native interface.

This repository is the **Engine source repository**. Your notes, attachments,
runtime database, and private operational history belong in a separate Vault
repository and are never committed here.

## Current status

KnowledgeOS is currently **`0.9.0-beta`**. It is suitable for controlled
personal use and active development, not yet a stable `1.0` release.

| Part | Status | Notes |
| --- | --- | --- |
| Engine | `0.9.0-beta` | Core Command API, durable task runner, review and quality systems |
| Obsidian plugin | `0.9.0-beta` | Today, Quick Capture, Inbox, Review, Task and System views |
| `application-tracker` | `0.3.0-beta` | Application records, research requests, reviewable updates |
| `experience-log` | `0.3.0-beta` | Capture-to-daily-log and weekly summary workflows |
| `reading-log` | `0.2.0-beta` | Reading captures, notes, index, and weekly summaries |
| `course` | experimental / disabled | Module Builder and real-business acceptance fixture; not enabled by default |

## What is implemented

- A persistent SQLite-backed task runner with scheduling, idempotency, retry,
  resource gates, startup recovery, and task/run history.
- A review queue with explicit decisions: approve, modify-and-approve, reject,
  defer, and discuss.
- A generic Module Workflow Runner: modules declare schemas, workflows,
  prompts, rules, dashboard descriptors, events, and jobs; Core validates and
  executes their structured plans.
- Local attachment ingestion for Markdown, text, JSON, YAML, image metadata,
  PDF text extraction, and PPTX slide extraction. Original assets are kept
  immutable; derived metadata, extraction cache, and Companion Notes are
  tracked separately.
- Context workspaces that give Codex only the approved task inputs—not the
  whole Vault—and record input scope, read representation, and budget.
- Field-level provenance and freshness policies, Quality Issues, audits,
  review-debt control, explanation chains, and a Quality Dashboard.
- Module Builder contracts, scaffold/readiness/test/sandbox/package flows, and
  a Guided Builder in the Obsidian plugin.

## Repository boundaries

```text
knowledgeos-engine/                 # this repository
├── core/schemas/                   # public Core schemas
├── components/                     # reusable generic components
├── modules/                        # built-in module packages
├── src/                            # Engine TypeScript source
├── plugins/knowledgeos-obsidian/   # Obsidian plugin source and assets
├── tools/                          # Python bridge and validation utilities
└── docs/                           # design, operations, and acceptance docs

knowledgeos-vault/                  # separate, private Vault repository
├── 20-Workspace/                   # module and instance data
├── 30-Knowledge/                   # user knowledge
└── 90-System/                      # installed modules, state, logs, cache
```

`dist/` is intentionally not committed. Build it locally before running the
CLI or configuring the plugin.

## Requirements

- Node.js 20 or later
- Python 3.11 or later
- Git (recommended for snapshots and rollback)
- Obsidian desktop (optional, for the plugin)

## Install from source

```powershell
git clone https://github.com/Cccjha0/KnowledgeOS.git knowledgeos-engine
cd knowledgeos-engine
npm ci
python -m pip install -r requirements.txt
npm run build
```

Run the CLI through `node dist/cli.js`, or optionally register `pkb` locally:

```powershell
npm link
pkb help
```

## Create or connect a Vault

Create a new dedicated Vault with local Git snapshots:

```powershell
node dist/cli.js vault init "D:\Obsidian\KnowledgeOS Vault" --git-mode initialize
node dist/cli.js vault doctor "D:\Obsidian\KnowledgeOS Vault"
```

Connect an existing Vault without changing its Git mode:

```powershell
node dist/cli.js vault init "D:\Notes\Existing Vault" --git-mode existing
```

Or use no Git integration:

```powershell
node dist/cli.js vault init "D:\Notes\Existing Vault" --git-mode disabled
```

`vault init` is additive and Core-only: it never creates an
application-specific directory or overwrites an existing note. It then runs
configuration sync, which provisions only module-level directories declared
by enabled Module Manifests. Re-run sync after updating built-in modules:

```powershell
node dist/cli.js config sync --vault "D:\Obsidian\KnowledgeOS Vault"
```

## Obsidian plugin

1. Complete the Engine installation and build above.
2. Copy `plugins/knowledgeos-obsidian/` to:
   `<vault>/.obsidian/plugins/knowledgeos/`
3. Enable **KnowledgeOS** in Obsidian Community Plugins.
4. In plugin Settings, choose the built `dist/cli.js` and the Vault path, then
   use **Test connection**.

The plugin communicates only through the Core Command API. It does not read or
write Vault internals directly.

## Everyday flow

```text
Quick Capture / Inbox item
        ↓
route + privacy / asset policy checks
        ↓
durable Task and Module Workflow
        ↓
structured Operation Plan
        ↓
automatic execution or Review Item
        ↓
Today, Task Center, Run log, provenance, and Quality state update
```

If an attachment lacks a safe classification or a PDF has partial extraction,
Inbox presents the precise action required. The user can choose its role and
access policy, then Core updates the Sidecar, Companion Note, task state, and
audit trail atomically.

## Useful commands

```powershell
# Show all CLI commands
node dist/cli.js help

# Run the normal persistent task cycle
node dist/cli.js runtime run-once --vault "D:\Obsidian\KnowledgeOS Vault"

# Rebuild Today from current durable state
node dist/cli.js dashboard build --vault "D:\Obsidian\KnowledgeOS Vault"

# Validate or test an installed/built-in module
node dist/cli.js module validate reading-log
node dist/cli.js module test reading-log

# Inspect a Module Builder Blueprint
node dist/cli.js module blueprint validate path\to\module.blueprint.yaml
```

`pkb application process-report`, `research-sync`, and `research-start` remain
available only as deprecated compatibility aliases for existing scripts. New
integrations should use the Module Workflow Runner or Core Command API instead.

## Development and verification

```powershell
# Full local Engine check
npm test

# Cross-platform Engine test entry used by CI
npm run test:engine

# Obsidian Core Command client smoke test
npm run test:plugin-smoke

# Optional real Codex context-isolation integration test
npm run test:codex-isolation
```

GitHub Actions runs the Engine and module validation/test coverage across the
supported Node, Python, Windows, and Ubuntu matrix. The real Codex isolation
test is intentionally opt-in because it requires a configured Codex runtime.

## Key documentation

- [Core / Module boundary](docs/CORE_MODULE_BOUNDARY.md)
- [Module Builder Blueprint](docs/module-blueprint.md)
- [Milestone H: module engineering](docs/MILESTONE_H_MODULE_ENGINEERING.md)
- [Milestone I: quality and observability](docs/MILESTONE_I_QUALITY_OBSERVABILITY.md)
- [Legacy access-policy migration](docs/LEGACY_ACCESS_POLICY_MIGRATION.md)
- [Task runner](docs/MILESTONE_G_TASK_RUNNER.md)
- [Today architecture](docs/TODAY_ARCHITECTURE.md)
- [Inbox Center](docs/INBOX_CENTER.md)
- [Review workflow](docs/REVIEW_WORKFLOW.md)
- [Plugin / Core Command API](docs/PLUGIN_CORE_API.md)
- [Course business acceptance](docs/COURSE_BUSINESS_ACCEPTANCE.md)

## Privacy and safety model

- Core performs all Vault writes, Git snapshots, and Operation Plan execution.
- Modules propose structured results; they cannot directly write arbitrary
  files, invoke Git, or bypass Review.
- A document's privacy sensitivity and a workflow's requested representation
  are checked separately.
- Unclassified assets fail closed to metadata-only access.
- Field evidence must reference Core-issued source and locator IDs; AI cannot
  invent arbitrary paths or page numbers.
- Critical changes and policy-defined evidence/freshness requirements are
  enforced by Core rather than by prompt instructions alone.
