#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeVault } from "../dist/core/vault.js";
import { syncInstalledConfiguration } from "../dist/platform/configuration.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARKER = ".knowledgeos-synthetic-benchmark.json";
const BASE_TIME = "2026-01-01T00:00:00.000Z";
export const SYNTHETIC_SCALES = Object.freeze({
  small: { modules: 3, instances: 3, records: 50, inbox: 10, reviews: 10, runs: 100, tasks: 100, quality: 20 },
  medium: { modules: 3, instances: 10, records: 1000, inbox: 200, reviews: 200, runs: 3000, tasks: 3000, quality: 1000 },
  large: { modules: 3, instances: 30, records: 10000, inbox: 1000, reviews: 1000, runs: 20000, tasks: 10000, quality: 3000 },
});

function usage() {
  return "usage: node tools/generate-synthetic-vault.mjs --scale small|medium|large [--output PATH] [--replace]";
}

function parseArgs(argv) {
  const result = { scale: "small", output: null, replace: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--scale") result.scale = argv[++index];
    else if (value === "--output") result.output = argv[++index];
    else if (value === "--replace") result.replace = true;
    else throw new Error(`${usage()}\nUnknown argument: ${value}`);
  }
  if (!SYNTHETIC_SCALES[result.scale]) throw new Error(usage());
  return result;
}

async function prepareTarget(target, replace) {
  const resolved = path.resolve(target);
  const entries = await fs.readdir(resolved).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
  if (!entries.length) { await fs.mkdir(resolved, { recursive: true }); return resolved; }
  const marker = path.join(resolved, MARKER);
  if (!replace || !entries.includes(MARKER)) {
    throw new Error(`Refusing to replace a non-empty directory without ${MARKER}: ${resolved}`);
  }
  const metadata = JSON.parse(await fs.readFile(marker, "utf8"));
  if (metadata.kind !== "knowledgeos-synthetic-benchmark") throw new Error(`Invalid synthetic marker: ${marker}`);
  await fs.rm(resolved, { recursive: true, force: true });
  await fs.mkdir(resolved, { recursive: true });
  return resolved;
}

function jsonMarkdown(data, title) {
  return `---\n${JSON.stringify(data, null, 2)}\n---\n\n# ${title}\n\nDeterministic synthetic benchmark content.\n`;
}

function moduleFor(index) { return ["application-tracker", "experience-log", "reading-log"][index % 3]; }
function instanceId(index) { return `synthetic-${(index % currentScale.instances) + 1}`.replace(/-(\d+)$/, (_, value) => `-${value.padStart(3, "0")}`); }
let currentScale;

async function writeInstances(vault, scale) {
  for (let index = 0; index < scale.instances; index += 1) {
    const id = `synthetic-${String(index + 1).padStart(3, "0")}`;
    const module = moduleFor(index);
    const contentRoot = `20-Workspace/Synthetic/${id}`;
    const data = { instance_id: id, module_id: module, status: "active", display_name: `Synthetic Instance ${index + 1}`,
      content_root: contentRoot, inbox_path: `${contentRoot}/Inbox`, timezone: "UTC", created: BASE_TIME, updated: BASE_TIME };
    const directory = path.join(vault, "90-System", "Instances", id);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "instance.yaml"), `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await fs.mkdir(path.join(vault, ...contentRoot.split("/"), "Records"), { recursive: true });
    await fs.mkdir(path.join(vault, ...contentRoot.split("/"), "Inbox"), { recursive: true });
  }
}

function recordData(index) {
  const number = index + 1; const module = moduleFor(index); const id = instanceId(index);
  if (module === "application-tracker") return { id: `APP-2026-${String(number).padStart(4, "0")}`, source_module: module, instance_id: id,
    type: "application-record", institution: `Synthetic Institution ${number}`, program_name: `Synthetic Program ${number}`, country: "Exampleland",
    intake: "2026-S1", application_status: "watching", monitoring: { active: true, check_interval_days: 30, last_checked: BASE_TIME,
      next_check: "2026-01-02T00:00:00.000Z", stopped: [] }, facts: {}, source_files: [], created: BASE_TIME, updated: BASE_TIME, schema_version: 2 };
  if (module === "experience-log") return { entry_id: `EXP-2026-${String(number).padStart(6, "0")}`, id: `EXP-2026-${String(number).padStart(6, "0")}`,
    type: "experience-entry", instance_id: id, occurred_at: BASE_TIME, raw_text: `Synthetic event ${number}`, project: null, tags: ["synthetic"],
    source_path: `synthetic://record/${number}`, captured_at: BASE_TIME, schema_version: 1 };
  return { id: `READ-2026-${String(number).padStart(6, "0")}`, type: "reading-note", schema_id: "record", schema_version: 1,
    module_version: "0.2.0-beta", instance_id: id, title: `Synthetic Reading ${number}`, source_refs: [], generation: null,
    created: BASE_TIME, updated: BASE_TIME };
}

