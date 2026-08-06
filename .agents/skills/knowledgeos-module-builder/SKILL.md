---
name: knowledgeos-module-builder
description: Convert a KnowledgeOS use case into a bounded Module, Component, Configuration Pack, or Instance decision; create and validate module.blueprint.yaml; resolve Capability Packs; generate deterministic module scaffolds; and verify generated modules without inventing Core capabilities. Use when designing, creating, reviewing, or extending a KnowledgeOS module, including natural-language module requests, Blueprint work, module scaffolding, Capability Gap analysis, and pre-Beta module acceptance.
---

# KnowledgeOS Module Builder

Turn requirements into a validated Blueprint before generating module files. Keep business design in Schema, Rules, Prompts, Workflows, fixtures, and Capability Packs; never create module-owned execution scripts.

## Load the platform contract

Read both references completely before changing a module:

- [platform-contract.md](references/platform-contract.md) for boundaries, available platform capabilities, privacy, and Capability Gap rules.
- [builder-workflow.md](references/builder-workflow.md) for the Blueprint interview, generation sequence, and acceptance commands.

Inspect the repository's current registries instead of assuming a reference is current:

- `core/schemas/module-blueprint.schema.json`
- `core/module-builder/capability-packs.yaml`
- `core/schemas/module-manifest.schema.json`
- `src/core/adapterRegistry.ts`
- `src/modules/workflowStepRegistry.ts`
- `components/*/component.yaml`

## Decide the extension boundary

Classify the request before creating files:

1. Use an Instance for a concrete object, owner, or time period of an existing module.
2. Use a Configuration Pack for policy, region, institution, or scenario variations within one module lifecycle.
3. Use a Component for stateless capability shared by multiple modules.
4. Use a Module only for an independent business entity, lifecycle, permissions policy, and instance boundary.

Reject both extremes: do not grow a universal module and do not create a module for every small feature.

## Build from a Blueprint

Follow this fixed sequence:

1. Summarize primary inputs, outputs, daily journey, users, and explicit exclusions.
2. Identify entities and assign `module`, `instance`, or `external` ownership.
3. Select the smallest base template and compose registered Capability Packs.
4. Declare input formats only when an installed Adapter is available.
5. Separate sensitivity class from representation level and protect user-owned content.
6. Declare Workflows, Review rules, Jobs, Events, Dashboard sections, and capability-driven tests.
7. Confirm high-impact choices with the user: network, sensitive/full reads, destructive behavior, critical fields, global Events, or new Core capabilities.
8. Write `module.blueprint.yaml` and validate it before scaffolding.
9. Generate through the deterministic CLI. Do not manually imitate scaffold output.
10. Fill business-specific Schema, Prompt, Rules, Workflows, and fixtures, then run focused validation and tests.

## Enforce safety gates

- Do not modify Core to satisfy a module request without an approved Capability Gap Report.
- Do not add `.ts`, `.js`, `.py`, shell, executable, or arbitrary-command files inside a module.
- Do not broaden read permissions to make a Workflow convenient.
- Do not bypass Review for ambiguity, critical fields, red operations, or protected content.
- Do not declare an Adapter, Component, Workflow Step, operation, Event scope, or runtime feature that the installed Engine does not provide.
- Do not call fixture-based Prompt contracts a real-model quality evaluation.
- Do not claim Beta readiness until required dynamic scenarios execute successfully.

When a missing capability is real, stop module implementation and produce:

```text
Capability Gap Report
- requested behavior
- why existing Module/Pack/Component/Workflow Steps cannot express it
- affected modules
- proposed generic Core contract
- privacy and permission impact
- migration and rollback impact
- focused acceptance tests
```

Wait for explicit approval before implementing that Core change.

## Report the result

Return:

- boundary decision and explicit exclusions;
- Blueprint path and validation result;
- resolved template, Capability Packs, Adapters, Components, and permissions;
- generated and manually completed files;
- focused checks run and their results;
- remaining Capability Gaps, visual/manual checks, and maturity blockers.

Honor repository-local `AGENTS.md`, including commit and focused-test requirements.
