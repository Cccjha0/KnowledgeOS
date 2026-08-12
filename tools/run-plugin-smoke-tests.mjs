import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

const testsDirectory = path.resolve("plugins", "knowledgeos-obsidian", "tests");
const testFiles = (await readdir(testsDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".smoke.test.cjs"))
  .map((entry) => path.join(testsDirectory, entry.name))
  .sort();

if (!testFiles.length) {
  console.error(`No plugin smoke tests were found in ${testsDirectory}.`);
  process.exit(1);
}

const child = spawn(process.execPath, ["--test", ...testFiles], {
  stdio: "inherit",
  windowsHide: true,
});

child.on("error", (error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

child.on("close", (code, signal) => {
  if (signal) console.error(`Plugin smoke tests terminated by ${signal}.`);
  process.exit(code ?? 1);
});
