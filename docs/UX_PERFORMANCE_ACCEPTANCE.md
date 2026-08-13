# UX and Performance Acceptance

Date: 2026-08-13  
Scope: KnowledgeOS personal-beta UX/performance hardening  
Final assessment: **PARTIAL — NOT READY until the required real Obsidian visual pass is completed**

## Baseline

### Code selection

- Repository: `Cccjha0/KnowledgeOS`
- Working branch: `fix/plugin-command-api-smoke`
- Goal-provided known baseline: `91fd3e30833ff688e23a4086e44daafea0ff8ed1` (`fix: validate plugin view dependencies`), 17 commits ahead of `main` when the goal was authored.
- Baseline selected after fetching and comparing remote ancestry: `d15c26da898dcc939dd0a53bdd9789a8130cfbe4` (`refactor: isolate blueprint approval contracts`). It contains the goal-provided baseline and was 18 ahead / 0 behind `origin/main` at selection.
- Original acceptance implementation HEAD before this document: `1a38fe44cfd9fd1ce705924c2abad737cca25c5a`.
- Integration update: after PR #12 merged the earlier branch work, these four remaining commits were rebased without conflict onto `origin/main` at `62184bc`. The rebased implementation commit is `08b7a5c`; this document follows it on the same branch.
- Remote branches were ordered by commit time and checked for ancestry/containment; `main` was not assumed to be newest.

### Environment and fixtures

- Measured host: Windows `10.0.26200` x64, Node `v22.11.0`, Python `3.13.11`.
- Method: one warm-up, five measured repetitions per cold and warm path; median, p95, min and max recorded. Cold samples use separate Node processes. Response content is not logged.
- Deterministic synthetic fixtures contain no user content and carry a deletion-safety marker.

| Scale | Modules | Instances | Records | Inbox | Reviews | Runs | Tasks | Quality |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Small | 3 | 3 | 50 | 10 | 10 | 100 | 100 | 20 |
| Medium | 3 | 10 | 1,000 | 200 | 200 | 3,000 | 3,000 | 1,000 |
| Large | 3 | 30 | 10,000 | 1,000 | 1,000 | 20,000 | 10,000 | 3,000 |

The committed raw reports are in `docs/benchmarks/`. Report `commit_sha` identifies the code at benchmark start; reports generated immediately before their corresponding commit therefore identify the parent commit.

### Representative final measurements

| Scenario | Scale | Cold median / p95 | Warm median / p95 | Warm response | Warm Python / discovered / parsed / schema |
| --- | --- | ---: | ---: | ---: | ---: |
| API server start | Large | 1,027 / 1,050 ms | n/a | n/a | n/a |
| `getModules` | Large | 2,214 / 2,252 ms | 40 / 41 ms | 5.7 KB | 0 / 0 / 0 / 0 |
| `getInstances` | Large | 729 / 748 ms | 15 / 15 ms | 11.3 KB | 0 / 0 / 0 / 0 |
| Today | Small | 4,164 / 4,212 ms | 177 / 184 ms | 52.4 KB | 1 / 180 / 0 / 127 |
| Today | Medium | 8,559 / 12,007 ms | 667 / 915 ms | 124.7 KB | 2.2 / 1,600 / 40 / 3,211 |
| Today | Large | 27,523 / 53,148 ms | 2,426 / 2,588 ms | 139.6 KB | 4.2 / 13,000 / 10 / 11,514 |
| Inbox first page | Large | 2,552 / 3,773 ms | 256 / 260 ms | 101.3 KB | 1 / 1,000 / 0 / 0 |
| Review first page | Large | 5,476 / 7,782 ms | 206 / 212 ms | 49.9 KB | 1 / 1,000 / 0 / 50 |
| System overview | Large | 4,186 / 4,481 ms | 674 / 694 ms | 33.0 KB | 4 / 2,000 / 0 / 5 |
| System tasks | Large | 366 / 369 ms | 261 / 265 ms | 50.2 KB | 1 / 0 / 0 / 0 |
| System history | Large | 92 / 94 ms | 81 / 83 ms | 17.4 KB | 1 / 0 / 0 / 0 |
| Recent Runs | Large | 90 / 98 ms | 82 / 85 ms | 8.8 KB | 1 / 0 / 0 / 0 |

## Completed Before This Goal

The selected baseline already contained these results; they are verified prerequisites, not claimed as this goal's before/after gains:

