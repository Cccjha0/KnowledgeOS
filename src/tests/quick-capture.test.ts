import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inferCaptureContext } from "../core/capture.js";
import { parseMarkdown } from "../core/bridge.js";
import { listFilesRecursive, readJson } from "../core/files.js";
import { initializeVault } from "../core/vault.js";
import { invokeCommandApi } from "../platform/commandApi.js";
import type { JsonObject } from "../core/types.js";

const ENGINE_ROOT = path.resolve(".");

async function writeApplicationInstance(vault: string): Promise<void> {
  const directory = path.join(vault, "90-System", "Instances", "capture-instance");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "instance.yaml"), [
    "instance_id: capture-instance",
    "module_id: application-tracker",
    "status: active",
    "display_name: Capture Test",
    "content_root: 20-Workspace/Applications/capture-instance",
    "inbox_path: 20-Workspace/Applications/capture-instance/Inbox",
    'created: "2026-07-27T00:00:00Z"',
    'updated: "2026-07-27T00:00:00Z"',
    "",
  ].join("\n"), "utf8");
}

test("Capture context prefers the current active instance and supports explicit overrides", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-capture-context-"));
  try {
    await initializeVault(vault, "disabled");
    await writeApplicationInstance(vault);
    const inferred = await inferCaptureContext({
      vaultRoot: vault,
      engineRoot: ENGINE_ROOT,
      activePath: "20-Workspace/Applications/capture-instance/Records/item.md",
    });
    assert.equal(inferred.scope, "instance");
    assert.equal(inferred.instanceId, "capture-instance");
    assert.equal(inferred.reason, "current-instance");

    const module = await inferCaptureContext({
      vaultRoot: vault,
      engineRoot: ENGINE_ROOT,
      moduleId: "experience-log",
      activePath: "20-Workspace/Applications/capture-instance/Records/item.md",
    });
    assert.equal(module.scope, "module");
    assert.equal(module.destination, "20-Workspace/Experience Log/Inbox");

    const global = await inferCaptureContext({ vaultRoot: vault, engineRoot: ENGINE_ROOT, activePath: "Today.md" });
    assert.equal(global.destination, "00-Inbox");
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test("Quick Capture saves through an idempotent Operation Plan without overwriting consecutive notes", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-quick-capture-"));
  try {
    await initializeVault(vault, "disabled");
    const attachment = path.join(vault, "30-Knowledge", "reference.pdf");
    await fs.writeFile(attachment, "test attachment", "utf8");
    const params = {
      content: "第一条离线记录",
      title: "实习想法",
      content_type: "idea",
      active_path: "Today.md",
      attachments: ["30-Knowledge/reference.pdf"],
    };
    const first = await invokeCommandApi({ vaultRoot: vault, requestId: "CAPTURE-REQUEST-001", method: "createCapture", params });
    assert.equal(first.ok, true);
    const firstData = first.data as JsonObject;
    assert.equal(firstData.status, "saved");
    assert.match(String(firstData.path), /^00-Inbox\//);

    const repeated = await invokeCommandApi({ vaultRoot: vault, requestId: "CAPTURE-REQUEST-001", method: "createCapture", params });
    assert.equal(repeated.ok, true);
    assert.equal((repeated.data as JsonObject).path, firstData.path);

    const second = await invokeCommandApi({ vaultRoot: vault, requestId: "CAPTURE-REQUEST-002", method: "createCapture", params });
    assert.equal(second.ok, true);
    assert.notEqual((second.data as JsonObject).path, firstData.path);

    const captures = await listFilesRecursive(path.join(vault, "00-Inbox"), ".md");
    assert.equal(captures.length, 2);
    const document = parseMarkdown(vault, path.join(vault, ...String(firstData.path).split("/")));
    assert.equal(document.data.content_type, "idea");
    assert.equal(document.content.includes("第一条离线记录"), true);
    assert.equal(document.content.includes("[[30-Knowledge/reference.pdf]]"), true);
    const state = await readJson<JsonObject | null>(path.join(vault, "90-System", "State", "Captures", `${String(firstData.capture_id)}.json`), null);
    assert.equal(state?.source_level, "global-inbox");
    assert.equal(typeof state?.file_hash, "string");
    assert.equal(state?.sensitivity_class, 0);
    assert.deepEqual(state?.access_policy, { max_representation: "full" });
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test("Capture preview does not write files and empty content retains a recoverable error", async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), "knowledgeos-capture-preview-"));
  try {
    await initializeVault(vault, "disabled");
    const preview = await invokeCommandApi({
      vaultRoot: vault, requestId: "CAPTURE-PREVIEW", method: "createCapture",
      params: { preview_only: true, active_path: "Today.md" },
    });
    assert.equal(preview.ok, true);
    assert.equal((preview.data as JsonObject).status, "preview");
    assert.equal((await listFilesRecursive(path.join(vault, "00-Inbox"), ".md")).length, 0);

    const empty = await invokeCommandApi({
      vaultRoot: vault, requestId: "CAPTURE-EMPTY", method: "createCapture", params: { content: "   " },
    });
    assert.equal(empty.ok, false);
    assert.equal(empty.error?.code, "CAPTURE_CONTENT_REQUIRED");
    assert.equal(empty.error?.retryable, true);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});
