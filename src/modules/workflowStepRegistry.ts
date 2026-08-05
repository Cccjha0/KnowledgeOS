import { prepareResearchReconciliation } from "../components/researchReconciliation.js";
import { prepareDueResearchRequests } from "../components/researchRequestScheduler.js";
import { prepareLinkReconciliation } from "../components/linkReconciliation.js";
import { prepareIndexMaterialization, type IndexEntry } from "../components/indexMaterializer.js";
import { PkbError } from "../core/errors.js";
import type { JsonObject, JsonValue } from "../core/types.js";
import type { RuntimeTask, TaskResources } from "../runtime/domain.js";
import { allocateId } from "../core/ids.js";
import { eventFingerprint, minimizeEventPayload, publishRuntimeEvent } from "../runtime/triggers.js";

type StepResources = Partial<TaskResources>;

export interface WorkflowStepExecutionContext {
  vaultRoot: string;
  task: RuntimeTask;
  runId: string;
  moduleId: string;
  moduleVersion: string;
  instance: JsonObject | null;
  with: JsonObject;
  sourceFile: string | null;
  getValue(key: string): JsonValue | undefined;
  allocateId(prefix: string): Promise<string>;
}

export interface WorkflowStepDefinition {
  id: string;
  version: string;
  resources: StepResources;
  inputSchema?: string;
  outputSchema?: string;
  componentId?: string;
  execute?: (context: WorkflowStepExecutionContext) => Promise<JsonValue>;
}

const FILESYSTEM: StepResources = { filesystem: "required" };

function object(value: JsonValue | undefined, code: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PkbError(code, "Workflow step input must be an object.");
  return value as JsonObject;
}

function string(value: JsonValue | undefined, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new PkbError(code, "Workflow step input must be a non-empty string.");
  return value;
}

function selectValue(source: JsonValue, dottedPath: string): JsonValue | undefined {
  let current: JsonValue | undefined = source;
  for (const part of dottedPath.split(".")) {
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0) return undefined;
      current = current[index];
    } else if (current && typeof current === "object") current = current[part];
    else return undefined;
  }
  return current;
}