- persistent Core API server;
- separate UI and background task clients;
- no automatic mutation resubmission after UI timeout;
- Markdown/YAML in-process LRU cache;
- Inbox batch Markdown parsing;
- single `todayData()` runtime bridge;
- serialized Today Markdown writes and no rewrite for semantically unchanged content;
- cross-process runtime database restore coordination;
- stale-while-revalidate foundations for Today, Inbox, Review and System;
- section loading/cache in System Center;
- targeted Vault-path invalidation;
- plugin bundle build, load smoke test and ESLint;
- explicit rollback-modal dependency injection.

## Findings

### F1 — Registry-specific clean install (`high`)

- Journey: first install and CI.
- Root cause/evidence: lockfile artifacts referenced a regional mirror and made reproducibility dependent on local registry state.
- Fix: regenerate portable lock metadata, document the official registry path, and add an uncached clean-install CI job.
- Verification: clean temporary npm cache plus `npm ci --registry=https://registry.npmjs.org`; clean Python virtual environment plus `pip install --no-cache-dir -r requirements.txt` passed during this goal.
- Rejected: relying on an existing npm cache or treating sandbox/network permission errors as repository failures.
- Safety: dependency versions remain lockfile-controlled; no vendored cache or credentials were committed.

### F2 — Per-document parsing and schema subprocess growth (`critical`)

- Journey: Today, Review, module dashboards and discovery.
- Root cause/evidence: hot paths repeatedly parsed Markdown and validated individual objects through Python. Medium Today was 8,306 ms warm p95 with 4,600 Markdown files parsed and a 1.10 MB response.
- Fix: batch parsing/validation, content-and-schema-revision validation cache, shared discovery, and bounded dashboard snapshots.
- Result: Medium Today is 915 ms warm p95, 40 files parsed and 124.7 KB. Small Today fell from 890 to 184 ms p95 after schema-result caching.
- Rejected: removing runtime schema validation or increasing request timeouts.
- Safety: Draft 2020-12/registry validation remains active; invalid items remain excluded and surfaced as a visible diagnostic.

### F3 — Fake pagination and linear history reads (`high`)

- Journey: Inbox, Review, Task Center and Run History.
- Root cause/evidence: callers requested pages but some Core paths built complete collections first; recent-run cost grew with the Logs tree.
- Fix: stable SQLite-backed cursor pages for Inbox/Review/Tasks/Runs, global aggregate counts, rebuildable Markdown-derived summary indexes, and safe rebuild fallback.
- Result: Large Inbox 260 ms, Review 212 ms, Tasks 265 ms and Recent Runs 85 ms warm p95; first-page responses are bounded.
- Rejected: returning full arrays and slicing in the plugin.
- Safety: Markdown remains the Inbox/Review/Run audit source; SQLite indexes are deletable and rebuildable, and cursors contain only ordering metadata.

### F4 — Full runtime snapshots in System Overview (`critical`)

- Journey: opening System Center.
- Root cause/evidence: Large overview loaded 10,000 Tasks and 3,000 Quality Issues, parsed 3,000 Markdown files, returned 3.10 MB, and reached 91.4 seconds warm p95.
- Fix: a dedicated SQLite aggregate returns runtime counts, quality counts and five attention tasks; Overview independently requests five Inbox items, five Review items with a global count, and one Run.
- Result: Large warm p95 694 ms, 33 KB, zero Markdown bodies parsed.
- Rejected: reusing the full `system-center-data` result or hiding the delay behind a longer timeout.
- Safety: no Task/Quality write semantics changed; the detailed sections retain their dedicated projections.

### F5 — Repeated plugin reads and stale response races (`high`)

- Journey: rapid filters, section changes, manual refresh and Vault events.
- Fix/evidence: canonical read keys share an in-flight promise; generation gates prevent older results from replacing newer UI state; affected-domain invalidation coalesces events. Smoke tests cover deduplication, cleanup, out-of-order results, client restart and unload.
- Rejected: caching mutations or cancelling a potentially completing Core mutation.
- Safety: mutation idempotency and completion tracking remain separate from read deduplication.

### F6 — Fixed background polling (`medium`)

- Journey: idle Obsidian and due/recovery work.
- Fix/evidence: Core supplies next-wake information and the plugin uses bounded timers plus event wakeups. The former benchmark label `taskCycle-idle` was corrected because its synthetic fixture contained resource-wait work; an isolated local wake-policy test completes 10,000 calculations within the 250 ms budget without a Core call.
- Accepted limitation: an end-to-end truly idle CPU/process benchmark is not yet present in the JSON harness.
- Safety: startup recovery, catch-up, retries and resource recovery are retained.

