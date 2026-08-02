import { randomUUID } from "node:crypto";
import path from "node:path";
import { parseMarkdown } from "../core/bridge.js";
import { listFilesRecursive } from "../core/files.js";
import type { JsonObject, JsonValue } from "../core/types.js";
import type { CreateTaskInput, JobDefinition } from "./domain.js";
import { RuntimeRepository } from "./repository.js";

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
    job_id: job.job_id, module: job.module, instance_id: options.instanceId ?? null,
    task_type: job.task_type, workflow: job.workflow, priority: job.priority,
    scheduled_for: options.scheduledFor, available_after: options.scheduledFor,
    resources: job.resources, trigger: options.trigger,
    catch_up_policy: String(job.catch_up.policy ?? "none") as CreateTaskInput["catch_up_policy"],
    idempotency_key: options.idempotency, max_attempts: Number(job.retry.max_attempts ?? 3), payload: options.payload ?? {},
    concurrency_key: String(job.concurrency.key ?? job.job_id),
    concurrency_policy: String(job.concurrency.policy ?? "forbid") as CreateTaskInput["concurrency_policy"],
  };
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

export async function publishRuntimeEvent(vaultRoot: string, event: { type: string; module?: string; instance_id?: string | null; occurred_at?: string; payload?: JsonObject; event_id?: string }): Promise<{ event_id: string; created: string[]; deduplicated: number }> {
  const repository = await RuntimeRepository.open(vaultRoot);
  const eventId = event.event_id ?? `EVT-${randomUUID()}`;
  const occurredAt = event.occurred_at ?? new Date().toISOString();
  const output = { event_id: eventId, created: [] as string[], deduplicated: 0 };
  try {
    for (const job of repository.listJobs().filter((item) => item.enabled && item.trigger.type === "event" && item.trigger.event === event.type)) {
      const result = repository.createTask(taskFor(job, {
        idempotency: `${job.job_id}:event:${eventId}`, trigger: { ...job.trigger, event_id: eventId },
        payload: { event_id: eventId, event_type: event.type, ...(event.payload ?? {}) }, instanceId: event.instance_id,
        scheduledFor: occurredAt,
      }));
      if (result.deduplicated) output.deduplicated += 1; else output.created.push(result.task.task_id);
    }
    repository.recordEvent({ event_id: eventId, event_type: event.type, module: event.module ?? "core", instance_id: event.instance_id ?? null, occurred_at: occurredAt, payload: event.payload ?? {}, tasks_created: output.created });
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
