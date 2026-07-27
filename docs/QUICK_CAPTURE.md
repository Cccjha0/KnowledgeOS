# Quick Capture flow and context rules

Milestone F03 exposes one Obsidian form for global, module, and instance Capture. Users enter normal
text; Core owns filenames, paths, frontmatter, validation, Git snapshots and execution.

## User flow (F05)

```text
Command / Ribbon / file menu
→ Core previews current context
→ user enters content and optionally changes destination, type, title, attachments
→ createCapture(request_id)
→ Operation Plan + Git snapshot + durable transaction
→ Capture file + Capture envelope + Run Log
→ Today refresh
→ “open file” or “continue recording”
```

The form never asks for YAML, status, path, filename, confidence or Schema fields. Empty content is
rejected before any plan is created. On failure the modal stays open and retains every input field.

## Context inference (F06)

Core applies this precedence order:

1. Explicit active instance. It must exist, belong to the selected module, and be active.
2. Current file inside the longest matching active instance `content_root`.
3. Explicit enabled module, routed to its declared module Inbox.
4. Current file inside a module workspace inferred from the module Inbox parent.
5. Global fallback: `00-Inbox`.

An explicit module suppresses automatic instance inference. An explicit instance determines its module.
Invalid explicit choices fail visibly; Core never silently redirects them elsewhere. Paused, completed,
archived, or disabled contexts are not automatic Capture targets.

The plugin sends only `active_path`; it does not inspect `instance.yaml`, `module.yaml`, or directory
rules. It obtains the displayed default by calling `createCapture` with `preview_only: true`, so preview
and save share exactly the same routing implementation.

## Stored data

The user-owned Markdown note contains a small system-generated frontmatter block plus the untouched
user content. Optional attachment paths are preserved as metadata and Obsidian links; files are not
copied or modified.

Core also stores a validated Capture envelope under `90-System/State/Captures/` containing the Vault-
relative path, hash, routing hints and read level. Request receipts under `90-System/State/Requests/`
support crash-safe retries without storing a second copy of the note text.

## Reliability rules

- A request ID can create at most one Capture file.
- Filenames combine time, a safe title and a request hash; separate rapid captures cannot overwrite.
- A duplicate click returns the original result.
- A mismatched reuse of a request ID fails with `IDEMPOTENCY_CONFLICT`.
- All writes use a green `create-file` Operation Plan and the existing durable executor.
- Capture works without network or Codex. It requires only the local Core CLI.
- A missing attachment, dirty `existing`-mode Git worktree, or invalid context leaves the note unwritten
  and the form content visible for retry.

## Acceptance coverage

- Global, module, instance, and current-context routing.
- Pure text can be submitted with two primary actions: open Capture, save.
- No module selection is required.
- Consecutive and duplicate submissions do not overwrite prior notes.
- Preview is read-only.
- Saved items immediately appear in the Core-generated Today Inbox count.
