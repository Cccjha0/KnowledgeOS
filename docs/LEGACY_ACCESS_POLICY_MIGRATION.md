# Legacy Access Policy Migration

Older Vault data may use one overloaded `read_level` value. KnowledgeOS keeps
that data readable only as a temporary compatibility path. Before enabling a
Journal or any other sensitive-content module, migrate it to the separate
access-policy contract:

```yaml
sensitivity_class: 0 # 0–3 privacy sensitivity
classification_state: classified
access_policy:
  max_representation: metadata | summary | full | sensitive-original
policy_source: explicit
```

## User flow

Open **System Center → Knowledge quality → Data structure → Migrate legacy
access policies**.

1. The first action creates a Preview only; it does not change Vault files.
2. Every candidate shows its path, kind, legacy value and proposed policy.
3. Files below `Journal`, `Private`, `Medical`, `Identity`, `Passport`, `Visa`,
   `Transcript`, `Recommendation`, or `Contract` directories require an
   individual checkbox confirmation. Their proposal is always class 3 with
   metadata-only access.
4. Applying the preview creates a Git snapshot (when Git is enabled), retains
   a raw backup under `90-System/State/Migrations/`, writes a Change Record for
   each migrated policy, and clears the legacy marker.
5. **Undo last migration** restores the raw backup and records the reversal.

The Quality Dashboard shows the cached number of remaining legacy policies.
Opening the migration flow refreshes that count with a new scan. A Sidecar
whose original asset is missing remains visible in the Preview but cannot be
automatically migrated, because recreating its extraction cache would be
unsafe.

The Core command API exposes the same lifecycle as
`migrateLegacyAccessPolicies` with `action: preview | apply | rollback` for
automation and tests. `apply` requires `confirm: true`; sensitive candidates
also require their exact Vault-relative path in `reviewed_paths`.
