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
| `application-research-schema-component` | `src/components/researchReconciliation.ts`, `src/components/researchRequestScheduler.ts`, `src/platform/researchRequestWorkflow.ts`, `src/platform/reviewWorkflow.ts` | The first implementation was built around Application Record and Research Request schemas. | Versioned generic `research-request` Component with entity schema bindings provided by its consumer module. | The Component accepts module-provided record/request schema IDs and all application schema constants are removed from Core/Platform. |
| `application-document-identity` | `src/compatibility/legacyApplication.ts` | Existing Research Reports used `research_type: application-update` instead of module-owned `type` and `module_id`. | Module-owned Inbox Processor descriptors and schema identity. | Every retained legacy report has been migrated or is readable through a versioned migration adapter. |
| `application-cli-aliases` | `src/cli.ts`, `src/compatibility/legacyApplication.ts` | Existing scripts invoke `pkb application ...`. The aliases only forward to generic direct invocation or the generic research-request Component. | Module Workflow Runner / Command API. | A documented generic CLI workflow entry point has replaced the aliases and the deprecation window has expired. |

## Migration sequence

1. Define `research-request` Component manifest and its input/output schemas as
   module parameters.
2. Inbox structured-capture matching and preview metadata are now module-owned
   `inbox_processors`; keep future processors in the Manifest rather than Core.
3. Quality Audit now resolves a module-owned `stale_action` into a managed
   Task and uses the policy's deduplication contract; preserve that generic
   boundary as the research-request Component evolves.
4. Move Application's `sync-due-research` behavior behind that Component and
   preserve existing idempotency keys during the data migration.
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
