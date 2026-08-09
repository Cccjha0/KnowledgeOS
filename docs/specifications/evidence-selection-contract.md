# Evidence Selection Contract v1

This contract distinguishes an input that a Workflow is permitted to read from
an input that actually supports a particular output field.

## Core-issued source handles

Before a Codex step runs, Core assigns every authorized document a stable
`SRC-…` handle derived from its Vault-relative reference. The isolated Context
Workspace exposes these handles in `runtime-context.json`, the Context
Manifest, and the copied document heading. The model never receives authority
to name arbitrary paths as evidence.

## Model proposal

The model may return the reserved, non-schema output field:

```json
{
  "_evidence_selection": {
    "deadline": [
      { "source_id": "SRC-…", "locator": { "page": 3, "section": "Application dates" } }
    ]
  }
}
```

Core removes this field before validating the module output schema. It accepts
only source IDs issued for the current Context Workspace and only the safe
locator keys `page`, `pages`, `slide`, `slides`, `section`, `anchor`,
`excerpt_ref`, `line_start`, and `line_end`. A reference to any other input is
rejected; no user file is read as a result.

## Write-time behavior

Core materializes field `_field_meta` and Evidence Records from the selected
sources only. The broader `source_refs` list remains an audit of authorized
Workflow inputs, not a claim that every input proves every field.

If an AI-produced Critical Field has no selected supporting source, Core adds a
`missing-evidence-selection` requirement and routes the Operation Plan through
Review. A Review created by a Module Workflow retains the selection so approval
uses the same exact evidence. Existing legacy single-field Reviews retain their
already field-scoped evidence during migration.
