import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverModulesForVault } from "../core/discovery.js";
import { PkbError } from "../core/errors.js";
import type { JsonObject } from "../core/types.js";
import { applicationFactReviewAdapter, type ReviewResolutionAdapter } from "../application/reviewResolutionAdapter.js";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADAPTERS = new Map<string, ReviewResolutionAdapter>([[applicationFactReviewAdapter.id, applicationFactReviewAdapter]]);

/** The Platform resolves legacy field Review behavior from a module descriptor. */
export async function resolveReviewResolutionAdapter(vaultRoot: string, moduleId: string): Promise<ReviewResolutionAdapter> {
  const module = (await discoverModulesForVault(ENGINE_ROOT, vaultRoot)).find((candidate) => candidate.data.id === moduleId);
  const descriptor = module?.data.review_resolution;
  const id = descriptor && typeof descriptor === "object" && !Array.isArray(descriptor) && typeof (descriptor as JsonObject).adapter === "string" ? String((descriptor as JsonObject).adapter) : "";
  const adapter = ADAPTERS.get(id);
  if (!adapter) throw new PkbError("REVIEW_RESOLUTION_ADAPTER_UNAVAILABLE", `Module ${moduleId} does not declare an installed review resolution adapter.`);
  return adapter;
}
