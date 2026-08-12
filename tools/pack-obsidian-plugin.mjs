import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const source = path.resolve("plugins", "knowledgeos-obsidian");
const output = path.resolve("release", "knowledgeos-obsidian");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const [from, to] of [["dist/main.js", "main.js"], ["manifest.json", "manifest.json"], ["styles.css", "styles.css"]]) {
  await copyFile(path.join(source, from), path.join(output, to));
}
console.log(`Prepared installable Obsidian plugin at ${output}`);
