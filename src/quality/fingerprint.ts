import { createHash } from "node:crypto";
import type { JsonValue } from "../core/types.js";

function stable(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function qualityFingerprint(parts: JsonValue[]): string { return createHash("sha256").update(stable(parts)).digest("hex"); }
export function reviewFingerprint(input: { module: string; instanceId: string | null; target: string; action: string; proposedValue: JsonValue; evidence: JsonValue[] }): string {
  return qualityFingerprint([input.module, input.instanceId, input.target, input.action, input.proposedValue]);
}
export function evidenceSnapshotHash(evidence: JsonValue[]): string { return qualityFingerprint(evidence); }
