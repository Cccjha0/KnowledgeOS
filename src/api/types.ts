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
  | "createCapture"
  | "listInboxItems"
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
  | "manageInstance";

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

export type InboxAction = "preview" | "process" | "route" | "retry" | "defer" | "ignore" | "unmanage";

export interface ProcessInboxItemParams {
  item_id: string;
  action?: InboxAction;
  module_id?: string | null;
  instance_id?: string | null;
  review_after?: string | null;
}

export interface ProcessInboxBatchParams {
  item_ids: string[];
  mode: "high-confidence";
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
  action: "enable" | "disable" | "validate";
  preview_only?: boolean;
  confirm?: boolean;
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
