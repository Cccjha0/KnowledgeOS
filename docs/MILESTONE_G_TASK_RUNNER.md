# Milestone G task runner

KnowledgeOS now owns a durable local runtime at `90-System/State/runtime.db`. Job declarations create idempotent Tasks; every execution attempt creates a separate Run. Modules never access SQLite or Worker internals.

## Operation

Obsidian starts reconciliation on layout ready and dispatches up to two tasks every minute. The same runner is available without the plugin:

```powershell
node dist/cli.js runtime startup --vault E:\KnowledgeOS\knowledgeos-vault
node dist/cli.js runtime run-once --vault E:\KnowledgeOS\knowledgeos-vault
node dist/cli.js runtime watch --vault E:\KnowledgeOS\knowledgeos-vault
```

`startup` repairs stale running tasks, requeues due deferrals and available resources, applies schedule catch-up, recovers unfinished Operation Plan transactions, rebuilds Today, then dispatches. `watch` repeats normal schedule and dispatch cycles every minute. A Windows login task may invoke `runtime startup`; local execution cannot run while the computer is powered off.

## First jobs

- Core: daily Today (`latest`), weekly Vault Audit (`latest`), monthly runtime Run-detail cleanup (`latest`).
- application-tracker: daily due Research Request synchronization (`latest`).
- experience-log: per-active-instance Friday summary (`aggregate`, Codex required).

Paused, completed or archived instances and disabled modules stop registering enabled jobs. Outstanding ordinary tasks are cooperatively cancelled; experience completion creates one idempotent final-summary Task.

## Safety and recovery

- SQLite WAL, foreign keys, busy timeout, atomic transitions, unique idempotency keys and database-owned ID counters.
- Heartbeat every 15 seconds; heartbeat loss becomes `interrupted` on startup. Deterministic tasks requeue; uncertain write workflows wait for the user.
- Network, Codex, user and filesystem gates are independent. A blocked resource cannot stop unrelated deterministic work.
- Transient errors use 5/15/45-minute retry delays on the same Task. Resource recovery can wake waiting work early.
- Concurrency keys prevent simultaneous instance/file-class work. Dependencies support `all-success`, `all-finished`, and `any-success`.
- Running cancellation is cooperative. Red-risk payloads always wait for the user. Sensitive document/token fields are rejected from Task payloads.
- Runtime database files are excluded from Git working snapshots but included by Vault backups. Database backups checkpoint WAL before atomic publication.
- Completed/cancelled Run detail is retained for 90 days; failed evidence and Task summaries remain.

## Fault matrix

Automated tests cover persisted restart, database backup/restore, duplicate idempotency keys, resource isolation and wake-up, temporary I/O/Codex-format retry, stale heartbeat recovery, due deferrals, repeated schedule evaluation, catch-up policies, dependency blocking, concurrency locks, lifecycle cancellation, cooperative running cancellation, red-risk gating, Today projection and Task Center actions. Existing production tests cover occupied/changed files, Git snapshot behavior and partial Operation Plan recovery.

## G12 real offline protocol

Automated clock simulation verifies a four-day outage, but the completion definition also requires one real 3–5 day shutdown test:

1. Run `runtime startup`, record Task Center counts and copy `runtime.db` to the normal backup location.
2. Leave the computer/runner off for 3–5 days spanning at least one daily Job and preferably the weekly summary.
3. Start with `runtime startup`; export the JSON output.
4. Verify Today has one latest rebuild, application check has one Task, experience windows are aggregated, and no idempotency key appears twice.
5. Confirm deterministic tasks complete while Codex/network work waits independently, then restore each resource and confirm the same Tasks requeue.

Do not mark G12 complete until this physical-time test has actually been observed.
