import type { JsonObject } from "../core/types.js";

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting-for-network"
  | "waiting-for-ai"
  | "waiting-for-user"
  | "deferred"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskPriority = "critical" | "high" | "normal" | "low";
export type ResourceRequirement = "required" | "not-required";
export type ResourceAvailability = "available" | "unavailable" | "unknown";
export type CatchUpPolicy = "none" | "latest" | "all" | "aggregate" | "skip-if-stale";
export type ConcurrencyPolicy = "allow" | "forbid" | "replace" | "merge";
export type DependencyPolicy = "all-success" | "all-finished" | "any-success";
/** The boundary used when an Event Job consumes a published Event. */
export type EventSubscriptionScope = "instance" | "module" | "global";

export interface TaskResources extends JsonObject {
  filesystem: ResourceRequirement;
  network: ResourceRequirement;
  codex: ResourceRequirement;
  user: ResourceRequirement;
}

export interface JobDefinition extends JsonObject {
  job_id: string;
  source: "core" | "module";
  module: string;
  scope: "core" | "module" | "instance";
  enabled: boolean;
  task_type: "workflow" | "core-operation";
  workflow: string;
  trigger: JsonObject;
  resources: TaskResources;
  catch_up: JsonObject;
  retry: JsonObject;
  concurrency: JsonObject;
  idempotency: JsonObject;
  priority: TaskPriority;
  updated_at: string;
}

export interface RuntimeTask extends JsonObject {
  task_id: string;
  job_id: string;
  module: string;
  instance_id: string | null;
  task_type: "workflow" | "core-operation";
  workflow: string;
  status: TaskStatus;
  priority: TaskPriority;
  scheduled_for: string;
  available_after: string;
  deadline: string | null;
  defer_until: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  resources: TaskResources;
  trigger: JsonObject;
  catch_up_policy: CatchUpPolicy;
  idempotency_key: string;
  max_attempts: number;
  attempt_count: number;
  next_retry_at: string | null;
  payload: JsonObject;
  parent_task_id: string | null;
  dependency_task_ids: string[];
  dependency_policy: DependencyPolicy;
  concurrency_key: string | null;
  concurrency_policy: ConcurrencyPolicy;
  cancel_requested: boolean;
  last_error: RuntimeError | null;
  completion_reason: string | null;
}

export interface RuntimeError extends JsonObject {
  code: string;
  message: string;
  retryable: boolean;
  occurred_at: string;
  details: JsonObject;
}

export interface TaskRun extends JsonObject {
  run_id: string;
  task_id: string;
  attempt_number: number;
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  worker_id: string;
  started_at: string;
  ended_at: string | null;
  heartbeat_at: string;
  resources_checked: JsonObject;
  operation_plan_id: string | null;
  git_snapshot_id: string | null;
  input_files: string[];
  output_files: string[];
  error: RuntimeError | null;
  metrics: JsonObject;
}

export interface ResourceStatus extends JsonObject {
  resource: "filesystem" | "network" | "codex" | "user";
  status: ResourceAvailability;
  reason: string | null;
  checked_at: string;
  details: JsonObject;
}

export interface SchedulerCheckpoint extends JsonObject {
  job_id: string;
  last_evaluated_at: string | null;
  last_created_window: string | null;
  next_evaluation_at: string | null;
}

export const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(["completed", "failed", "cancelled"]);

const TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  queued: new Set(["running", "waiting-for-network", "waiting-for-ai", "waiting-for-user", "deferred", "cancelled"]),
  running: new Set(["queued", "completed", "waiting-for-network", "waiting-for-ai", "waiting-for-user", "deferred", "failed", "cancelled", "interrupted"]),
  "waiting-for-network": new Set(["queued", "cancelled", "failed"]),
  "waiting-for-ai": new Set(["queued", "cancelled", "failed"]),
  "waiting-for-user": new Set(["queued", "completed", "cancelled", "failed"]),
  deferred: new Set(["queued", "cancelled"]),
  interrupted: new Set(["queued", "waiting-for-user", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(["queued", "cancelled"]),
  cancelled: new Set(),
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].has(to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) throw new Error(`Invalid task transition: ${from} -> ${to}`);
}

export interface CreateTaskInput {
  job_id: string;
  module: string;
  instance_id?: string | null;
  task_type: "workflow" | "core-operation";
  workflow: string;
  priority?: TaskPriority;
  scheduled_for?: string;
  available_after?: string;
  deadline?: string | null;
  resources: TaskResources;
  trigger: JsonObject;
  catch_up_policy: CatchUpPolicy;
  idempotency_key: string;
  max_attempts?: number;
  payload?: JsonObject;
  parent_task_id?: string | null;
  dependency_task_ids?: string[];
  dependency_policy?: DependencyPolicy;
  concurrency_key?: string | null;
  concurrency_policy?: ConcurrencyPolicy;
}
