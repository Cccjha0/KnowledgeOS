import path from "node:path";
import type { RunLog } from "./types.js";
import { validateSchema, writeMarkdown } from "./bridge.js";
import { ensureDir } from "./files.js";
import { updateRunSummaryIndex } from "./runSummaryIndex.js";

const RUN_LOG_SCHEMA = "https://pkb.local/schemas/core/run-log.schema.json";

export async function writeRunLog(
  vaultRoot: string,
  log: RunLog,
  content: string,
): Promise<string> {
  validateSchema(vaultRoot, RUN_LOG_SCHEMA, log);
  const filePath = path.join(vaultRoot, "90-System", "Logs", `${log.run_id}.md`);
  await ensureDir(path.dirname(filePath));
  writeMarkdown(vaultRoot, filePath, { data: log, content });
  updateRunSummaryIndex(vaultRoot, log, content, filePath);
  return filePath;
}
