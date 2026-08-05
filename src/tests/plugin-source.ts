import { promises as fs } from "node:fs";
import path from "node:path";

const PLUGIN_ROOT = path.resolve("plugins", "knowledgeos-obsidian");

export async function readPluginSource(...relativePaths: string[]): Promise<string> {
  const paths = relativePaths.length ? relativePaths : [
    "main.js",
    "views/review-center.js",
    "views/inbox-center.js",
    "views/system-center.js",
    "views/today.js",
    "views/settings-tab.js",
    "settings/defaults.js",
    "services/core-command-client.js",
  ];
  return (await Promise.all(paths.map((relativePath) => fs.readFile(path.join(PLUGIN_ROOT, relativePath), "utf8")))).join("\n");
}