### F7 — First-use and temporal ambiguity (`medium`)

- Journey: setup, scheduling, defer dates and timestamps.
- Fix: read-only Setup Doctor with Ready/Needs action/Failed states and mutation warnings; Vault presentation timezone plus instance override; UI locale follows the environment; UTC, Shanghai, DST and midnight behavior are tested.
- Rejected: hard-coded `zh-CN`/`Asia/Shanghai`, silent Vault repair, or conflating scheduler and presentation timezones.
- Safety: Setup Doctor does not mutate the Vault.

## Before / After

| Journey | Before | After | Assessment |
| --- | --- | --- | --- |
| Small Today warm | 890 ms p95, 2 Python/request | 184 ms, 1 Python/request | PASS (`<=500 ms`) |
| Medium Today warm | 8,306 ms, 1.10 MB, 4,600 parsed | 915 ms, 124.7 KB, 40 parsed | PASS (`<=1 s`) |
| Large Today warm | 23,113 ms, 8,600 parsed in the gap report | 2,588 ms, 10 parsed | Structural PASS; no explicit Large latency budget |
| Medium Inbox first page | 171 ms | 171 ms, truly bounded | PASS (`<=1.5 s`) |
| Medium Review first page | 140 ms | 140 ms, truly bounded | PASS (`<=1.5 s`) |
| Large System overview | 91,413 ms, 3.10 MB, 3,000 parsed | 694 ms, 33 KB, 0 parsed | PASS (`<=1 s`) |
| 3,000-run Recent Runs | 87 ms p95 | 87 ms and index-backed | PASS (`<=200 ms`) |
| Large 20,000-run Recent Runs | linear scan risk | 85 ms p95, 0 files discovered | PASS |
| Background cycle | periodic full resource-wait cycle 4.55 s | idle scheduling is local; due work dynamically wakes | PARTIAL: no end-to-end idle JSON benchmark |
| Clean install | regional registry dependency | official registry + isolated npm/pip caches | PASS |

The Large Today warm path still performs metadata revision checks for 13,000 files and cache lookups for 11,514 schema validations. It no longer parses all bodies or returns unbounded data, but this is the largest remaining scale-sensitive page cost.

## Performance Budget Result

| Budget | Evidence | Result |
| --- | --- | --- |
| shell/skeleton `<=100 ms` | synchronous shell/skeleton implementation exists; no real Obsidian timing | NOT VERIFIED |
| warm `getModules <=200 ms` | Large 41 ms p95 | PASS |
| Small Today `<=500 ms` | 184 ms p95 | PASS |
| Medium Today `<=1 s` | 915 ms p95 | PASS |
| Medium Inbox/Review `<=1.5 s` | 171 / 140 ms p95 | PASS |
| System overview `<=1 s` | Large 694 ms p95 | PASS |
| latest 20 of 3,000 Runs `<=200 ms` | 87 ms p95 | PASS |
| 50-item UI render `<=100 ms` | no real Obsidian DOM timing/node-count result | NOT VERIFIED |
| idle wake `<=250 ms` | isolated local policy test passes; end-to-end idle harness absent | PARTIAL |
| identical concurrent read performs one Core request | plugin smoke test | PASS |

## UX State Matrix

Legend: A = automated pass, M = manual visual pass, N = not verified, n/a = not applicable to that journey.

| Journey | Loading | Success | Empty | Partial | Stale | Running | Failed | Recovery |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Today | A | A | A | A | A | n/a | A | A |
| Inbox | A | A | A | A | A | A | A | A |
| Review | A | A | A | A | A | A | A | A |
| System | A | A | A | A | A | A | A | A |
| Quick Capture | A | A | A | n/a | n/a | A | A | A |
| Module Builder | A | A | A | A | A | A | A | A |
| Settings / Setup Doctor | A | A | n/a | A | n/a | n/a | A | A |

Automated coverage includes skeletons, stale preservation, partial normalization, recoverable errors, mutation completion/failure, out-of-order responses, repeated reads, plugin unload, pagination mechanics, ARIA tab/tabpanel contracts and locale-aware time. It does **not** prove visual layout.

