# Evidence Locator Contract v1

This contract distinguishes an input a Workflow may read from a precise source
location that supports a particular output field.

## Core-issued catalogs

Before a Codex step runs, Core assigns each authorized document a stable
`source_id` and a per-source locator catalog. The isolated Context Workspace
exposes the catalog in `runtime-context.json`; the model cannot add files or
locations to it.

Core currently issues:

- PDF: `LOC-PAGE-0001` … for extracted pages that actually exist;
- PPTX: `LOC-SLIDE-0001` … for extracted slides that actually exist;
- Markdown: `LOC-HEADING-001` … for headings Core parsed from the admitted
  content, or `LOC-DOCUMENT` where no narrower safe location is available.

Metadata and summary representations expose only `LOC-DOCUMENT`, so the
catalog never leaks private headings or extracted text the Workflow did not
receive.

## Model proposal

The model may return the reserved, non-schema output field:

```json
{
  "_evidence_selection": {
    "deadline": [
      { "source_id": "SRC-…", "locator_id": "LOC-PAGE-0003" }
    ]
  }
}
```

Core removes this field before module-output Schema validation. It verifies
that the source belongs to the current Context and that the locator belongs to
that exact source, then materializes the Core-owned locator into an Evidence
Record. Raw `page`, `section`, `slide`, line ranges, paths, and invented locator
IDs are rejected from new Codex output.

## Write-time behavior

Core writes `_field_meta` and Evidence Records from selected locations only.
The broader `source_refs` list remains an audit of authorized Workflow inputs,
not a claim that every input proves every field.

When a Quality Contract declares `provenance: required`, a non-null value with
no selected source location is routed to Review. Criticality independently
raises review risk for high-impact updates; it does not by itself require an
Evidence selection.

## Compatibility

Existing persisted Review Items can retain their prior locator object while a
user completes that already-created review. This narrow migration path is never
available to new Codex output. New Workflows and fixtures must use
`source_id + locator_id`.
