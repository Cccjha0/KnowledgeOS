import { prepareResearchReconciliation } from "../components/researchReconciliation.js";
import { prepareDueResearchRequests } from "../components/researchRequestScheduler.js";
import { PkbError } from "../core/errors.js";
import type { JsonObject, JsonValue } from "../core/types.js";
import type { RuntimeTask, TaskResources } from "../runtime/domain.js";
import { allocateId } from "../core/ids.js";

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
    id: "component.research-request-scheduler", version: "1.0.0", resources: FILESYSTEM, componentId: "research-request-scheduler",
    execute: async (context) => {
      const planId = await context.allocateId("PLAN");
      const result = await prepareDueResearchRequests({
        vaultRoot: context.vaultRoot, taskId: context.task.task_id, planId, now: new Date().toISOString(), allocateId: context.allocateId,
      });
      return result as unknown as JsonValue;
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
