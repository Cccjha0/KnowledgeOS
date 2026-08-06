import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { parseMarkdown } from "../core/bridge.js";
import { listFilesRecursive } from "../core/files.js";
import type { JsonObject, JsonValue } from "../core/types.js";
import type { CreateTaskInput, EventSubscriptionScope, JobDefinition } from "./domain.js";
import { RuntimeRepository } from "./repository.js";
import { PkbError } from "../core/errors.js";

function valueAt(root: JsonObject, dottedPath: string): JsonValue | undefined {
  let current: JsonValue | undefined = root;
  for (const part of dottedPath.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = current[part];
  }
  return current;
}

function taskFor(job: JobDefinition, options: { idempotency: string; trigger: JsonObject; payload?: JsonObject; instanceId?: string | null; scheduledFor?: string }): CreateTaskInput {
  return {
    job_id: job.job_id, module: job.module, instance_id: options.instanceId ?? (typeof job.trigger.instance_id === "string" ? job.trigger.instance_id : null),
    task_type: job.task_type, workflow: job.workflow, priority: job.priority,
    scheduled_for: options.scheduledFor, available_after: options.scheduledFor,
    resources: job.resources, trigger: options.trigger,
    catch_up_policy: String(job.catch_up.policy ?? "none") as CreateTaskInput["catch_up_policy"],
    idempotency_key: options.idempotency, max_attempts: Number(job.retry.max_attempts ?? 3), payload: options.payload ?? {},
    concurrency_key: String(job.concurrency.key ?? job.job_id),
    concurrency_policy: String(job.concurrency.policy ?? "forbid") as CreateTaskInput["concurrency_policy"],
  };
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
  return JSON.stringify(value);
}

const EVENT_PAYLOAD_FIELDS = new Set(["entity_id", "file_ref", "field_name", "change_type", "run_id", "evidence_id"]);
const EVENT_PAYLOAD_ALIASES: Record<string, string> = {
  capture_id: "entity_id", review_id: "entity_id", request_id: "entity_id", report_id: "entity_id", summary_id: "entity_id", daily_id: "entity_id", source_item_id: "entity_id", id: "entity_id", period: "entity_id",
  path: "file_ref", source_path: "file_ref", source_file: "file_ref", file_path: "file_ref",
  status: "change_type", action: "change_type",
};

export type EventPayload = JsonObject;

/** Event Store payloads are identifiers only; document bodies never cross this boundary. */
export function minimizeEventPayload(input: JsonObject = {}): EventPayload {
  const output: EventPayload = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = EVENT_PAYLOAD_FIELDS.has(rawKey) ? rawKey : EVENT_PAYLOAD_ALIASES[rawKey];
    if (!key || output[key] !== undefined || typeof rawValue !== "string" || !rawValue.trim()) continue;
    output[key] = rawValue.trim().slice(0, 512);
  }
  return output;
}

export function eventFingerprint(event: { type: string; module?: string; instance_id?: string | null; payload?: JsonObject }): string {
  return createHash("sha256").update(canonicalJson({
    event_type: event.type, source_module: event.module ?? "core", instance_id: event.instance_id ?? null, payload: minimizeEventPayload(event.payload ?? {}),
  }), "utf8").digest("hex");
}

interface EventSubscriptionSource {
  type: string;
  module: string;
  instanceId: string | null;
}

function subscriptionScope(job: JobDefinition): EventSubscriptionScope {
  const declared = job.trigger.subscription_scope;
  if (declared === "instance" || declared === "module" || declared === "global") return declared;
  // Compatibility is deliberately conservative: instance Jobs remain isolated,
  // while older module/core Jobs can only see events from their own module.
  return job.scope === "instance" ? "instance" : "module";
}

function consumerInstanceId(job: JobDefinition): string | null {
  return typeof job.trigger.instance_id === "string" ? job.trigger.instance_id : null;
}

export function resolveEventSubscriptions(jobs: JobDefinition[], event: EventSubscriptionSource): JobDefinition[] {
  return jobs.filter((job) => {
    if (!job.enabled || job.trigger.type !== "event") return false;
    const subscribed = job.trigger.event ?? job.trigger.event_type ?? job.trigger.source;
    if (subscribed !== event.type) return false;
    const scope = subscriptionScope(job);
    if (scope === "global") return true;
    if (job.module !== event.module) return false;
    return scope === "module" || (consumerInstanceId(job) !== null && consumerInstanceId(job) === event.instanceId);
  });
}

