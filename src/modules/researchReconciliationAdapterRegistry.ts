import { PkbError } from "../core/errors.js";
import type { JsonObject } from "../core/types.js";
import type { ResearchReconciliationAdapter } from "../components/researchReconciliation.js";
import { applicationResearchReconciliationAdapter } from "../application/researchReconciliationAdapter.js";

const ADAPTERS = new Map<string, ResearchReconciliationAdapter>([
  [applicationResearchReconciliationAdapter.id, applicationResearchReconciliationAdapter],
]);

/** Resolves a module-declared research reconciliation implementation. */
export function resolveResearchReconciliationAdapter(manifest: JsonObject): ResearchReconciliationAdapter {
  const contract = manifest.research_request;
  const descriptor = contract && typeof contract === "object" && !Array.isArray(contract) ? (contract as JsonObject).reconciliation : null;
  const id = descriptor && typeof descriptor === "object" && !Array.isArray(descriptor) && typeof (descriptor as JsonObject).adapter === "string" ? String((descriptor as JsonObject).adapter) : "";
  const adapter = ADAPTERS.get(id);
  if (!adapter) throw new PkbError("RESEARCH_RECONCILIATION_ADAPTER_UNAVAILABLE", `Module does not declare an installed research reconciliation adapter: ${id || "(missing)"}.`);
  return adapter;
}
