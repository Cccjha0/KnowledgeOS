#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { invokeCommandApi } from "../dist/platform/commandApi.js";
import { enablePerformanceDiagnostics, performanceDiagnosticsSnapshot, resetPerformanceDiagnostics } from "../dist/core/performanceDiagnostics.js";
import { generateSyntheticVault, SYNTHETIC_SCALES } from "./generate-synthetic-vault.mjs";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = { scale: "small", iterations: 5, warmups: 1, output: null, fixture: null, keepFixture: false, scenarios: null, timeoutMs: 60_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--scale") options.scale = argv[++index];
    else if (value === "--iterations") options.iterations = Number(argv[++index]);
    else if (value === "--warmups") options.warmups = Number(argv[++index]);
    else if (value === "--output") options.output = path.resolve(argv[++index]);
    else if (value === "--fixture") options.fixture = path.resolve(argv[++index]);
    else if (value === "--keep-fixture") options.keepFixture = true;
    else if (value === "--scenarios") options.scenarios = argv[++index].split(",").filter(Boolean);
    else if (value === "--scenario-timeout-ms") options.timeoutMs = Number(argv[++index]);
    else throw new Error(`Unknown benchmark argument: ${value}`);
  }
  if (!SYNTHETIC_SCALES[options.scale]) throw new Error(`Unknown scale: ${options.scale}`);
  if (!Number.isInteger(options.iterations) || options.iterations < 2) throw new Error("--iterations must be at least 2");
  if (!Number.isInteger(options.warmups) || options.warmups < 0) throw new Error("--warmups must be non-negative");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1_000) throw new Error("--scenario-timeout-ms must be at least 1000");
  return options;
}

function percentile(sorted, ratio) { return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]; }
function stats(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { samples: values.length, median_ms: Number(median.toFixed(3)), p95_ms: Number(percentile(sorted, 0.95).toFixed(3)),
    min_ms: Number(sorted[0].toFixed(3)), max_ms: Number(sorted.at(-1).toFixed(3)) };
}

function sumDiagnostics(samples) {
  const total = {};
  for (const sample of samples) for (const [key, value] of Object.entries(sample)) total[key] = (total[key] ?? 0) + value;
  return Object.fromEntries(Object.entries(total).map(([key, value]) => [key, Number((value / samples.length).toFixed(3))]));
}

async function measureScenario(vault, scenario, warmups, iterations) {
  for (let index = 0; index < warmups; index += 1) await invokeCommandApi({ vaultRoot: vault, requestId: `WARM-${scenario.name}-${index}`, method: scenario.method, params: scenario.params });
  const durations = []; const responseBytes = []; const diagnostics = [];
  for (let index = 0; index < iterations; index += 1) {
    resetPerformanceDiagnostics(); const started = performance.now();
    const response = await invokeCommandApi({ vaultRoot: vault, requestId: `BENCH-${scenario.name}-${index}`, method: scenario.method, params: scenario.params });
    durations.push(performance.now() - started); responseBytes.push(Buffer.byteLength(JSON.stringify(response)));
    diagnostics.push(performanceDiagnosticsSnapshot());
    if (!response.ok) throw new Error(`${scenario.name} failed: ${JSON.stringify(response.error)}`);
  }
  return { ...stats(durations), response_bytes: { median: stats(responseBytes).median_ms, p95: stats(responseBytes).p95_ms }, diagnostics_per_request: sumDiagnostics(diagnostics) };
}