function localDateWindow(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}@${timezone}`;
}

function startupWindow(job: JobDefinition, startupId: string, now: Date): string {
  if (job.trigger.dedupe !== "daily") return startupId;
  return localDateWindow(now, String(job.trigger.timezone ?? "UTC"));
}

export async function materializeStartupJobs(vaultRoot: string, startupId: string = randomUUID(), now = new Date()): Promise<{ created: string[]; deduplicated: number }> {
  const repository = await RuntimeRepository.open(vaultRoot);
  const output = { created: [] as string[], deduplicated: 0 };
  try {
    for (const job of repository.listJobs().filter((item) => item.enabled && item.trigger.type === "startup")) {
      const window = startupWindow(job, startupId, now);
      const result = repository.createTask(taskFor(job, {
        idempotency: `${job.job_id}:startup:${window}`, trigger: { ...job.trigger, startup_id: startupId, window },
        payload: { startup_id: startupId, window }, scheduledFor: now.toISOString(),
      }));
      if (result.deduplicated) output.deduplicated += 1; else output.created.push(result.task.task_id);
    }
    return output;
  } finally { repository.close(); }
}

export async function publishRuntimeEvent(vaultRoot: string, event: { type: string; module?: string; instance_id?: string | null; occurred_at?: string; payload?: JsonObject; event_id?: string; fingerprint?: string }): Promise<{ event_id: string; created: string[]; deduplicated: number; event_deduplicated: boolean }> {
  const repository = await RuntimeRepository.open(vaultRoot);
  const eventId = event.event_id ?? `EVT-${randomUUID()}`;
  const occurredAt = event.occurred_at ?? new Date().toISOString();
  const payload = minimizeEventPayload(event.payload ?? {});
  const fingerprint = event.fingerprint ?? eventFingerprint({ ...event, payload });
  const output = { event_id: eventId, created: [] as string[], deduplicated: 0, event_deduplicated: false };
  try {
    const stored = repository.recordEvent({ event_id: eventId, event_type: event.type, module: event.module ?? "core", instance_id: event.instance_id ?? null, occurred_at: occurredAt, payload, fingerprint });
    if (!stored.created) {
      output.event_deduplicated = true;
      output.event_id = String(stored.event.event_id);
      output.deduplicated = 1;
      return output;
    }
    const delivered = deliverEventSubscriptions(repository, {
      eventId, eventType: event.type, eventFingerprint: fingerprint, sourceModule: event.module ?? "core", instanceId: event.instance_id ?? null,
      occurredAt, payload, jobs: resolveEventSubscriptions(repository.listJobs(), { type: event.type, module: event.module ?? "core", instanceId: event.instance_id ?? null }),
    });
    output.created.push(...delivered.created); output.deduplicated += delivered.deduplicated;
    const status = delivered.failed === 0 ? "published" : delivered.created.length + delivered.deduplicated > 0 ? "partial" : "dead-letter";
    repository.completeEvent(eventId, output.created, status, delivered.failed ? { code: "EVENT_DELIVERY_FAILED", message: `${delivered.failed} subscription delivery failure(s).` } : null);
    return output;
  } catch (error) {
    repository.failEvent(eventId, { code: "EVENT_DISPATCH_FAILED", message: error instanceof Error ? error.message : String(error) });
    throw new PkbError("EVENT_DISPATCH_FAILED", `Event ${event.type} was persisted to the dead-letter queue.`, { event_id: eventId, fingerprint });
  } finally { repository.close(); }
}

function errorRecord(error: unknown): JsonObject {
  return { code: error instanceof PkbError ? error.code : "EVENT_DELIVERY_FAILED", message: error instanceof Error ? error.message : String(error) };
}

function deliverEventSubscriptions(repository: RuntimeRepository, options: { eventId: string; eventType: string; eventFingerprint: string; sourceModule: string; instanceId: string | null; occurredAt: string; payload: JsonObject; jobs: JobDefinition[]; subscriptionKeys?: Set<string> }): { created: string[]; deduplicated: number; failed: number } {
  const output = { created: [] as string[], deduplicated: 0, failed: 0 };
  for (const job of options.jobs) {
    const subscriptionKey = job.job_id;
    if (options.subscriptionKeys && !options.subscriptionKeys.has(subscriptionKey)) continue;
    repository.recordEventDelivery(options.eventId, subscriptionKey, job.job_id);
    try {
      const scope = subscriptionScope(job);
      const consumerInstance = consumerInstanceId(job);
      const result = repository.createTask(taskFor(job, {
        idempotency: `${job.job_id}:event:${options.eventFingerprint}`, trigger: {
          ...job.trigger, event_id: options.eventId, event_fingerprint: options.eventFingerprint,
          event_source_module: options.sourceModule, event_source_instance_id: options.instanceId,
          event_subscription_scope: scope, event_consumer_instance_id: consumerInstance,
        },
        payload: { event_id: options.eventId, event_type: options.eventType, event_source_module: options.sourceModule, ...(options.instanceId ? { event_source_instance_id: options.instanceId } : {}), ...options.payload }, instanceId: consumerInstance,
        scheduledFor: options.occurredAt,
      }));
      if (result.deduplicated) output.deduplicated += 1; else output.created.push(result.task.task_id);
      repository.finishEventDelivery(options.eventId, subscriptionKey, result.deduplicated ? "deduplicated" : "created", result.task.task_id);
    } catch (error) {
      output.failed += 1;
      repository.finishEventDelivery(options.eventId, subscriptionKey, "failed", null, errorRecord(error));
    }
  }
  return output;
}

/** Re-deliver failed subscriptions, or rebuild the Delivery Ledger when dispatch failed before any ledger row existed. */
export async function replayRuntimeEvent(vaultRoot: string, eventId: string, subscriptionKeys?: string[]): Promise<{ event_id: string; created: string[]; requeued: string[]; deduplicated: number; failed: number }> {
  const repository = await RuntimeRepository.open(vaultRoot);
  try {
    const event = repository.getEvent(eventId);
    if (!event) throw new PkbError("EVENT_NOT_FOUND", `Event ${eventId} was not found.`);
    const requested = subscriptionKeys ? new Set(subscriptionKeys) : undefined;
    const allDeliveries = repository.listEventDeliveries(eventId);
    const deliveries = allDeliveries.filter((delivery) => delivery.status === "failed" && (!requested || requested.has(String(delivery.subscription_key))));
    const output = { event_id: eventId, created: [] as string[], requeued: [] as string[], deduplicated: 0, failed: 0 };
    const sourceModule = String(event.module ?? "core");
    const sourceInstanceId = typeof event.instance_id === "string" ? event.instance_id : null;
    const jobs = resolveEventSubscriptions(repository.listJobs(), { type: String(event.event_type), module: sourceModule, instanceId: sourceInstanceId });
    const jobsById = new Map(jobs.map((job) => [job.job_id, job]));
    const pendingJobs: JobDefinition[] = [];
    for (const delivery of deliveries) {
      const taskId = typeof delivery.task_id === "string" ? delivery.task_id : null;
      if (taskId) {
        const task = repository.getTask(taskId);
        if (task && ["failed", "waiting-for-network", "waiting-for-ai", "waiting-for-user", "deferred", "interrupted"].includes(task.status)) {
          repository.retryTask(taskId); repository.finishEventDelivery(eventId, String(delivery.subscription_key), "requeued", taskId); output.requeued.push(taskId);
          continue;
        }
      }
      const job = jobsById.get(String(delivery.job_id));
      if (!job) { output.failed += 1; repository.finishEventDelivery(eventId, String(delivery.subscription_key), "failed", null, { code: "EVENT_SUBSCRIPTION_MISSING", message: `Job ${String(delivery.job_id)} is no longer registered.` }); }
      else pendingJobs.push(job);
    }
    // An event can reach dead-letter between Event Store persistence and the
    // first delivery record. Re-resolve today's subscriptions and seed fresh
    // ledger rows instead of leaving that event unrecoverable.
    const deliveredKeys = new Set(allDeliveries.map((delivery) => String(delivery.subscription_key)));
    for (const job of jobs) {
      if (requested && !requested.has(job.job_id)) continue;
      if (!deliveredKeys.has(job.job_id)) pendingJobs.push(job);
    }
    const dispatched = deliverEventSubscriptions(repository, {
      eventId, eventType: String(event.event_type), eventFingerprint: String(event.fingerprint), sourceModule, instanceId: sourceInstanceId,
      occurredAt: String(event.occurred_at), payload: (event.payload && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload : {}) as JsonObject,
      jobs: pendingJobs, subscriptionKeys: requested,
    });
    output.created.push(...dispatched.created); output.deduplicated += dispatched.deduplicated; output.failed += dispatched.failed;
    const remainingFailed = repository.listEventDeliveries(eventId).filter((delivery) => delivery.status === "failed").length;
    const totalDelivered = repository.listEventDeliveries(eventId).filter((delivery) => ["created", "deduplicated", "requeued"].includes(String(delivery.status))).length;
    repository.completeEvent(eventId, [...(Array.isArray(event.tasks_created) ? event.tasks_created.filter((task): task is string => typeof task === "string") : []), ...output.created], remainingFailed ? totalDelivered ? "partial" : "dead-letter" : "published", remainingFailed ? { code: "EVENT_DELIVERY_FAILED", message: `${remainingFailed} subscription delivery failure(s) remain.` } : null);
    return output;
  } finally { repository.close(); }
}

export async function materializeFieldDueJobs(vaultRoot: string, now = new Date()): Promise<{ created: string[]; deduplicated: number; checked: number }> {
  const repository = await RuntimeRepository.open(vaultRoot);
  const output = { created: [] as string[], deduplicated: 0, checked: 0 };
  try {
    for (const job of repository.listJobs().filter((item) => item.enabled && item.trigger.type === "field-due")) {
      const sourceRoot = String(job.trigger.source_root ?? "");
      const field = String(job.trigger.field ?? "");
      if (!sourceRoot || !field) continue;
      const absoluteRoot = path.resolve(vaultRoot, ...sourceRoot.split("/"));
      if (!absoluteRoot.startsWith(path.resolve(vaultRoot) + path.sep)) continue;
      for (const file of (await listFilesRecursive(absoluteRoot)).filter((item) => item.toLowerCase().endsWith(".md"))) {
        output.checked += 1;
        const parsed = parseMarkdown(vaultRoot, file);
        const due = valueAt(parsed.data, field);
        if (typeof due !== "string" || !Number.isFinite(Date.parse(due)) || Date.parse(due) > now.getTime()) continue;
        const relative = path.relative(vaultRoot, file).replaceAll(path.sep, "/");
        const entityId = String(valueAt(parsed.data, String(job.trigger.id_field ?? "instance_id")) ?? relative);
        const window = due.slice(0, 10);
        const result = repository.createTask(taskFor(job, {
          idempotency: `${job.job_id}:${entityId}:${window}`, trigger: { ...job.trigger, source_file: relative, due_at: due },
          payload: { source_file: relative, field, due_at: due, entity_id: entityId }, instanceId: entityId, scheduledFor: due,
        }));
        if (result.deduplicated) output.deduplicated += 1; else output.created.push(result.task.task_id);
      }
    }
    return output;
  } finally { repository.close(); }
}

export async function enqueueManualTask(vaultRoot: string, jobId: string, payload: JsonObject = {}, force = false): Promise<{ task_id: string; deduplicated: boolean }> {
  const repository = await RuntimeRepository.open(vaultRoot);
  try {
    const job = repository.listJobs().find((item) => item.job_id === jobId && item.enabled);
    if (!job) throw new Error(`Enabled job ${jobId} was not found.`);
    if (!force) {
      const active = repository.listTasks().find((item) => item.job_id === jobId && !["completed", "failed", "cancelled"].includes(item.status));
      if (active) return { task_id: active.task_id, deduplicated: true };
    }
    const requestedAt = new Date().toISOString();
    const key = `${jobId}:manual:${randomUUID()}`;
    const input = taskFor(job, { idempotency: key, trigger: { type: "manual", requested_at: requestedAt }, payload, scheduledFor: requestedAt });
    if (force) { input.concurrency_key = `${jobId}:forced:${randomUUID()}`; input.concurrency_policy = "allow"; }
    const result = repository.createTask(input);
    return { task_id: result.task.task_id, deduplicated: result.deduplicated };
  } finally { repository.close(); }
}
