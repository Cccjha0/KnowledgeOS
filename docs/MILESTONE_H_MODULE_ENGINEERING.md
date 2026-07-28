# Milestone H Module Engineering v1

## Extension decision guide

| Question | Choose | Owns business data | Own instance lifecycle |
| --- | --- | --- | --- |
| Is it one concrete object, project, or period? | Instance | No; data belongs to its Module | No |
| Is it a preset for regional or scenario differences? | Configuration Pack | No | No |
| Is it reusable by several Modules? | Component | No | No |
| Does it introduce distinct entities, workflow, permissions, and lifecycle? | Module | Yes | Yes |

Module types are `configuration`, `workflow`, and `integration`. A configuration Module contains no executable scripts. A workflow Module may declare state machines and Jobs but still delegates execution to Core. An integration Module normalizes external I/O into standard Captures or Events and does not own business decisions.

## Boundary checklist

- A Module owns only the content roots declared by its instances.
- Cross-Module collaboration uses Events; business Modules do not depend on one another.
- Components own no business files and create no instances.
- Configuration Packs cannot add an execution engine or broaden Module permissions.
- Modules return Match Results, Operation Plans, Reviews, Dashboard Items, Events, and Job declarations.
- Core alone writes files, operates Git, changes Today, executes plans, and persists Tasks.
- The Module SDK exposes controlled reads and builders. It exposes no arbitrary filesystem write, Git, delete, or cross-boundary write API.

In one sentence: **Modules propose versioned structured plans; Core validates, authorizes, snapshots, executes, and logs them.**

## Manifest v1

`module.yaml` is the only entry point. Manifest v1 freezes:

- lowercase kebab-case Module ID and semantic Module version;
- maturity: `experimental`, `beta`, `stable`, or `deprecated`;
- Engine API version and tested Core range;
- Module data Schema version;
- capabilities and explicit registries;
- permissions and Component dependency ranges;
- instance form and lifecycle ownership.

Validation has four layers: syntax, references, capability consistency, and security. A missing Prompt, unsafe Workflow executor, undeclared Component, cross-boundary permission, or custom executable prevents Beta eligibility.

## Version governance

- Module, Prompt, Workflow, and data Schema versions are independent.
- Published Prompt and Workflow files are immutable; registries select the active version.
- Selection supports Module default, instance pinning, and testing overrides.
- Every AI result records Module, Workflow, Prompt, adapter, model, Run, and generation time.
- A Prompt upgrade is activated only after structural, factual, and behavioral regression checks.
- Entity files record `schema_id`, `schema_version`, and `module_version`.
- Migration manifests declare preconditions, mapping, reversibility, Git snapshot requirements, and tests.

## Development commands

```text
pkb module create ID minimal-config|workflow|integration [DISPLAY_NAME]
pkb module validate ID
pkb module test ID
pkb module pack ID [OUTPUT]
pkb module install PACKAGE --vault VAULT
pkb module upgrade PACKAGE --vault VAULT [--confirm]
pkb module rollback ID --vault VAULT
```

Packages are local deterministic ZIP archives with the `.pkb-module` suffix. Installation unpacks into a temporary directory, verifies archive and content checksums, validates compatibility, dependencies and quality gates, creates a Git snapshot, installs a versioned directory, and updates `module-lock.json`. Permission expansion requires `--confirm`. Removal of Module code never implies removal of user data.

## Quality gates

Beta requires Manifest, Schema, dependencies, normal/ambiguous/error/duplicate behavior, permissions, pause/archive, and Prompt regression evidence with no failures or Critical warnings. Stable additionally requires migration and rollback coverage, a real-use cycle, complete README and CHANGELOG, immutable versioned Prompts, and result provenance.

The generated Validation Report uses `PASS`, `PASS WITH WARNINGS`, or `FAIL`. Stable does not accept warnings. System Center displays maturity, compatibility, Schema version, Prompt versions, latest validation counts, active instances, and health.
