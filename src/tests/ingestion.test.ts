import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanIngestionArtifacts, countAssetReferences, evidenceLocator, ingestAsset, pdfExtractionDecision, pdfExtractionIsUsable, pdfExtractionStatus, readCaptureEnvelope, readExtractionCache } from "../core/ingestion.js";
import { initializeVault } from "../core/vault.js";
import { runQualityAudit } from "../quality/audit.js";
import { QualityRepository } from "../quality/repository.js";
import { createInstance } from "../platform/lifecycleWorkflow.js";
import { materializeInboxAiTasks } from "../platform/inboxWorkflow.js";
import { discoverInboxItems } from "../platform/inboxDiscovery.js";
import { RuntimeRepository } from "../runtime/repository.js";
import { dispatchOnce } from "../runtime/dispatcher.js";
import { invokeCommandApi } from "../platform/commandApi.js";

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
    assert.equal(json.sensitivity_class, "unknown", "A newly ingested attachment must not inherit the public-document default.");
    assert.equal(json.classification_state, "unclassified");
    assert.equal(json.access_policy.max_representation, "metadata");
    assert.equal((await readExtractionCache(vault, json)).structured_data?.deadline, "2027-05-01");
    assert.equal((await readCaptureEnvelope(vault, json.capture_path)).content_hash, json.content_hash);
    assert.equal((await readExtractionCache(vault, yaml)).structured_data?.open, true);
    assert.equal(image.metadata.ocr, "not-run");
    assert.equal(await fs.stat(path.join(vault, "00-Inbox", "report.json")).then(() => true), true, "Ingestion must not modify original assets.");
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("Asset Metadata Sidecars are validated on write and read", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-sidecar-schema-"));
  try {
    await initializeVault(vault, "disabled");
    await fs.mkdir(path.join(vault, "00-Inbox"), { recursive: true });
    await fs.writeFile(path.join(vault, "00-Inbox", "private.txt"), "fixture", "utf8");
    const asset = await ingestAsset(vault, "00-Inbox/private.txt");
    const sidecar = path.join(vault, ...asset.sidecar_path.split("/"));
    const corrupted = JSON.parse(await fs.readFile(sidecar, "utf8")) as Record<string, unknown>;
    corrupted.classification_state = "unclassified";
    corrupted.sensitivity_class = 2;
    await fs.writeFile(sidecar, JSON.stringify(corrupted), "utf8");
    await assert.rejects(readCaptureEnvelope(vault, asset.sidecar_path), /Schema validation failed/);
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("binary asset Sidecars retain sensitivity and representation policy across repeat ingestion", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-ingestion-read-level-"));
  try {
    await initializeVault(vault, "disabled");
    const source = path.join(vault, "00-Inbox", "private.txt");
    await fs.writeFile(source, "Private attachment text", "utf8");
    const first = await ingestAsset(vault, "00-Inbox/private.txt", { sensitivityClass: 3, maxRepresentation: "sensitive-original" });
    assert.equal(first.sensitivity_class, 3);
    assert.equal(first.access_policy.max_representation, "sensitive-original");
    const repeated = await ingestAsset(vault, "00-Inbox/private.txt");
    assert.equal(repeated.sensitivity_class, 3);
    assert.equal(repeated.access_policy.max_representation, "sensitive-original");
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("attachment access policy changes only through the Core API and mirrors its Companion Note", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-ingestion-policy-"));
  try {
    await initializeVault(vault, "disabled");
    await fs.writeFile(path.join(vault, "00-Inbox", "private.txt"), "Private attachment text", "utf8");
    const asset = await ingestAsset(vault, "00-Inbox/private.txt");
    const response = await invokeCommandApi({ vaultRoot: vault, requestId: "ASSET-POLICY-001", method: "updateAssetAccessPolicy", params: { capture_path: asset.capture_path, sensitivity_class: 3, max_representation: "metadata" } });
    assert.equal(response.ok, true);
    const sidecar = await readCaptureEnvelope(vault, asset.capture_path);
    assert.equal(sidecar.sensitivity_class, 3);
    assert.equal(sidecar.classification_state, "classified");
    assert.equal(sidecar.access_policy.max_representation, "metadata");
    const note = await fs.readFile(path.join(vault, ...asset.companion_note_path.split("/")), "utf8");
    assert.match(note, /sensitivity_class: 3/);
    assert.match(note, /max_representation: metadata/);
    const repository = await QualityRepository.open(vault);
    assert.equal(repository.listChanges(`[[${asset.companion_note_path}]]`).some((change) => change.field === "access_policy"), true);
    repository.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("extraction cache lives under Cache, is re-created after eviction, and partial PDFs require the module policy", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-ingestion-cache-"));
  try {
    await initializeVault(vault, "disabled");
    await fs.writeFile(path.join(vault, "00-Inbox", "official.pdf"), makePdf("Official text"));
    const asset = await ingestAsset(vault, "00-Inbox/official.pdf");
    assert.match(asset.extraction_cache_path, /^90-System\/Cache\/Extractions\//);
    await fs.unlink(path.join(vault, ...asset.extraction_cache_path.split("/")));
    assert.match((await readExtractionCache(vault, asset)).extracted_text, /Official text/);
    const partial = { ...asset, metadata: { ...asset.metadata, extraction: { status: "partial", text_available: true } } };
    assert.equal(pdfExtractionDecision(partial, { accepted_statuses: ["completed"], partial_policy: "review" }).requires_review, true);
    assert.equal(pdfExtractionDecision(partial, { accepted_statuses: ["completed", "partial"], partial_policy: "allow" }).usable, true);
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("asset cleanup tracks user references, expires extraction caches, and removes true orphans", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-ingestion-cleanup-"));
  try {
    await initializeVault(vault, "disabled");
    await fs.writeFile(path.join(vault, "00-Inbox", "asset.txt"), "Attachment", "utf8");
    const asset = await ingestAsset(vault, "00-Inbox/asset.txt");
    await fs.writeFile(path.join(vault, "30-Knowledge", "Reference.md"), `# Reference\n\n${asset.asset_id}\n`, "utf8");
    assert.equal(await countAssetReferences(vault, asset), 1);
    await fs.unlink(path.join(vault, "00-Inbox", "asset.txt"));
    await cleanIngestionArtifacts(vault, { now: new Date(Date.now() + 91 * 86_400_000) });
    assert.equal(await fs.stat(path.join(vault, ...asset.sidecar_path.split("/"))).then(() => true), true, "Referenced metadata remains available.");
    await fs.unlink(path.join(vault, "30-Knowledge", "Reference.md"));
    await fs.unlink(path.join(vault, ...asset.companion_note_path.split("/")));
    await cleanIngestionArtifacts(vault);
    await assert.rejects(fs.access(path.join(vault, ...asset.sidecar_path.split("/"))));
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("Companion Notes are visible asset records, not unowned knowledge files", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-companion-quality-"));
  try {
    await initializeVault(vault, "disabled");
    await fs.writeFile(path.join(vault, "00-Inbox", "asset.txt"), "Attachment", "utf8");
    const asset = await ingestAsset(vault, "00-Inbox/asset.txt");
    await runQualityAudit(vault, "daily", { now: "2026-08-05T00:00:00Z" });
    const repository = await QualityRepository.open(vault); const issues = repository.listIssues(); repository.close();
    assert.equal(issues.some((item) => item.issue_type === "unowned-file" && item.target.path === asset.companion_note_path), false);
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
    const envelope = await readCaptureEnvelope(vault, ingestion.capture_path!);
    assert.equal(envelope.source_path.endsWith("official-update.json"), true);
    assert.equal(envelope.sensitivity_class, 2, "The Application Inbox declares its own explicit attachment policy.");
    assert.equal(envelope.classification_state, "inherited");
    assert.equal(envelope.access_policy.max_representation, "full");
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("application Inbox roles keep Documents metadata-only and outside the generic research workflow", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-ingestion-application-roles-"));
  try {
    await initializeVault(vault, "disabled");
    const instanceId = "applications-role-policy";
    await createInstance(vault, {
      module_id: "application-tracker", instance_id: instanceId, display_name: "Application role policy",
      fields: { application_type: "masters", region: "Australia", intake: "2027-S1", default_currency: "AUD", "monitoring.enabled": true, "monitoring.default_check_interval_days": 30 },
    });
    const inbox = path.join(vault, "20-Workspace", "Applications", instanceId, "Inbox");
    for (const folder of ["Research", "Documents", "Private"]) assert.equal((await fs.stat(path.join(inbox, folder))).isDirectory(), true);
    await fs.writeFile(path.join(inbox, "Research", "official-update.json"), JSON.stringify({ institution: "Monash University" }), "utf8");
    await fs.writeFile(path.join(inbox, "Documents", "transcript.json"), JSON.stringify({ student: "Private user" }), "utf8");
    const materialized = await materializeInboxAiTasks(vault);
    assert.equal(materialized.created.length, 1, "only the Research role may create the generic capture task");
    const repository = await RuntimeRepository.open(vault);
    const researchTask = repository.getTask(materialized.created[0]!);
    assert.equal(researchTask?.payload.asset_role, "research-report");
    repository.close();
    const items = await discoverInboxItems(vault);
    const document = items.find((item) => item.filename === "transcript.json");
    assert.equal(document?.state, "waiting-for-user");
    assert.equal(document?.required_user_action, "resolve-review");
    assert.equal((document?.attachment_classification?.current_policy as { max_representation?: string } | undefined)?.max_representation, "metadata");
    assert.match(document?.error ?? "", /does not permit generic AI processing/);
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("unclassified non-Markdown Inbox attachments wait for user classification before a Codex task can run", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-ingestion-unclassified-waiting-"));
  try {
    await initializeVault(vault, "disabled");
    const instanceId = "internship-private-attachment";
    await createInstance(vault, {
      module_id: "experience-log", instance_id: instanceId, display_name: "Private attachment test",
      fields: { organization: "Example", role: "Intern", start_date: "2026-01-01", end_date: null, timezone: "Asia/Shanghai" },
    });
    const source = path.join(vault, "20-Workspace", "Experience Log", instanceId, "Inbox", "private-export.txt");
    await fs.writeFile(source, "Private chat export that must not be sent to Codex before classification.", "utf8");
    const materialized = await materializeInboxAiTasks(vault);
    const repository = await RuntimeRepository.open(vault);
    const task = repository.getTask(materialized.created[0]!);
    const ingestion = task?.payload.ingestion as { capture_path?: string };
    assert.equal(task?.status, "waiting-for-user");
    assert.equal(task?.resources.user, "required");
    assert.equal(task?.resources.codex, "not-required");
    const envelope = await readCaptureEnvelope(vault, ingestion.capture_path!);
    assert.equal(envelope.classification_state, "unclassified");
    assert.equal(envelope.access_policy.max_representation, "metadata");
    repository.close();

    const inbox = await invokeCommandApi({ vaultRoot: vault, requestId: "INBOX-CLASSIFY-VIEW", method: "getInboxCenterSnapshot", params: {} });
    const inboxData = inbox.data as { inbox?: { items?: Array<{ item_id: string; required_user_action?: string; attachment_classification?: { capture_path?: string; classification_state?: string; requested_representation?: string } }> } };
    const view = (inboxData.inbox?.items ?? [])
      .find((candidate) => candidate.item_id === String(task?.payload.item_id));
    assert.equal(view?.required_user_action, "classify-attachment");
    assert.equal(view?.attachment_classification?.capture_path, ingestion.capture_path);
    assert.equal(view?.attachment_classification?.classification_state, "unclassified");
    assert.equal(view?.attachment_classification?.requested_representation, "full");

    const classified = await invokeCommandApi({
      vaultRoot: vault,
      requestId: "INBOX-CLASSIFY-001",
      method: "classifyInboxAttachment",
      params: { item_id: String(task?.payload.item_id), sensitivity_class: 1, max_representation: "full" },
    });
    assert.equal(classified.ok, true, JSON.stringify(classified.error));
    assert.equal((classified.data as { task_id?: string }).task_id, task?.task_id, "Classification must resume the same business task.");
    const updated = await readCaptureEnvelope(vault, ingestion.capture_path!);
    assert.equal(updated.classification_state, "classified");
    assert.equal(updated.sensitivity_class, 1);
    assert.equal(updated.access_policy.max_representation, "full");
    const repositoryAfter = await RuntimeRepository.open(vault);
    assert.equal(repositoryAfter.getTask(task!.task_id)?.status, "queued");
    repositoryAfter.close();
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
    const extraction = text.metadata.extraction as { status?: string; text_pages?: number };
    const cache = await readExtractionCache(vault, text);
    assert.equal(extraction.status, "completed");
    assert.equal(extraction.text_pages, 1);
    assert.equal(cache.page_text[0]?.page, 1);
    assert.match(cache.page_text[0]?.text ?? "", /IELTS 6\.5/);
    assert.match(cache.extracted_text, /--- Page 1 ---/);
    assert.deepEqual(evidenceLocator(text, [1], "English requirements").pages, [1]);
    assert.equal(await fs.readFile(path.join(vault, ...text.sidecar_path.split("/")), "utf8").then((raw) => !raw.includes("IELTS 6.5")), true, "Sidecars must not duplicate extracted text.");
    assert.equal(await fs.stat(path.join(vault, ...text.companion_note_path.split("/"))).then(() => true), true, "A visible Obsidian Companion Note must be created.");
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
    assert.equal(task?.status, "waiting-for-user");
    repository.close();
    const dispatched = await dispatchOnce({ vaultRoot: vault, limit: 1 });
    assert.equal(dispatched.tasks.length, 0, "A pre-gated attachment must never enter a Worker run.");
    const after = await RuntimeRepository.open(vault);
    assert.equal(after.getRuns(task!.task_id).length, 0, "the resource gate must stop before a Codex run starts");
    after.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});

test("application-tracker holds partial PDFs for user review instead of sending them to Codex", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-ingestion-pdf-partial-"));
  try {
    await initializeVault(vault, "disabled");
    const instanceId = "applications-partial-pdf";
    await createInstance(vault, {
      module_id: "application-tracker", instance_id: instanceId, display_name: "Applications Partial PDF",
      fields: { application_type: "masters", region: "Australia", intake: "2027-S1", default_currency: "AUD", "monitoring.enabled": true, "monitoring.default_check_interval_days": 30 },
    });
    const source = path.join(vault, "20-Workspace", "Applications", instanceId, "Inbox", "partial-update.pdf");
    await fs.writeFile(source, makePdf("A".repeat(55_000)));
    const materialized = await materializeInboxAiTasks(vault);
    const repository = await RuntimeRepository.open(vault);
    const task = repository.getTask(materialized.created[0]!);
    assert.equal(task?.resources.user, "required");
    assert.equal(task?.resources.codex, "not-required");
    assert.deepEqual(task?.payload.pdf_policy, { accepted_statuses: ["completed"], partial_policy: "review" });
    assert.equal(task?.payload.pdf_policy_source, "module-manifest");
    assert.deepEqual(task?.payload.pdf_extraction_decision, { usable: false, requires_review: true, status: "partial" });
    repository.close();

    const approved = await invokeCommandApi({
      vaultRoot: vault,
      requestId: "PDF-PARTIAL-REVIEW-001",
      method: "reviewPartialInboxExtraction",
      params: { item_id: String(task?.payload.item_id), decision: "approve-extracted-text" },
    });
    assert.equal(approved.ok, true, JSON.stringify(approved.error));
    const repositoryAfterReview = await RuntimeRepository.open(vault);
    const resumed = repositoryAfterReview.getTask(task!.task_id);
    assert.equal(resumed?.status, "queued");
    assert.equal((resumed?.payload.pdf_user_review as { decision?: string }).decision, "approve-extracted-text");
    repositoryAfterReview.close();
  } finally { await fs.rm(vault, { recursive: true, force: true }); }
});
