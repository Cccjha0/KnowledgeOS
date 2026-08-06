# Module Builder workflow

## Requirement interview

Collect or infer, then present for confirmation:

1. User, problem, normal input, normal output, and daily journey.
2. Explicit exclusions and irreversible/external actions.
3. Entities, ownership, lifecycle, and instance boundary.
4. Input formats and attachment roles.
5. Sensitivity, required representation, user-owned regions, and network policy.
6. Capture/manual/schedule/field-due/event/startup Workflows.
7. Critical fields, ambiguity handling, and forbidden operations.
8. Jobs, catch-up behavior, Event publications/subscriptions, and Dashboard actions.
9. Normal, ambiguous, repeat, permission, resource, lifecycle, Prompt, Job, Event, attachment, and migration tests as applicable.

Do not ask for low-level file names the deterministic scaffold can choose. Ask only about decisions that change ownership, privacy, side effects, or user experience.

## Blueprint sequence

1. Copy the nearest example from `examples/module-blueprints/` only as a structural reference.
2. Use Blueprint v1 fields exactly; do not add hidden implementation details.
3. Select one base template: `minimal-config`, `standard-workflow`, or `integration`.
4. Compose registered Packs; allow the resolver to add dependencies.
5. Validate before creating any module directory:

```powershell
npm run build
node dist/cli.js module blueprint validate path/to/module.blueprint.yaml
```

6. Resolve every failure. Do not scaffold on warnings that affect privacy or runtime support.
7. Generate once into a non-existing module target:

```powershell
node dist/cli.js module create --from path/to/module.blueprint.yaml
```

`module scaffold --from` is an equivalent expert-mode entry point.

## Complete the generated module

Treat `module.blueprint.yaml` as the design source. Complete only business-specific declarative artifacts:

- entity Schemas and registry versions;
- deterministic path/naming/ownership rules;
- versioned Prompts with output Schemas and protected invariants;
- versioned Workflows using registered Steps;
- Review and quality policies;
- Jobs and Events declared consistently in Manifest and registries;
- templates, Dashboard provider, migrations, and executable fixtures.

Never add a custom executor or business branch to Platform runtime handlers.

## Acceptance sequence

Run only affected checks while developing, respecting `AGENTS.md`:

```powershell
npm run build
node dist/cli.js module blueprint validate path/to/module.blueprint.yaml
node dist/cli.js module validate MODULE_ID
node dist/cli.js module test MODULE_ID
```

Before claiming Beta, verify generated reports identify the Engine version, module checksum, fixture checksum, OS, Node, Python, and deterministic Prompt-contract scope. State any real-model evaluation, sandbox usage, migration, or unfamiliar-user test that remains outstanding.
