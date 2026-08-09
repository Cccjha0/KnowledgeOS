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
| `application-structured-research-route` | `src/platform/inboxDiscovery.ts` | Existing `research_type: application-update` reports are routed with a trusted instance hint before generic Inbox routing. | `research-request` Capability: manifest-declared capture matcher and entry workflow. | `application-tracker` declares its report matcher and the generic Inbox router resolves it without recognising `application-update`. |
| `application-research-schema-component` | `src/components/researchReconciliation.ts`, `src/components/researchRequestScheduler.ts`, `src/platform/researchRequestWorkflow.ts`, `src/platform/reviewWorkflow.ts` | The first implementation was built around Application Record and Research Request schemas. | Versioned generic `research-request` Component with entity schema bindings provided by its consumer module. | The Component accepts module-provided record/request schema IDs and all application schema constants are removed from Core/Platform. |
| `application-inbox-preview-copy` | `src/platform/inboxWorkflow.ts` | Inbox preview still presents the structured research report route as a special mixed-risk plan. | Generic module-processing preview metadata returned by the route/component contract. | Preview uses a route-supplied operation summary and risk level rather than testing an Application processor name. |

## Migration sequence

1. Define `research-request` Component manifest and its input/output schemas as
   module parameters.
2. Add manifest-declared structured capture matchers and generic Inbox route
   metadata. Migrate the structured research route first.
3. Quality Audit now resolves a module-owned `stale_action` into a managed
   Task and uses the policy's deduplication contract; preserve that generic
   boundary as the research-request Component evolves.
4. Move Application's `sync-due-research` behavior behind that Component and
   preserve existing idempotency keys during the data migration.
5. Remove every entry above only after its focused regression test proves the
   generic path works for Application and at least one non-Application module.

## Explicit non-goal

This register is not a compatibility excuse. It makes the remaining debt
visible while avoiding a risky rewrite of a currently working Application
workflow during Milestone J. Course, Job Tracker, and future modules must not
add analogous Platform branches.
