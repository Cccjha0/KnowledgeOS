import { PkbError } from "./errors.js";

/**
 * A document's sensitivity policy and a Workflow's requested representation.
 * 0 = metadata, 1 = summary, 2 = full content, 3 = sensitive original.
 */
export type ReadLevel = 0 | 1 | 2 | 3;

export function assertReadLevel(value: number, label = "read level"): ReadLevel {
  if (!Number.isInteger(value) || value < 0 || value > 3) throw new PkbError("MODULE_READ_LEVEL_INVALID", `${label} must be an integer from 0 to 3.`);
  return value as ReadLevel;
}
