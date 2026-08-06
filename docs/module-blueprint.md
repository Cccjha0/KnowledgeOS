# Module Blueprint v1.1

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

The Blueprint v1.1 contract is semantic as well as structural: entities declare their lifecycle and schema fields; Workflows declare the entities and representations they consume, their Prompt/output/Review/Operation mappings, and their concrete Event publications; Jobs bind to named Workflows. The Builder rejects generic placeholder mappings for these contracts.

## Vault module workspaces

When a Vault is supplied, Builder commands never create or overwrite an Engine source module. They use a three-stage Vault-owned layout instead:

```text
90-System/Module Development/{module_id}/
  Draft produced by Blueprint or scaffold commands. It is not installed or enabled.

90-System/Modules/Packages/{module_id}/{version}.pkb-module
  Local package built from a completed development workspace.

90-System/Modules/Installed/{module_id}/{version}/
  Immutable installed package used by the Vault at runtime.

90-System/Modules/Official/{module_id}/{version}/
  Engine-synchronised official module copies. User packages cannot replace these IDs.
```

For example:

```powershell
node dist/cli.js module create --from examples/module-blueprints/course.blueprint.yaml --vault C:\KnowledgeOS\my-vault
node dist/cli.js module validate course --vault C:\KnowledgeOS\my-vault
node dist/cli.js module test course --vault C:\KnowledgeOS\my-vault
node dist/cli.js module pack course --vault C:\KnowledgeOS\my-vault
node dist/cli.js module install C:\KnowledgeOS\my-vault\90-System\Modules\Packages\course\0.1.0.pkb-module --vault C:\KnowledgeOS\my-vault
```

Without `--vault`, CLI commands operate on the Engine's official source modules for Engine development only. A generated Vault workspace remains in the `implementation-required` state until it passes validation and tests, is packaged, and is explicitly installed.

The generated module stores a normalized copy of the Blueprint and a validation report. To change the design, edit the Blueprint and regenerate in a clean workspace target; do not treat generated files as the design source.

For the current automated and manual acceptance status, see [milestone-j-validation.md](milestone-j-validation.md).
