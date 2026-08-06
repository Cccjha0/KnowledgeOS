# KnowledgeOS module platform contract

## Ownership and execution

- Modules own only their declared module and instance content roots.
- Modules propose structured Match Results, Operation Plans, Review Items, Dashboard Items, Events, and Jobs.
- Core validates permissions, creates snapshots, performs writes, records Runs, publishes Events, and updates Today.
- Cross-module collaboration uses persisted Events, never direct writes.
- Module directories contain declarative YAML, JSON Schema, Markdown Prompts/templates/docs, and fixtures; they contain no execution scripts.

## Extension choices

| Choice | Use when | Must not do |
| --- | --- | --- |
| Instance | A concrete use period/object shares an existing lifecycle | Duplicate module rules |
| Configuration Pack | One lifecycle needs a policy preset | Add an executor or bypass permissions |
| Component | Stateless capability is shared | Own business data or instances |
| Module | A domain has independent entities, lifecycle, permissions, and instances | Depend directly on another business module |

## Registered platform surfaces

Treat the repository as the source of truth:

- Ingestion formats: inspect `src/core/adapterRegistry.ts`; unavailable adapters fail Beta/Stable modules.
- Workflow Steps: inspect `src/modules/workflowStepRegistry.ts`; the Runner and Validator share this registry.
- Components: inspect `components/*/component.yaml` and declared versions.
- Operations: inspect `core/schemas/operation-plan.schema.json` and the Core Executor together.
- Capability Packs: inspect `core/module-builder/capability-packs.yaml`; resolve transitive dependencies and conflicts.
- Runtime Manifest: validate against `core/schemas/module-manifest.schema.json`.

Never infer support solely from a vocabulary enum or old design document.

## Privacy contract

Keep these dimensions separate:

- `sensitivity_class`: 0 public, 1 ordinary, 2 sensitive, 3 highly sensitive.
- representation: `metadata`, `summary`, `full`, `sensitive-original`.

Unclassified attachments default to metadata. A safe summary must be explicit; never use the first body paragraph as a summary. Context workspaces must contain only approved representations and record an auditable manifest.

Confirm with the user before enabling network access, global Event subscriptions, full/sensitive reads, mutable user originals, or destructive behavior.

## Review and testing contract

Ambiguous input must create a source-specific Review or stop safely. Repeated execution must have one business effect: unchanged entity IDs, file count/hashes, Review fingerprints, Event fingerprints, and operation effects.

Capability declarations drive tests:

- periodic summary → real module Job creation, dispatch, and output;
- event publishing → real declared publish step and ledger;
- event subscription → real Manifest/Job subscription and downstream Task;
- attachments/PDF → classification and extraction policy scenarios;
- migration → apply, repeat, rollback;
- Prompts → deterministic contract in CI; real-model evaluation is separate and non-CI by default.

## Capability Gap gate

A gap exists only when registered Packs, Components, Steps, Adapters, Schemas, and standard Operations cannot express the requirement. Do not disguise a business-specific field as a Core gap. Propose the smallest generic contract and wait for approval before changing Core.