async function measureColdScenario(vault, scenario, iterations) {
  const durations = []; const responseBytes = []; const diagnostics = [];
  for (let index = 0; index < iterations; index += 1) {
    const result = spawnSync(process.execPath, [path.join(ENGINE_ROOT, "tools", "benchmark-command-worker.mjs"), vault, scenario.method, JSON.stringify(scenario.params), `COLD-${scenario.name}-${index}`], {
      cwd: ENGINE_ROOT, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${scenario.name} cold worker failed: ${result.stderr || result.stdout}`);
    const sample = JSON.parse(result.stdout);
    durations.push(sample.duration_ms); responseBytes.push(sample.response_bytes); diagnostics.push(sample.diagnostics);
  }
  return { ...stats(durations), response_bytes: { median: stats(responseBytes).median_ms, p95: stats(responseBytes).p95_ms }, diagnostics_per_request: sumDiagnostics(diagnostics) };
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function measureApiServerStart(vault, iterations) {
  const durations = []; const bytes = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    const child = spawn(process.execPath, [path.join(ENGINE_ROOT, "dist", "cli.js"), "api-server", "--vault", vault], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const response = await new Promise((resolve, reject) => {
      let stdout = ""; let stderr = "";
      const timer = setTimeout(() => reject(new Error(`API server timeout: ${stderr}`)), 30_000);
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.stdout.on("data", (chunk) => { stdout += String(chunk); const newline = stdout.indexOf("\n"); if (newline >= 0) { clearTimeout(timer); resolve(stdout.slice(0, newline)); } });
      child.on("error", reject);
      child.stdin.write(`${JSON.stringify({ request_id: `COLD-${index}`, method: "getInstances", params: {} })}\n`);
    });
    durations.push(performance.now() - started); bytes.push(Buffer.byteLength(response));
    child.stdin.end(); await new Promise((resolve) => child.once("exit", resolve));
  }
  return { ...stats(durations), response_bytes: { median: stats(bytes).median_ms, p95: stats(bytes).p95_ms } };
}

async function environmentMetadata(scale) {
  const python = spawnSync("python", ["--version"], { encoding: "utf8", windowsHide: true });
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ENGINE_ROOT, encoding: "utf8", windowsHide: true });
  return { os: `${os.platform()} ${os.release()} ${os.arch()}`, node: process.version, python: (python.stdout || python.stderr).trim(), commit_sha: commit.stdout.trim(), fixture_scale: scale,
    generated_at: new Date().toISOString() };
}

export async function runBenchmark(options) {
  let fixture = options.fixture; let ownedFixture = false;
  if (!fixture) { fixture = await fs.mkdtemp(path.join(os.tmpdir(), `knowledgeos-benchmark-${options.scale}-`)); ownedFixture = true;
    await generateSyntheticVault({ scaleName: options.scale, output: fixture }); }
  const markerPath = path.join(fixture, ".knowledgeos-synthetic-benchmark.json");
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8").catch(() => { throw new Error(`Benchmark fixture is missing its synthetic marker: ${markerPath}`); }));
  if (marker.kind !== "knowledgeos-synthetic-benchmark" || marker.scale !== options.scale || JSON.stringify(marker.counts) !== JSON.stringify(SYNTHETIC_SCALES[options.scale])) {
    throw new Error(`Benchmark fixture marker does not match the requested ${options.scale} scale.`);
  }
  enablePerformanceDiagnostics();
  const scenarios = [
    { name: "getModules", method: "getModules", params: {} },
    { name: "getInstances", method: "getInstances", params: {} },
    { name: "getTodayItems", method: "getTodayItems", params: { refresh_markdown: false } },
    { name: "getInboxCenterSnapshot", method: "getInboxCenterSnapshot", params: { page_size: 50 } },
    { name: "listReviewItems", method: "listReviewItems", params: { statuses: ["pending", "error"], page_size: 50 } },
    { name: "system-overview", method: "getSystemCenterSnapshot", params: { section: "overview" } },
    { name: "system-tasks", method: "getSystemCenterSnapshot", params: { section: "tasks", page_size: 50 } },
    { name: "system-quality", method: "getSystemCenterSnapshot", params: { section: "quality" } },
    { name: "system-modules", method: "getSystemCenterSnapshot", params: { section: "modules" } },
    { name: "system-history", method: "getSystemCenterSnapshot", params: { section: "history", page_size: 20 } },
    { name: "getRecentRuns", method: "getRecentRuns", params: { page_size: 20, include_rollback: false } },
    { name: "taskCycle-resource-wait", method: "runTaskCycle", params: { limit: 0, network_probe_url: "http://127.0.0.1:1", codex_executable: "knowledgeos-benchmark-codex-unavailable" } },
  ];
  try {
    const results = {};
    const selected = options.scenarios ? new Set(options.scenarios) : null;
    if (!selected || selected.has("api-server-cold-start")) {
      process.stderr.write("[benchmark] api-server-cold-start\n");
      results["api-server-cold-start"] = await withTimeout(measureApiServerStart(fixture, options.iterations), options.timeoutMs, "api-server-cold-start");
    }
    for (const scenario of scenarios) {
      if (selected && !selected.has(scenario.name)) continue;
      process.stderr.write(`[benchmark] ${scenario.name}\n`);
      const cold = await withTimeout(measureColdScenario(fixture, scenario, options.iterations), options.timeoutMs, `${scenario.name} cold`);
      const warm = await withTimeout(measureScenario(fixture, scenario, options.warmups, options.iterations), options.timeoutMs, `${scenario.name} warm`);
      results[scenario.name] = { cold, warm };
    }
    return { schema_version: 1, environment: await environmentMetadata(options.scale), fixture_counts: SYNTHETIC_SCALES[options.scale],
      methodology: { warmups: options.warmups, iterations: options.iterations, statistics: ["median", "p95", "min", "max"], content_logged: false }, results };
  } finally {
    enablePerformanceDiagnostics(false);
    if (ownedFixture && !options.keepFixture) await fs.rm(fixture, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2)); const report = await runBenchmark(options);
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) await fs.writeFile(options.output, rendered, "utf8"); else process.stdout.write(rendered);
}
