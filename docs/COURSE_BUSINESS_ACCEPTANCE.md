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

## Remaining dynamic acceptance blocker

On the current Windows development environment, `pkb module test course`
progresses through the lecture, assignment, and ambiguity paths but does not
finish its later lifecycle stages before the local command timeout. This is
recorded as **incomplete**, not a passing dynamic acceptance result. The next
maintenance task is to instrument the module test runner with per-scenario
timeouts/progress so that the exact lifecycle stage and retained temporary
Vault evidence are reported without leaving an opaque hanging command.
