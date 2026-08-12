import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

const testsDirectory = path.resolve("dist", "tests");
const testFiles = (await readdir(testsDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
  .map((entry) => path.join(testsDirectory, entry.name))
  .sort();

if (!testFiles.length) {
  console.error(`No compiled Engine tests were found in ${testsDirectory}. Run npm run build first.`);
  process.exit(1);
}

if (process.argv.includes("--list")) {
  console.log(testFiles.join("\n"));
  process.exit(0);
}

const concurrency = Math.max(1, Number.parseInt(process.env.KNOWLEDGEOS_TEST_CONCURRENCY || "2", 10) || 2);
const timeoutMs = Math.max(10_000, Number.parseInt(process.env.KNOWLEDGEOS_TEST_FILE_TIMEOUT_MS || "600000", 10) || 600_000);
let cursor = 0;
const failures = [];

async function runFile(file) {
  const label = path.basename(file);
  const started = Date.now();
  console.log(`[engine-test] START ${label}`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", file], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    const timeout = setTimeout(() => {
      output += `\n[engine-test] TIMEOUT after ${timeoutMs}ms\n`;
      child.kill();
    }, timeoutMs);
    const heartbeat = setInterval(() => console.log(`[engine-test] STILL ${label} (${Math.round((Date.now() - started) / 1_000)}s)`), 60_000);
    child.on("error", (error) => { output += `\n${error.stack || error.message}\n`; });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      const duration = ((Date.now() - started) / 1_000).toFixed(1);
      if (code === 0) console.log(`[engine-test] PASS  ${label} (${duration}s)`);
      else {
        failures.push(label);
        console.error(`[engine-test] FAIL  ${label} (${duration}s, code=${code}, signal=${signal || "none"})\n${output}`);
      }
      resolve();
    });
  });
}

async function worker() {
  while (cursor < testFiles.length) {
    const file = testFiles[cursor++];
    await runFile(file);
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, testFiles.length) }, () => worker()));
if (failures.length) {
  console.error(`[engine-test] ${failures.length} file(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`[engine-test] PASS all ${testFiles.length} files`);
