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
  | "rollbackRun";

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
  decision: ReviewDecisionKind;
  user_comment?: string;
  review_after?: string | null;
  modified_value?: JsonValue;
}
