# Review Center and Codex discussion protocol

Milestone F05 provides one cross-module Review Center in Obsidian. It consumes only
`listReviewItems` and `resolveReview`; Review Queue files, target frontmatter, Git and Operation Plans
remain behind the Core API.

## Review Center (F09)

The default list contains `pending` and `error`. Due deferred items are requeued before the list is
built; future deferred and closed items appear only when explicitly filtered.

Filters cover priority, module, instance, operation type, creation date, deferred date and status.
Core performs filtering and final priority/age ordering.

Each detail view contains:

- target file and field;
- current, old and suggested values;
- evidence and uncertainty reason;
- confidence, source module and instance;
- estimated affected files, fields and operation count;
- prior decisions and current resolution;
- actions allowed by the current state.

Available pending actions are accept, accept with modification, reject, defer, discuss, recompare and
mark a direct user edit as resolved. Error items expose retry. Closed items are read-only.

The UI collects only user-owned fields. Core generates timestamps, plans, snapshots, logs, status and
Today changes. Reject requires a reason. Modified values use JSON so booleans, numbers, null, strings,
arrays and objects retain their types. Defer provides tomorrow, three-day, one-week and custom dates.

## Direct target edits

The read model compares only the explicit structured field and reports one of:

```text
unchanged
matches-suggestion
changed
unavailable
```

For `changed`, the UI offers recompare, mark resolved by user edit, or leave the review untouched.
No body-text inference is performed.

## Codex discussion handoff (F10)

`resolveReview(mode: prepare-discussion)` returns a versioned minimal context and sets the API response
state to `waiting-for-ai`. The context contains only:

- Review ID, module, instance, action and confidence;
- target path and the relevant structured field value;
- suggested value, reason, evidence references and impact summary;
- prior Review decisions;
- allowed structured outcomes and instructions.

It never includes a whole directory or the full target body. The plugin copies this package for the
user to paste into Codex; it does not call AI or a module Prompt itself.

Every package has a SHA-256 `context_token`. The result must be returned through
`resolveReview(mode: apply-discussion-result)` with exactly one outcome:

```text
approve
approve-with-modification
reject
continue-waiting
needs-more-information
```

Core recomputes the context before accepting the result. If the Review or target field changed, it
returns `DISCUSSION_CONTEXT_STALE` and modifies nothing. Final decisions use the normal deterministic
Review workflow. Waiting/more-information outcomes append a `discuss` decision and keep the Review
pending.

The complete structured result is stored under `90-System/State/Review Discussions/<review-id>/` with
its context token and execution result. Therefore the conclusion is never left only in chat history.

## Reliability and boundary rules

- A per-review process lock rejects concurrent decisions with `REVIEW_IN_PROGRESS`.
- Terminal reviews still reject repeated processing.
- The plugin disables active submit buttons and refreshes from Core after completion.
- Today links open the shared Review Center instead of editing Review Queue Markdown.
- Discussion preparation is read-only; only structured result submission can change review state.
- Plugin closure does not change Core state and no UI cache is authoritative.
