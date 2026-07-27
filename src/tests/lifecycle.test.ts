import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseYaml } from "../core/bridge.js";
import { exists, readJson } from "../core/files.js";
import type { JsonObject } from "../core/types.js";
import { initializeVault } from "../core/vault.js";
import { invokeCommandApi } from "../platform/commandApi.js";
import { syncInstalledConfiguration } from "../platform/configuration.js";

test("module lifecycle previews impact, requires disable confirmation, and survives configuration sync", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-module-life-"));
  try {
    await initializeVault(vault, "disabled");
    const moduleInbox = path.join(vault, "20-Workspace", "Experience Log", "Inbox");
    await fs.mkdir(moduleInbox, { recursive: true });
    await fs.writeFile(path.join(moduleInbox, "pending.md"), "pending", "utf8");
    const beforeToday = await invokeCommandApi({ vaultRoot: vault, requestId: "MOD-TODAY-BEFORE", method: "getTodayItems", params: { refresh_markdown: false } });
    assert.equal(((beforeToday.data as JsonObject).counts as JsonObject).inbox, 1);
    const validation = await invokeCommandApi({ vaultRoot: vault, requestId: "MOD-VALIDATE", method: "manageModule", params: { module_id: "experience-log", action: "validate" } });
    assert.equal(validation.ok, true);
    assert.equal((validation.data as JsonObject).status, "valid");

    const preview = await invokeCommandApi({ vaultRoot: vault, requestId: "MOD-PREVIEW", method: "manageModule", params: { module_id: "experience-log", action: "disable", preview_only: true } });
    assert.equal(preview.ok, true);
    assert.equal((preview.data as JsonObject).requires_confirmation, true);
    assert.equal(((preview.data as JsonObject).impact as JsonObject).inbox_count, 1);
    const refused = await invokeCommandApi({ vaultRoot: vault, requestId: "MOD-REFUSE", method: "manageModule", params: { module_id: "experience-log", action: "disable" } });
    assert.equal(refused.ok, false);
    assert.equal(refused.error?.code, "MODULE_CONFIRMATION_REQUIRED");

    const disabled = await invokeCommandApi({ vaultRoot: vault, requestId: "MOD-DISABLE", method: "manageModule", params: { module_id: "experience-log", action: "disable", confirm: true } });
    assert.equal(disabled.ok, true);
    const modules = await invokeCommandApi({ vaultRoot: vault, requestId: "MOD-LIST", method: "getModules", params: {} });
    assert.equal((modules.data as JsonObject[]).find((item) => item.id === "experience-log")?.status, "disabled");
    const afterToday = await invokeCommandApi({ vaultRoot: vault, requestId: "MOD-TODAY-AFTER", method: "getTodayItems", params: { refresh_markdown: false } });
    assert.equal(((afterToday.data as JsonObject).counts as JsonObject).inbox, 0);
    const capture = await invokeCommandApi({ vaultRoot: vault, requestId: "MOD-CAPTURE", method: "createCapture", params: { preview_only: true, module_id: "experience-log" } });
    assert.equal(capture.ok, false);

    await syncInstalledConfiguration(vault);
    const installed = await readJson<{ modules: Array<{ id: string; status: string }> }>(path.join(vault, "90-System", "Modules", "installed.json"), { modules: [] });
    assert.equal(installed.modules.find((item) => item.id === "experience-log")?.status, "disabled");
    const enabled = await invokeCommandApi({ vaultRoot: vault, requestId: "MOD-ENABLE", method: "manageModule", params: { module_id: "experience-log", action: "enable" } });
    assert.equal(enabled.ok, true);
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("instance wizard creates validated data and lifecycle retains Inbox content", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-instance-life-"));
  try {
    await initializeVault(vault, "disabled");
    const applicationPreview = await invokeCommandApi({
      vaultRoot: vault, requestId: "INS-APP-PREVIEW", method: "createInstance",
      params: {
        module_id: "application-tracker", instance_id: "applications-2027", display_name: "Applications 2027", preview_only: true,
        fields: { application_type: "masters", region: "Australia", intake: "2027", default_currency: "AUD", "monitoring.enabled": true, "monitoring.default_check_interval_days": 30 },
      },
    });
    assert.equal(applicationPreview.ok, true);
    assert.equal((((applicationPreview.data as JsonObject).fields as JsonObject).monitoring as JsonObject).default_check_interval_days, 30);
    const params = {
      module_id: "experience-log", instance_id: "intern-2026", display_name: "2026 Internship",
      fields: { organization: "Example Org", role: "Engineer", start_date: "2026-07-01", end_date: null, timezone: "Asia/Shanghai" },
    };
    const preview = await invokeCommandApi({ vaultRoot: vault, requestId: "INS-PREVIEW", method: "createInstance", params: { ...params, preview_only: true } });
    assert.equal(preview.ok, true);
    assert.equal(await exists(path.join(vault, "90-System", "Instances", "intern-2026", "instance.yaml")), false);
    const created = await invokeCommandApi({ vaultRoot: vault, requestId: "INS-CREATE", method: "createInstance", params });
    assert.equal(created.ok, true);
    const instancePath = path.join(vault, "90-System", "Instances", "intern-2026", "instance.yaml");
    const instance = parseYaml(vault, instancePath);
    assert.equal(instance.status, "active");
    assert.equal(instance.organization, "Example Org");
    const inbox = path.join(vault, "20-Workspace", "Experience Log", "intern-2026", "Inbox");
    assert.equal((await fs.stat(inbox)).isDirectory(), true);
    await fs.writeFile(path.join(inbox, "unprocessed.md"), "pending", "utf8");
    const activeToday = await invokeCommandApi({ vaultRoot: vault, requestId: "INS-TODAY-ACTIVE", method: "getTodayItems", params: { refresh_markdown: false } });
    assert.equal(Number(((activeToday.data as JsonObject).counts as JsonObject).inbox) > 0, true);

    const paused = await invokeCommandApi({ vaultRoot: vault, requestId: "INS-PAUSE", method: "manageInstance", params: { instance_id: "intern-2026", action: "pause" } });
    assert.equal(paused.ok, true);
    assert.equal(parseYaml(vault, instancePath).status, "paused");
    const pausedToday = await invokeCommandApi({ vaultRoot: vault, requestId: "INS-TODAY-PAUSED", method: "getTodayItems", params: { refresh_markdown: false } });
    assert.equal(((pausedToday.data as JsonObject).counts as JsonObject).inbox, 0);
    const captureWhilePaused = await invokeCommandApi({ vaultRoot: vault, requestId: "INS-CAPTURE-PAUSED", method: "createCapture", params: { preview_only: true, instance_id: "intern-2026" } });
    assert.equal(captureWhilePaused.ok, false);

    const resumed = await invokeCommandApi({ vaultRoot: vault, requestId: "INS-RESUME", method: "manageInstance", params: { instance_id: "intern-2026", action: "resume" } });
    assert.equal(resumed.ok, true);
    const archivePreview = await invokeCommandApi({ vaultRoot: vault, requestId: "INS-ARCHIVE-PREVIEW", method: "manageInstance", params: { instance_id: "intern-2026", action: "archive", preview_only: true } });
    assert.equal((archivePreview.data as JsonObject).requires_confirmation, true);
    const refused = await invokeCommandApi({ vaultRoot: vault, requestId: "INS-ARCHIVE-REFUSE", method: "manageInstance", params: { instance_id: "intern-2026", action: "archive" } });
    assert.equal(refused.error?.code, "INSTANCE_CONFIRMATION_REQUIRED");
    const archived = await invokeCommandApi({ vaultRoot: vault, requestId: "INS-ARCHIVE", method: "manageInstance", params: { instance_id: "intern-2026", action: "archive", confirm: true } });
    assert.equal(archived.ok, true);
    assert.equal(parseYaml(vault, instancePath).status, "archived");
    assert.equal(await fs.readFile(path.join(inbox, "unprocessed.md"), "utf8"), "pending");

    const duplicate = await invokeCommandApi({ vaultRoot: vault, requestId: "INS-DUPLICATE", method: "createInstance", params });
    assert.equal(duplicate.error?.code, "INSTANCE_EXISTS");
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});
