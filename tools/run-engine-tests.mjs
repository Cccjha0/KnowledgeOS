import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

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

const result = spawnSync(process.execPath, ["--test", ...testFiles], { stdio: "inherit" });
process.exit(result.status ?? 1);
