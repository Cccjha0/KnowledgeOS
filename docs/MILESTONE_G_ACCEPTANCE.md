# Milestone G acceptance matrix

## Implemented and automated

| Stage | Evidence |
|---|---|
| G01 Domain | Separate persisted Job Definition, Task, Run, Resource Status, Dependency and Checkpoint models; fixed state transitions including `waiting-for-ai` and `interrupted`. |
| G02 Persistence | SQLite WAL repository, atomic claims/transitions, unique idempotency keys, integrity check, backup/restore CLI and pre-migration snapshot. |
| G03 Dispatcher | Priority plus aging, deterministic worker handlers, Run history, heartbeat and cooperative checkpoints. |
| G04 Resources | Independent filesystem/network/Codex/user gates; real filesystem and CLI probes; configured service-specific network probe. |
| G05 Scheduler | Daily, weekly, monthly, full five-field Cron and field-due; timezone, checkpoints and bounded catch-up. |
| G06 Startup | Interrupted recovery, due deferrals, resource wake-up, transaction recovery, startup Tasks and schedule compensation. |
| G07 Retry | Error categories, 5/15/45-minute backoff, maximum attempts, manual retry and resource wake-up. |
| G08 Control | `allow`/`forbid`/`replace`/`merge`, database locks, dependencies, cooperative running cancellation and low-priority aging. |
| G09 UX | Task Center Active/Waiting/Scheduled/Failed/History, details, Run/Codex audit, linked files, retry/cancel/defer/priority and manual enqueue; actionable Today projection. |
| G10 Modules | Core, application-tracker and experience-log register standard Jobs; modules do not access runtime.db. |
| G11 Faults | Automated lock, retry, duplicate, stale heartbeat, interrupted transaction, occupied file, Git failure and invalid output coverage. |

## Physical acceptance still requires elapsed time

G12 cannot be truthfully completed by a same-session automated test. Begin and verify a real observation with:

```powershell
node tools/offline_acceptance.mjs start E:\KnowledgeOS\knowledgeos-vault
# Keep the computer or runner off for 3-5 days, then start the runner once.
node dist/cli.js runtime startup --vault E:\KnowledgeOS\knowledgeos-vault
node tools/offline_acceptance.mjs verify E:\KnowledgeOS\knowledgeos-vault
```

The verifier rejects observations shorter than 72 hours, checks SQLite integrity and duplicate idempotency keys, records all newly materialized catch-up Tasks, and writes durable evidence under `90-System/Logs/`. Human sign-off must also confirm the runner was actually offline during the interval.
