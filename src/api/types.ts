import type { JsonObject, JsonValue, ReviewDecisionKind } from "../core/types.js";

export const COMMAND_API_VERSION = "1" as const;

export type UiOperationState =
  | "ready"
  | "loading"
  | "running"
  | "waiting-for-user"
  | "waiting-for-ai"
  | "waiting-for-network"
  | "completed"
  | "failed"
  | "cancelled";

export type CommandApiMethod =
  | "getTodayItems"
  | "getSystemCenterSnapshot"
  | "createCapture"
  | "listInboxItems"
  | "getInboxCenterSnapshot"
  | "processInboxItem"
  | "processInboxBatch"
  | "listReviewItems"
  | "resolveReview"
  | "getModules"
  | "getInstances"
  | "getRecentRuns"
  | "getRunDetails"
  | "rollbackRun"
  | "manageModule"
  | "createInstance"
  | "manageInstance"
  | "listTasks"
  | "getTaskDetails"
  | "manageTask"
  | "getTaskRuntimeStatus"
  | "enqueueTask"
  | "runTaskCycle"
  | "listCodexModels"
  | "getQualityDashboard"
  | "listQualityIssues"
  | "manageQualityIssue"
  | "runQualityAudit"
  | "getFieldProvenance"
  | "updateAssetAccessPolicy"
  | "classifyInboxAttachment"
  | "reviewPartialInboxExtraction"
  | "migrateLegacyAccessPolicies"
  | "backfillQualityMetadata"
  | "analyzeModuleRequirement"
  | "previewModuleBlueprint"
  | "createModuleFromBlueprint"
  | "getModuleReadiness"
  | "runModuleReadinessAction";

export interface CommandApiRequest extends JsonObject {
  api_version: typeof COMMAND_API_VERSION;
  request_id: string;
  method: CommandApiMethod;
  params: JsonObject;
}

export interface UserFacingError extends JsonObject {
  code: string;
  message: string;
  what_happened: string;
  impact: string;
  recovery_actions: string[];
  retryable: boolean;
  technical_details: JsonValue;
}

export interface CommandApiResponse<T extends JsonValue = JsonValue> extends JsonObject {
  api_version: typeof COMMAND_API_VERSION;
  request_id: string;
  method: CommandApiMethod;
  state: UiOperationState;
  ok: boolean;
  data: T | null;
  error: UserFacingError | null;
}

export interface ResolveReviewParams {
  review_id: string;
  mode?: "decide" | "prepare-discussion" | "apply-discussion-result" | "reconcile" | "retry" | "mark-resolved-by-user-edit";
  decision?: ReviewDecisionKind;
  user_comment?: string;
  review_after?: string | null;
  modified_value?: JsonValue;
  context_token?: string;
  discussion_result?: {
    outcome: "approve" | "approve-with-modification" | "reject" | "continue-waiting" | "needs-more-information";
    user_comment: string;
    modified_value?: JsonValue;
  };
}

export interface CreateCaptureParams {
  content?: string;
  title?: string | null;
  module_id?: string | null;
  instance_id?: string | null;
  content_type?: string | null;
  attachments?: string[];
  active_path?: string | null;
  preview_only?: boolean;
}

export type InboxAction = "preview" | "process" | "route" | "retry" | "defer" | "ignore" | "unmanage" | "quarantine-empty";

export interface ProcessInboxItemParams {
  item_id: string;
  action?: InboxAction;
  codex_model?: string;
  codex_reasoning_effort?: string;
  module_id?: string | null;
  instance_id?: string | null;
  review_after?: string | null;
}

export interface ProcessInboxBatchParams {
  item_ids: string[];
  mode: "high-confidence";
}

/** User-confirmed policy plus a managed resume for a blocked Inbox attachment. */
export interface ClassifyInboxAttachmentParams {
  item_id: string;
  sensitivity_class: 0 | 1 | 2 | 3;
  max_representation: "metadata" | "summary" | "full" | "sensitive-original";
}

/** Explicit user acknowledgement before a module may use a partial PDF extraction. */
export interface ReviewPartialInboxExtractionParams {
  item_id: string;
  decision: "approve-extracted-text" | "keep-waiting";
}

/** Preview, explicitly apply, or undo the one-time legacy read_level policy migration. */
export interface LegacyAccessPolicyMigrationParams {
  action: "preview" | "apply" | "rollback";
  preview_id?: string;
  reviewed_paths?: string[];
  confirm?: boolean;
}

export interface GetRunDetailsParams {
  run_id: string;
  developer_mode?: boolean;
}

export interface RollbackRunParams {
  run_id: string;
  confirm?: boolean;
}

export interface ManageModuleParams {
  module_id: string;
  action: "enable" | "disable" | "validate" | "upgrade" | "rollback";
  preview_only?: boolean;
  confirm?: boolean;
  package_path?: string;
}

export interface CreateInstanceParams {
  module_id: string;
  instance_id: string;
  display_name: string;
  fields: JsonObject;
  content_root?: string | null;
  inbox_path?: string | null;
  preview_only?: boolean;
}

export interface ManageInstanceParams {
  instance_id: string;
  action: "activate" | "pause" | "resume" | "complete" | "archive";
  preview_only?: boolean;
  confirm?: boolean;
}
