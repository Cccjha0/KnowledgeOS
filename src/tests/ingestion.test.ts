import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ingestAsset, readCaptureEnvelope } from "../core/ingestion.js";
import { initializeVault } from "../core/vault.js";
import { createInstance } from "../platform/lifecycleWorkflow.js";
import { materializeInboxAiTasks } from "../platform/inboxWorkflow.js";
import { RuntimeRepository } from "../runtime/repository.js";

test("Ingestion Adapters create Core-owned envelopes and sidecars for structured, text, and image inputs", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-ingestion-"));
  try {
    await initializeVault(vault, "disabled");
    await fs.writeFile(path.join(vault, "00-Inbox", "report.json"), JSON.stringify({ title: "Official update", deadline: "2027-05-01" }), "utf8");
    await fs.writeFile(path.join(vault, "00-Inbox", "notes.yaml"), "title: YAML update\nopen: true\n", "utf8");
    await fs.writeFile(path.join(vault, "00-Inbox", "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const json = await ingestAsset(vault, "00-Inbox/report.json");
    const yaml = await ingestAsset(vault, "00-Inbox/notes.yaml");
    const image = await ingestAsset(vault, "00-Inbox/photo.png");
    assert.equal(json.format, "json");
    assert.equal(json.structured_data?.deadline, "2027-05-01");
    assert.equal((await readCaptureEnvelope(vault, json.capture_path)).content_hash, json.content_hash);
    assert.equal(yaml.structured_data?.open, true);
    assert.equal(image.metadata.ocr, "not-run");
    assert.equal(await fs.stat(path.join(vault, "00-Inbox", "report.json")).then(() => true), true, "Ingestion must not modify original assets.");
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("application-tracker materializes an accepted JSON Inbox asset as a module Workflow Task", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-ingestion-task-"));
  try {
    await initializeVault(vault, "disabled");
    const instanceId = "applications-json";
    await createInstance(vault, {
      module_id: "application-tracker", instance_id: instanceId, display_name: "Applications JSON",
      fields: { application_type: "masters", region: "Australia", intake: "2027-S1", default_currency: "AUD", "monitoring.enabled": true, "monitoring.default_check_interval_days": 30 },
    });
    const source = path.join(vault, "20-Workspace", "Applications", instanceId, "Inbox", "official-update.json");
    await fs.writeFile(source, JSON.stringify({ institution: "Monash University", program_name: "Master of Artificial Intelligence" }), "utf8");
    const materialized = await materializeInboxAiTasks(vault);
    assert.equal(materialized.created.length, 1);
    const repository = await RuntimeRepository.open(vault);
    const task = repository.getTask(materialized.created[0]!);
    const ingestion = task?.payload.ingestion as { capture_path?: string; sidecar_path?: string; format?: string };
    assert.equal(ingestion.format, "json");
    assert.equal(typeof ingestion.capture_path, "string");
    assert.equal(typeof ingestion.sidecar_path, "string");
    repository.close();
    assert.equal((await readCaptureEnvelope(vault, ingestion.capture_path!)).source_path.endsWith("official-update.json"), true);
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});
