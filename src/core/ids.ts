import path from "node:path";
import { readJson, writeJsonAtomic } from "./files.js";

interface CounterFile {
  counters: Record<string, number>;
}

export async function allocateId(vaultRoot: string, prefix: string): Promise<string> {
  const year = new Date().getUTCFullYear();
  const key = `${prefix}:${year}`;
  const statePath = path.join(vaultRoot, "90-System", "State", "id-counters.json");
  const state = await readJson<CounterFile>(statePath, { counters: {} });
  const next = (state.counters[key] ?? 0) + 1;
  state.counters[key] = next;
  await writeJsonAtomic(statePath, state);
  return `${prefix}-${year}-${String(next).padStart(6, "0")}`;
}
