# Course business acceptance

Course is now a semantic Blueprint v1.1 module rather than a generic record
scaffold. Its declared business boundary is:

| Input role | Entry workflow | Entity output | Event |
| --- | --- | --- | --- |
| `lecture-material` in `Inbox/Lectures/` | `normalize-lecture` | `course-lecture` in `Lectures/` | `course.lecture-created` |
| `assignment-brief` in `Inbox/Assignments/` | `normalize-assignment` | `course-assignment` in `Assignments/` | `course.assignment-created` |
| scheduled weekly summary | `generate-weekly-summary` | `course-weekly-summary` in `Summaries/` | none |

`Inbox/Private/` is metadata-only and deliberately has no automatic entrypoint.
It must remain under user review rather than being silently sent to Codex.

## Completed checks

- Blueprint v1.1 validation passes.
- Runtime Module validation passes all semantic Blueprint, schema, prompt,
  workflow, event, privacy, ownership, dashboard, job, and adapter checks.
- The isolated fixture runner now supports additional declared Capture
  entrypoints, and Course includes a deterministic assignment fixture in
  addition to the lecture fixture.
- `pkb module test course` passes the complete deterministic business suite:
  lecture and assignment creation, idempotency, ambiguous-input safety,
  permission and resource gates, Prompt contract, scheduled weekly summary,
  event publication, PDF partial policy, pause, resume, and archive.

## Dynamic acceptance on Windows

The fixture run reaches the archived lifecycle state after executing its
lecture, assignment, ambiguity, resource, periodic-summary, event, PDF-policy,
pause, resume, and archive paths. The runner now uses non-retrying cleanup for
its disposable Vault: a briefly locked SQLite handle may leave a harmless temp
directory for the operating system to reclaim, but it no longer hides the
completed acceptance result behind a multi-minute deletion retry.

On the current Windows developer setup the complete run took about 145 seconds
because each isolated workflow crosses the local Python Schema Bridge several
times. This is performance work, not an acceptance failure.
