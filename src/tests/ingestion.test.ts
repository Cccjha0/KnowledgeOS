import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ingestAsset, pdfExtractionIsUsable, pdfExtractionStatus, readCaptureEnvelope } from "../core/ingestion.js";
import { initializeVault } from "../core/vault.js";
import { createInstance } from "../platform/lifecycleWorkflow.js";
import { materializeInboxAiTasks } from "../platform/inboxWorkflow.js";
import { RuntimeRepository } from "../runtime/repository.js";
import { dispatchOnce } from "../runtime/dispatcher.js";

function makePdf(text: string): Buffer {
  const stream = text ? `BT\n/F1 18 Tf\n72 720 Td\n(${text.replace(/[()\\]/g, "\\$&")}) Tj\nET\n` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n%\xFF\xFF\xFF\xFF\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "binary"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, "binary");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "binary");
}

function makeBlankPdf(): Buffer {
  return makePdf("");
}

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

test("binary asset Sidecars retain a user-set Read Level across repeat ingestion", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-ingestion-read-level-"));
  try {
    await initializeVault(vault, "disabled");
    const source = path.join(vault, "00-Inbox", "private.txt");
    await fs.writeFile(source, "Private attachment text", "utf8");
    const first = await ingestAsset(vault, "00-Inbox/private.txt", { readLevel: 3 });
    assert.equal(first.read_level, 3);
    const repeated = await ingestAsset(vault, "00-Inbox/private.txt");
    assert.equal(repeated.read_level, 3);
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

test("PDF ingestion preserves page-level text evidence and safely classifies scanned, encrypted, and corrupted assets", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-ingestion-pdf-"));
  try {
    await initializeVault(vault, "disabled");
    const inbox = path.join(vault, "00-Inbox");
    const textPath = path.join(inbox, "official-update.pdf");
    const scannedPath = path.join(inbox, "scanned.pdf");
    const encryptedPath = path.join(inbox, "encrypted.pdf");
    const corruptedPath = path.join(inbox, "corrupted.pdf");
    await fs.writeFile(textPath, makePdf("English requirements: IELTS 6.5"));
    await fs.writeFile(scannedPath, makeBlankPdf());
    await fs.writeFile(corruptedPath, "not a PDF", "utf8");
    const encrypted = spawnSync("python", ["-c", "import sys; from pypdf import PdfReader, PdfWriter; r=PdfReader(sys.argv[1]); w=PdfWriter(); [w.add_page(p) for p in r.pages]; w.encrypt('secret'); w.write(sys.argv[2])", textPath, encryptedPath], { encoding: "utf8", windowsHide: true });
    assert.equal(encrypted.status, 0, encrypted.stderr);

    const text = await ingestAsset(vault, "00-Inbox/official-update.pdf");
    const scanned = await ingestAsset(vault, "00-Inbox/scanned.pdf");
    const encryptedEnvelope = await ingestAsset(vault, "00-Inbox/encrypted.pdf");
    const corrupted = await ingestAsset(vault, "00-Inbox/corrupted.pdf");
    const extraction = text.metadata.extraction as { status?: string; page_text?: Array<{ page: number; text: string }>; text_pages?: number };
    assert.equal(extraction.status, "completed");
    assert.equal(extraction.page_text?.[0]?.page, 1);
    assert.match(extraction.page_text?.[0]?.text ?? "", /IELTS 6\.5/);
    assert.match(text.extracted_text, /--- Page 1 ---/);
    assert.equal(pdfExtractionIsUsable(text), true);
    assert.equal(pdfExtractionStatus(scanned), "scanned");
    assert.equal(pdfExtractionIsUsable(scanned), false);
    assert.equal(pdfExtractionStatus(encryptedEnvelope), "encrypted");
    assert.equal(pdfExtractionStatus(corrupted), "corrupted");
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("unreadable PDFs enter waiting-for-user and never reach the Codex workflow", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-ingestion-pdf-waiting-"));
  try {
    await initializeVault(vault, "disabled");
    const instanceId = "applications-pdf";
    await createInstance(vault, {
      module_id: "application-tracker", instance_id: instanceId, display_name: "Applications PDF",
      fields: { application_type: "masters", region: "Australia", intake: "2027-S1", default_currency: "AUD", "monitoring.enabled": true, "monitoring.default_check_interval_days": 30 },
    });
    const source = path.join(vault, "20-Workspace", "Applications", instanceId, "Inbox", "scanned-update.pdf");
    await fs.writeFile(source, makeBlankPdf());
    const materialized = await materializeInboxAiTasks(vault);
    const repository = await RuntimeRepository.open(vault);
    const task = repository.getTask(materialized.created[0]!);
    assert.equal(task?.resources.user, "required");
    assert.equal(task?.resources.codex, "not-required");
    repository.close();
    const dispatched = await dispatchOnce({ vaultRoot: vault, limit: 1 });
    assert.equal(dispatched.tasks[0]?.status, "waiting-for-user");
    const after = await RuntimeRepository.open(vault);
    assert.equal(after.getRuns(task!.task_id).length, 0, "the resource gate must stop before a Codex run starts");
    after.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});
