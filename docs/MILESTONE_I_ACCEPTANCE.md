# Milestone I Acceptance

## Automated acceptance

- Public Provenance, Evidence, Quality Issue, Change and Metric schemas validate.
- `runtime.db` migrates to v3 with a pre-migration backup and survives reopen.
- Evidence, issue fingerprints, metrics, Change Records, audit history and rejection memory persist.
- Freshness correctly separates due-soon, stale and historical facts.
- Protected content regions reject unauthorized mutations.
- Review approval writes Evidence IDs and field-level provenance.
- Identical Reviews and Quality Issues are deduplicated.
- Rejection memory requires a changed evidence hash before re-proposal.
- Daily/weekly/monthly jobs use the Task Runner and do not block unrelated local work.
- Audits find broken links, missing ownership/provenance, old schemas, stale fields, Review debt and inactive-instance tasks.
- Stale application fields create one idempotent follow-up Task.
- Quality Dashboard supports inspect, acknowledge, suppress and resolve.
- Today excludes ordinary low/medium audit noise.
- Run Details exposes the complete explanation chain.
- Backfill is preview-first, snapshot-backed and active-data-first.

## Manual/temporal acceptance

I14 cannot be truthfully completed in a single implementation session. Keep scheduled audits enabled for 14–28 days, then inspect `quality-observation.json` and weekly reports. Completion requires all of the following:

- Review debt is stable or decreasing.
- Missing-source Critical fields are stable or decreasing.
- Stale fields create useful actions and retain their old values.
- A deliberately bad Prompt/test fixture is attributable to its exact version.
- High/Critical alerts are understandable and not repeated every day.
- Users can explain sampled important changes from Run Details without reading raw logs.