async function writeRecords(vault, scale) {
  for (let index = 0; index < scale.records; index += 1) {
    const id = instanceId(index); const target = path.join(vault, "20-Workspace", "Synthetic", id, "Records", `record-${String(index + 1).padStart(6, "0")}.md`);
    await fs.writeFile(target, jsonMarkdown(recordData(index), `Synthetic Record ${index + 1}`), "utf8");
  }
}

async function writeInbox(vault, scale) {
  for (let index = 0; index < scale.inbox; index += 1) {
    const number = index + 1; const id = instanceId(index); const module = moduleFor(index);
    const data = { type: "capture", title: `Synthetic Inbox ${number}`, source_module: module, instance_id: id,
      content_type: "note", created: BASE_TIME, schema_version: 1 };
    await fs.writeFile(path.join(vault, "00-Inbox", `synthetic-inbox-${String(number).padStart(6, "0")}.md`), jsonMarkdown(data, data.title), "utf8");
  }
}

async function writeReviews(vault, scale) {
  const directory = path.join(vault, "90-System", "Review Queue", "Pending"); await fs.mkdir(directory, { recursive: true });
  for (let index = 0; index < scale.reviews; index += 1) {
    const number = index + 1; const reviewId = `REV-2026-${String(number).padStart(6, "0")}`;
    const data = { review_id: reviewId, origin_task_id: null, schema_version: 1, source_module: moduleFor(index), instance_id: instanceId(index),
      target: `20-Workspace/Synthetic/${instanceId(index)}/Records/record-${String((index % scale.records) + 1).padStart(6, "0")}.md`, action: "inspect",
      proposed_value: { synthetic: true }, confidence: 0.9, priority: ["critical", "high", "medium", "low"][index % 4], status: "pending",
      reason: `Synthetic review ${number}`, evidence: [], created: BASE_TIME, review_after: null, decision: null, decision_history: [],
      target_observation: null, resolution: null };
    await fs.writeFile(path.join(directory, `${reviewId}.md`), jsonMarkdown(data, `Synthetic Review ${number}`), "utf8");
  }
}

async function writeRuns(vault, scale) {
  const directory = path.join(vault, "90-System", "Logs"); await fs.mkdir(directory, { recursive: true });
  for (let index = 0; index < scale.runs; index += 1) {
    const number = index + 1; const runId = `RUN-2026-${String(number).padStart(6, "0")}`;
    const completed = new Date(Date.parse(BASE_TIME) + index * 1000).toISOString();
    const data = { run_id: runId, task_id: null, plan_id: null, source_module: moduleFor(index), instance_id: instanceId(index), review_id: null,
      status: index % 20 === 0 ? "failed" : "completed", git_snapshot: null, started_at: completed, completed_at: completed, schema_version: 1 };
    await fs.writeFile(path.join(directory, `${runId}.md`), jsonMarkdown(data, `Synthetic Run ${number}`), "utf8");
  }
}

async function seedRuntime(vault, scale) {
  const script = path.join(ENGINE_ROOT, "tools", "synthetic-vault-db.py");
  const database = path.join(vault, "90-System", "State", "runtime.db");
  const result = spawnSync("python", ["-X", "utf8", script, database, String(scale.tasks), String(scale.quality), String(scale.instances)], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Runtime fixture exited ${result.status}`);
}

export async function generateSyntheticVault({ scaleName, output, replace = false }) {
  currentScale = SYNTHETIC_SCALES[scaleName];
  if (!currentScale) throw new Error(`Unknown synthetic scale: ${scaleName}`);
  const target = await prepareTarget(output, replace);
  await initializeVault(target, "disabled");
  await syncInstalledConfiguration(target);
  await writeInstances(target, currentScale);
  await writeRecords(target, currentScale);
  await writeInbox(target, currentScale);
  await writeReviews(target, currentScale);
  await writeRuns(target, currentScale);
  await seedRuntime(target, currentScale);
  const metadata = { kind: "knowledgeos-synthetic-benchmark", schema_version: 1, scale: scaleName, generated_from: "deterministic-v1", counts: currentScale };
  await fs.writeFile(path.join(target, MARKER), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return { vault: target, ...metadata };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const output = options.output ? path.resolve(options.output) : await fs.mkdtemp(path.join(os.tmpdir(), `knowledgeos-${options.scale}-`));
  console.log(JSON.stringify(await generateSyntheticVault({ scaleName: options.scale, output, replace: options.replace }), null, 2));
}
