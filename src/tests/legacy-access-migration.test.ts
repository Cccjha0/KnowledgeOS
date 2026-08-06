import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseMarkdown } from "../core/bridge.js";
import { fromVaultPath, writeJsonAtomic } from "../core/files.js";
import { ingestAsset } from "../core/ingestion.js";
import { applyLegacyAccessPolicyMigration, legacyAccessPolicyMigrationSummary, previewLegacyAccessPolicyMigration, rollbackLegacyAccessPolicyMigration } from "../core/legacyAccessMigration.js";
import { initializeVault } from "../core/vault.js";
import { getQualityDashboard } from "../quality/presentation.js";

test("Legacy Access Policy Migration previews, requires sensitive review, applies, and rolls back", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-legacy-access-"));
  try {
    await initializeVault(vault, "disabled");
    const ordinary = path.join(vault, "20-Workspace", "Notes", "legacy.md");
    const privateNote = path.join(vault, "20-Workspace", "Journal", "legacy.md");
    await fs.mkdir(path.dirname(ordinary), { recursive: true }); await fs.mkdir(path.dirname(privateNote), { recursive: true });
    await fs.writeFile(ordinary, "---\nread_level: 2\n---\n\nOrdinary legacy note.\n", "utf8");
    await fs.writeFile(privateNote, "---\nread_level: 0\n---\n\nPrivate legacy note.\n", "utf8");
    await fs.writeFile(path.join(vault, "00-Inbox", "legacy.txt"), "legacy attachment", "utf8");
    const asset = await ingestAsset(vault, "00-Inbox/legacy.txt", { sensitivityClass: 1, maxRepresentation: "full" });
    const raw = JSON.parse(await fs.readFile(fromVaultPath(vault, asset.sidecar_path), "utf8"));
    delete raw.sensitivity_class; delete raw.classification_state; delete raw.access_policy; raw.read_level = 1; raw.policy_source = "legacy"; raw.legacy_read_level = 1;
    await writeJsonAtomic(fromVaultPath(vault, asset.sidecar_path), raw);

    const preview = await previewLegacyAccessPolicyMigration(vault) as { migration_id: string; candidates: Array<{ path: string; requires_review: boolean; proposed: { sensitivity_class: number; access_policy: { max_representation: string } } }> };
    assert.equal(preview.candidates.length, 3);
    const sensitive = preview.candidates.find((candidate) => candidate.path.endsWith("Journal/legacy.md"))!;
    assert.equal(sensitive.requires_review, true);
    assert.equal(sensitive.proposed.sensitivity_class, 3);
    assert.equal(sensitive.proposed.access_policy.max_representation, "metadata");
    const dashboard = await getQualityDashboard(vault);
    assert.equal((((dashboard.schemas_migrations as { legacy_access_policy: { remaining: number } }).legacy_access_policy).remaining), 3);
    await assert.rejects(() => applyLegacyAccessPolicyMigration(vault, { action: "apply", preview_id: preview.migration_id, confirm: true }), (error: unknown) => (error as { code?: string }).code === "LEGACY_ACCESS_MIGRATION_REVIEW_REQUIRED");

    const applied = await applyLegacyAccessPolicyMigration(vault, { action: "apply", preview_id: preview.migration_id, confirm: true, reviewed_paths: [sensitive.path] });
    assert.equal(applied.status, "applied");
    assert.equal((await legacyAccessPolicyMigrationSummary(vault)).remaining, 0);
    const migratedOrdinary = parseMarkdown(vault, ordinary).data;
    const migratedPrivate = parseMarkdown(vault, privateNote).data;
    assert.equal("read_level" in migratedOrdinary, false);
    assert.equal((migratedOrdinary.access_policy as { max_representation: string }).max_representation, "summary");
    assert.equal(migratedPrivate.sensitivity_class, 3);
    assert.equal((migratedPrivate.access_policy as { max_representation: string }).max_representation, "metadata");
    const migratedSidecar = JSON.parse(await fs.readFile(fromVaultPath(vault, asset.sidecar_path), "utf8"));
    assert.equal(migratedSidecar.read_level, undefined);
    assert.equal(migratedSidecar.legacy_read_level, null);

    const rolledBack = await rollbackLegacyAccessPolicyMigration(vault, preview.migration_id, true);
    assert.equal(rolledBack.status, "rolled-back");
    assert.equal((await legacyAccessPolicyMigrationSummary(vault)).remaining, 3);
    assert.equal(parseMarkdown(vault, ordinary).data.read_level, 2);
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});
