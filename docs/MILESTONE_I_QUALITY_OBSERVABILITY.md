# Milestone I — Knowledge Quality and Observability

## Outcome

KnowledgeOS now separates three durable concerns:

- `Quality Issue`: what is wrong with knowledge or system state.
- `Task`: what Core intends to execute.
- `Review Item`: what a user must decide.

Important changes can be explained as `trigger → inputs → decision → risk → review → execution → Change Record`.

## Contracts

The stable public schemas are:

- `provenance-record`: authorship, Evidence IDs, generation, review and verification.
- `evidence-record`: source reference, locator, supported entity/field, authority, freshness and lifecycle status.
- `quality-issue`: detector result, severity, fingerprint, suppression and resolution.
- `change-record`: old/new value and its evidence, generation and review chain.
- `metric-event`: privacy-minimized operational, quality, review and AI telemetry.

Critical application fields use sidecar `_field_meta` so existing scalar/fact values remain compatible. Evidence details are stored once in `runtime.db`; fields only retain Evidence IDs.

## Ownership

Documents may declare `_ownership.sections` and `_ownership.fields` using:

`user-owned`, `ai-managed`, `system-managed`, `source-immutable`, or `mixed`.

Core enforces ownership before an Operation Plan mutates frontmatter or appends a section. AI writes to `mixed` regions require a Review ID. Source-immutable regions cannot be modified by any actor.

## Freshness

The shared engine emits `verified`, `due-soon`, `stale`, `unverifiable`, `historical`, or `unknown`. Interval precedence is field → entity → module → Core. Stale data remains present and is scheduled for verification; it is never cleared automatically.

## Runtime storage

`90-System/State/runtime.db` schema v3 adds:

- `evidence_records`
- `quality_issues`
- `metric_events`
- `change_records`
- `audit_runs`
- `review_memories`

Issue fingerprints prevent duplicate alerts. Review fingerprints and evidence hashes update an existing Review and prevent a rejected suggestion from returning without materially new evidence.

Metric events store IDs, states, versions, categories, counts and timings—not note bodies, mail bodies, credentials or Prompt inputs. Normal cleanup retains detailed metrics for 30–90 days and audit summaries for one year; Change Records, decisions and Evidence remain durable.

## Audits

Core registers daily, weekly and monthly quality jobs. Deterministic auditors cover:

- internal broken links
- missing WikiLink anchors
- external links in a separately network-gated weekly Task
- orphan and unowned files
- exact and near-duplicate content candidates
- missing Critical provenance
- stale/due-soon fields
- invalid entity/frontmatter schemas and entity-specific old schema metadata
- Review SLA debt
- missing content ownership
- inactive-instance tasks
- conflicting or unavailable Evidence
- Prompt schema/rejection threshold regressions

Daily scans remain local and avoid Codex. Weekly/monthly runs create one readable report plus database issues, not one Markdown file per finding. External-link availability remains a separately resource-gated network concern.

## Presentation

System Center exposes Overview, Freshness, Provenance, Reviews, Links & Ownership, Schemas & Migrations, AI Quality and Audit History. Run Details shows the explanation chain. Today includes only Critical/High quality issues and overdue Reviews; ordinary broken links, orphans and low-value findings stay in Quality Dashboard.

## Historical backfill

`backfillQualityMetadata` is preview-first and confirmation-gated. It:

1. limits scope to active instances;
2. prioritizes Critical application fields and required ownership metadata;
3. refuses to invent Evidence for fields without source references;
4. creates a Git snapshot;
5. materializes Evidence and a durable Operation Plan;
6. executes through Core and writes a Run Log.

It performs no whole-Vault AI scan.

## Real observation window (I14)

Every audit updates `90-System/State/quality-observation.json`. It remains `observing` for at least 14 real days and becomes `ready-for-evaluation` only after the minimum window and sufficient sampling coverage. The first gate requires at least seven distinct measured days and two weekly audits. The deterministic preliminary evaluation checks Review debt, missing Critical provenance, stale-field actionability, Prompt anomaly attribution and High/Critical alert volume. A 28-day window is preferred, and the System Center Quality page displays the live gate and each criterion.

The current real observation began at `2026-07-28T16:37:41.141Z`. I01–I13 are implementation-complete; I14 must remain open until at least 14 real days have elapsed.
