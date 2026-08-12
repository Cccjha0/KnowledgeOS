#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { invokeCommandApi } from "../dist/platform/commandApi.js";
import { enablePerformanceDiagnostics, performanceDiagnosticsSnapshot, resetPerformanceDiagnostics } from "../dist/core/performanceDiagnostics.js";

const [vaultRoot, method, paramsJson, requestId = "BENCHMARK-COLD"] = process.argv.slice(2);
if (!vaultRoot || !method || !paramsJson) throw new Error("benchmark worker requires vault, method, and params JSON");
enablePerformanceDiagnostics(); resetPerformanceDiagnostics();
const started = performance.now();
const response = await invokeCommandApi({ vaultRoot, requestId, method, params: JSON.parse(paramsJson) });
const durationMs = performance.now() - started;
process.stdout.write(`${JSON.stringify({ duration_ms: durationMs, response_bytes: Buffer.byteLength(JSON.stringify(response)), diagnostics: performanceDiagnosticsSnapshot(), response })}\n`);
if (!response.ok) process.exitCode = 1;
