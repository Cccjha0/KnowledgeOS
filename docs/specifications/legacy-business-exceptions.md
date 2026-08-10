# Legacy Business Exceptions

This register records temporary module-specific behavior that still lives in
Core or Platform code. It is intentionally small and reviewable: a new
business exception must not be added as a convenience branch. New modules use
the Module Workflow Runner, Dashboard Provider, Event Bus, Capability Packs,
and Components instead.

## Policy

- An exception needs an owner, replacement contract, deletion condition, and
  regression test before it may remain in the Engine.
- It may preserve an existing user workflow, but cannot be copied for a new
  module.
- A module-specific `if (module === ...)` in `src/platform` or `src/quality`
  is rejected unless it is listed here.
- Migration work must move the contract into a Component or Capability Pack;
  it must not move the same branch to another Platform file.

## Registered exceptions

| ID | Current location | Why it remains | Replacement contract | Removal condition |
| --- | --- | --- | --- | --- |
| `application-document-identity` | `src/compatibility/legacyApplication.ts` | Existing Research Reports used `research_type: application-update` instead of module-owned `type` and `module_id`. | Module-owned Inbox Processor descriptors and schema identity. | Every retained legacy report has been migrated or is readable through a versioned migration adapter. |
| `application-cli-aliases` | `src/cli.ts`, `src/compatibility/legacyApplication.ts` | Existing scripts invoke `pkb application ...`. The aliases only forward to generic direct invocation or the generic research-request Component. | Module Workflow Runner / Command API. | A documented generic CLI workflow entry point has replaced the aliases and the deprecation window has expired. |

## Migration sequence

1. The generic `research-request` Component now receives record/request schema
   bindings, lifecycle values, and directory contracts from its consumer
   module. Keep future research modules on that contract rather than adding a
   business schema constant to Core or Platform.
2. Inbox structured-capture matching and preview metadata are now module-owned
   `inbox_processors`; keep future processors in the Manifest rather than Core.
3. Quality Audit now resolves a module-owned `stale_action` into a managed
   Task and uses the policy's deduplication contract; preserve that generic
   boundary as the research-request Component evolves.
4. Preserve existing idempotency keys during compatible module migrations.
5. Remove every entry above only after its focused regression test proves the
   generic path works for Application and at least one non-Application module.
6. Vault initialization is Core-only. `config sync` provisions directories
   declared by enabled module Manifests; it must not move module folders back
   into `vault init` or `vault doctor`.

## Explicit non-goal

This register is not a compatibility excuse. It makes the remaining debt
visible while avoiding a risky rewrite of a currently working Application
workflow during Milestone J. Course, Job Tracker, and future modules must not
add analogous Platform branches.
