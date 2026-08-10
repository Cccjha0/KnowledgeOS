import type { JsonObject } from "../core/types.js";

/**
 * Compatibility-only identity for research reports created before module-owned
 * processor descriptors became the source of truth. New modules must provide
 * `type` and `module_id` (or an unambiguous registered schema) themselves.
 */
export interface LegacyApplicationDocumentIdentity {
  entityType: "research-report";
  moduleId: "application-tracker";
  /** Fields supplied only when a legacy document has not yet named them. */
  migrationPatch: JsonObject;
}

export function resolveLegacyDocumentIdentity(data: JsonObject): LegacyApplicationDocumentIdentity | null {
  if (data.research_type !== "application-update") return null;
  return {
    entityType: "research-report",
    moduleId: "application-tracker",
    migrationPatch: {
      source_module: "application-tracker",
      type: "research-report",
      schema_version: 1,
    },
  };
}

/** @deprecated Use resolveLegacyDocumentIdentity for compatibility-only lookup. */
export function resolveLegacyApplicationDocumentIdentity(data: JsonObject): LegacyApplicationDocumentIdentity | null {
  return resolveLegacyDocumentIdentity(data);
}

export const LEGACY_APPLICATION_COMPATIBILITY_NOTICE =
  "The `pkb application` command group is deprecated compatibility-only. Use the Module Workflow Runner or Command API for new integrations.";
