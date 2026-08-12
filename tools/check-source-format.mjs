import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const output = execFileSync("git", ["ls-files", "*.ts", "*.js", "*.mjs", "*.cjs", "*.py", "*.json", "*.yaml", "*.yml", "*.md"], { encoding: "utf8" });
const failures = [];
for (const file of output.split(/\r?\n/).filter(Boolean)) {
  const content = await readFile(file, "utf8");
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (/[ \t]+$/.test(line)) failures.push(`${file}:${index + 1}: trailing whitespace`);
  });
  if (content.includes("\u0000")) failures.push(`${file}: contains NUL bytes`);
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Source format check passed for ${output.split(/\r?\n/).filter(Boolean).length} files.`);