Manual visual pass: **blocked / not performed**. Windows Computer Use was initialized and the installed/running app list inspected, but Obsidian was not installed or exposed as a targetable app. Consequently light/dark themes, narrow sidebar overflow, keyboard/focus restoration, reduced motion, real scroll preservation, DOM node counts and real render timing remain unverified.

## Compatibility and Safety

- Old Vaults: existing Markdown remains authoritative; indexes rebuild from it. Existing method defaults remain available alongside page parameters.
- Command API: plugin access remains exclusively through Command API v1. No plugin direct read/write of managed business state was introduced.
- Windows/Ubuntu and versions: CI defines all eight Ubuntu/Windows × Node 20/22 × Python 3.11/3.13 combinations. This local acceptance run directly verified Windows + Node 22 + Python 3.13 only; the other seven combinations require CI and are not claimed as locally passed.
- Offline: normal Markdown access and deterministic writes remain usable without AI/network. Resource-gated tasks wait and wake without duplicate submission.
- Privacy: synthetic fixtures contain no user content; benchmark reports contain counts/timings only. Task payload sensitive-field checks and context isolation remain intact.
- Provenance/review/rollback: Markdown Run Logs, review gates, operation plans, Git snapshots and rollback assessment remain unchanged or covered by targeted tests.
- Module boundary: Core boundary audit passed; no module-specific business branch was added to Core/Platform.
- SQLite: used for runtime state and rebuildable summaries only, never as the sole source for user knowledge.

## Verification Record

Passed in this workspace:

- isolated clean `npm ci` using the official registry and a fresh cache;
- isolated Python virtual environment dependency install with `--no-cache-dir`;
- `npm run check:boundaries`;
- `npm run lint` (source format, plugin ESLint, TypeScript typecheck);
- `npm run build`;
- `python -X utf8 tools/validate.py` (all module manifests and versioned examples; optional local Vault fixture skipped by the validator);
- plugin bundle build and 20/20 smoke tests;
- affected Today suites: 6/6;
- affected System Center/runtime suites: 14/14;
- built-in application-tracker, experience-log and reading-log validation and executable contract tests (all PASS; application-tracker retains non-critical documented-only-step warnings);
- Small/Medium/Large performance benchmarks;
- `git diff --check`.

Not executed locally:

- the full Engine suite. Repository `AGENTS.md` requires affected tests rather than a full-suite run after each code-modification round; CI remains responsible for the full suite;
- the seven non-local OS/runtime matrix combinations;
- authenticated Codex context-isolation integration;
- real Obsidian manual visual validation.

Initial sandbox `spawn EPERM` failures were execution-environment permission failures. The identical approved commands passed outside the sandbox; they are not repository failures.

## Remaining Work

### Resolved

- clean-install registry portability;
- deterministic benchmark fixtures and diagnostics;
- batch Markdown/schema hot paths;
- bounded Today, Inbox, Review, Task and Run projections;
- rebuildable recent-run index;
- read deduplication/latest-wins behavior;
- demand-driven wake and precise invalidation;
- mutation completion tracking;
- Setup Doctor and locale/timezone correctness;
- Large System overview full-snapshot regression.

### Accepted limitations

- cold Large Today remains expensive because a new process must reconstruct safe caches and indexes;
- warm Large Today still performs O(file-count) metadata revision checks, although body parsing and response size are bounded;
- first index construction is intentionally more expensive and recoverable from Markdown.

### Deferred

- replace full-tree revision hashing with an incrementally maintained, recoverable change journal if Large Today metadata checks become a practical issue;
- add an end-to-end truly idle task-cycle benchmark with CPU time and punctual due-task assertions;
- add a browser-like Obsidian harness for DOM node counts and 50-item render p95.

### Blocked / manual validation required

- install/open Obsidian with the packaged plugin and perform the required light/dark, narrow/wide, keyboard, focus, reduced-motion and scroll-preservation pass;
- run/observe the current CI matrix on the final commit.

## Final Result

- Clean Install: **PASS**
- Performance: **PARTIAL** — all measured backend latency targets pass; real UI render/skeleton timing and end-to-end idle cost are not fully measured.
- UX States: **PARTIAL** — automated state coverage passes; mandatory real Obsidian visual validation is blocked.
- Architecture Safety: **PASS**
- Personal Beta Readiness: **NOT READY** — the code and backend budgets are suitable for a beta candidate, but the goal's required real Obsidian visual pass and final CI matrix evidence are still outstanding.

This conclusion deliberately does not convert smoke tests, CI configuration, or absent tooling into a visual or cross-platform PASS.
