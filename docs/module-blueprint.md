# Module Blueprint v1

`module.blueprint.yaml` is the design source used by Module Builder. `module.yaml` remains the runtime contract consumed by Core.

The Builder always follows this sequence:

```text
Blueprint Schema validation
→ Capability Pack resolution
→ Adapter and Component checks
→ privacy, Event, Workflow and test consistency checks
→ deterministic scaffold generation
→ runtime Manifest validation
```

## Required design areas

- `module`, `module_class`, and `use_cases` define the boundary and explicit exclusions.
- `entities` defines data ownership before files or Prompts are generated.
- `inputs` must map to installed Ingestion Adapters.
- `privacy` separates sensitivity from the maximum representation a Workflow may read.
- `workflows`, `jobs`, and `events` define execution without custom module scripts.
- `review_policy` prevents ambiguity and destructive actions from bypassing Review.
- `testing` makes dynamic capabilities declare their executable acceptance scenarios.

Use `base_template` for the smallest structural base and compose behavior with `capability_packs`. Pack dependencies are resolved transitively; conflicts and unavailable Adapter or Component requirements fail before files are created.

```powershell
npm run build
node dist/cli.js module blueprint validate examples/module-blueprints/course.blueprint.yaml
node dist/cli.js module create --from examples/module-blueprints/course.blueprint.yaml
```

The generated module stores a normalized copy of the Blueprint and a validation report. To change the design, edit the Blueprint and regenerate in a clean module target; do not treat generated files as the design source.

For the current automated and manual acceptance status, see [milestone-j-validation.md](milestone-j-validation.md).