const DEFINITIONS: readonly WorkflowStepDefinition[] = [
  { id: "core.validate-capture", version: "1.0.0", resources: FILESYSTEM },
  { id: "core.parse-structured-document", version: "1.0.0", resources: FILESYSTEM },
  { id: "core.query-documents", version: "1.0.0", resources: FILESYSTEM },
  { id: "codex.prompt", version: "1.0.0", resources: { filesystem: "required", codex: "required" } },
  {
    id: "component.research-reconciliation", version: "1.0.0", resources: FILESYSTEM, componentId: "research-reconciliation",
    execute: async (context) => {
      const report = object(context.getValue(string(context.with.report, "MODULE_WORKFLOW_REPORT_MISSING")), "MODULE_WORKFLOW_REPORT_MISSING");
      const candidateKey = string(context.with.record_candidates, "MODULE_WORKFLOW_RECORD_CANDIDATES_MISSING");
      const candidates = context.getValue(candidateKey);
      if (!Array.isArray(candidates)) throw new PkbError("MODULE_WORKFLOW_RECORD_CANDIDATES_MISSING", `${candidateKey} did not produce record candidates.`);
      if (!context.sourceFile) throw new PkbError("MODULE_WORKFLOW_SOURCE_REQUIRED", "Research reconciliation requires source_file.");
      if (!context.instance) throw new PkbError("MODULE_WORKFLOW_INSTANCE_REQUIRED", "Research reconciliation requires an instance.");
      const result = await prepareResearchReconciliation({
        vaultRoot: context.vaultRoot, taskId: context.task.task_id, runId: context.runId, moduleId: context.moduleId, moduleVersion: context.moduleVersion,
        instance: context.instance, report, sourceFile: context.sourceFile,
        candidates: candidates.map((candidate) => {
          const document = object(candidate, "MODULE_WORKFLOW_RECORD_CANDIDATE_INVALID");
          return { path: string(document.path, "MODULE_WORKFLOW_RECORD_CANDIDATE_INVALID"), data: object(document.data, "MODULE_WORKFLOW_RECORD_CANDIDATE_INVALID") };
        }),
        allocateId: context.allocateId,
      });
      return result as unknown as JsonValue;
    },
  },
  {
    id: "component.link-reconciliation", version: "1.0.0", resources: FILESYSTEM, componentId: "link-reconciliation",
    execute: async (context) => {
      if (!context.instance || typeof context.instance.content_root !== "string") throw new PkbError("MODULE_WORKFLOW_INSTANCE_REQUIRED", "Link reconciliation requires an instance content_root.");
      const raw = context.with.links_from === undefined ? context.with.links : context.getValue(string(context.with.links_from, "LINKS_FROM_REQUIRED"));
      if (!Array.isArray(raw) || !raw.every((value) => typeof value === "string")) throw new PkbError("LINKS_INVALID", "Link reconciliation requires an array of links.");
      const result = await prepareLinkReconciliation({ vaultRoot: context.vaultRoot, planId: await context.allocateId("PLAN"), taskId: context.task.task_id, moduleId: context.moduleId,
        instanceId: context.task.instance_id, instanceRoot: context.instance.content_root, target: string(context.with.target, "LINK_TARGET_REQUIRED"), links: raw,
        ...(typeof context.with.field === "string" ? { field: context.with.field } : {}) });
      return result as unknown as JsonValue;
    },
  },
  {
    id: "component.index-materializer", version: "1.0.0", resources: FILESYSTEM, componentId: "index-materializer",
    execute: async (context) => {
      if (!context.instance || typeof context.instance.content_root !== "string") throw new PkbError("MODULE_WORKFLOW_INSTANCE_REQUIRED", "Index materialization requires an instance content_root.");
      const raw = context.with.entries_from === undefined ? context.with.entries : context.getValue(string(context.with.entries_from, "INDEX_ENTRIES_FROM_REQUIRED"));
      if (!Array.isArray(raw)) throw new PkbError("INDEX_ENTRIES_INVALID", "Index materialization requires an array of entries.");
      const entries: IndexEntry[] = raw.map((value) => {
        const entry = object(value, "INDEX_ENTRY_INVALID");
        return { title: string(entry.title, "INDEX_ENTRY_INVALID"), target: string(entry.target, "INDEX_ENTRY_INVALID"), ...(typeof entry.description === "string" ? { description: entry.description } : {}) };
      });
      const result = await prepareIndexMaterialization({ vaultRoot: context.vaultRoot, planId: await context.allocateId("PLAN"), taskId: context.task.task_id, moduleId: context.moduleId,
        instanceId: context.task.instance_id, instanceRoot: context.instance.content_root, target: string(context.with.target, "INDEX_TARGET_REQUIRED"), title: string(context.with.title, "INDEX_TITLE_REQUIRED"), entries,
        ...(typeof context.with.section === "string" ? { section: context.with.section } : {}) });
      return result as unknown as JsonValue;
    },
  },
  {
    id: "component.research-request-scheduler", version: "1.0.0", resources: FILESYSTEM, componentId: "research-request-scheduler",
    execute: async (context) => {
      const planId = await context.allocateId("PLAN");
      const result = await prepareDueResearchRequests({
        vaultRoot: context.vaultRoot, taskId: context.task.task_id, planId, now: new Date().toISOString(), allocateId: context.allocateId,
      });
      return result as unknown as JsonValue;
    },
  },
  {
    id: "core.publish-event", version: "1.0.0", resources: FILESYSTEM,
    execute: async (context) => {
      const eventType = string(context.with.event_type, "EVENT_TYPE_REQUIRED");
      const source = typeof context.with.payload_from === "string" ? context.getValue(context.with.payload_from) : undefined;
      let payload = source === undefined ? (context.with.payload && typeof context.with.payload === "object" && !Array.isArray(context.with.payload)
        ? context.with.payload as JsonObject : {}) : object(source, "EVENT_PAYLOAD_INVALID");
      if (context.with.payload_fields && typeof context.with.payload_fields === "object" && !Array.isArray(context.with.payload_fields)) {
        const selected: JsonObject = {};
        for (const [field, selector] of Object.entries(context.with.payload_fields as JsonObject)) {
          if (typeof selector !== "string") continue;
          const value = selectValue(payload, selector);
          if (typeof value === "string") selected[field] = value;
        }
        payload = selected;
      }
      if (typeof context.with.only_if_created_from === "string") {
        const candidate = object(context.getValue(context.with.only_if_created_from), "EVENT_CONDITION_INVALID");
        if (!Array.isArray(candidate.created) || candidate.created.length === 0) return { skipped: true, reason: "no-created-items" };
      }
      const stablePayload = minimizeEventPayload(payload);
      return await publishRuntimeEvent(context.vaultRoot, {
        type: eventType, module: context.moduleId, instance_id: context.task.instance_id, payload: {
          ...stablePayload, run_id: context.runId,
        },
        fingerprint: eventFingerprint({ type: eventType, module: context.moduleId, instance_id: context.task.instance_id, payload: stablePayload }),
      }) as unknown as JsonValue;
    },
  },
  { id: "core.build-operation-plan", version: "1.0.0", resources: FILESYSTEM },
];

const BY_ID = new Map(DEFINITIONS.map((definition) => [definition.id, definition]));

export function getWorkflowStepDefinition(id: string): WorkflowStepDefinition | null {
  return BY_ID.get(id) ?? null;
}

export function listWorkflowStepDefinitions(): readonly WorkflowStepDefinition[] {
  return DEFINITIONS;
}
