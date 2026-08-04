import type { JobDefinition } from "./domain.js";
import { RuntimeRepository } from "./repository.js";

function localParts(date: Date, timezone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function matches(job: JobDefinition, date: Date): { matches: boolean; window: string } {
  const trigger = job.trigger;
  const timezone = String(trigger.timezone ?? "UTC");
  const parts = localParts(date, timezone);
  const window = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}@${timezone}`;
  const type = String(trigger.type);
  const at = String(trigger.at ?? "00:00");
  const [hour, minute] = at.split(":").map(Number);
  if (type !== "cron" && (Number(parts.hour) !== hour || Number(parts.minute) !== minute)) return { matches: false, window };
  if (type === "daily") return { matches: true, window };
  if (type === "weekly") return { matches: String(trigger.weekday ?? "Sun").slice(0, 3) === parts.weekday, window };
  if (type === "monthly") return { matches: Number(parts.day) === Number(trigger.day ?? 1), window };
  if (type === "cron") {
    const fields = String(trigger.expression ?? "").trim().split(/\s+/);
    if (fields.length !== 5) return { matches: false, window };
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday ?? "");
    return { matches: cronField(fields[0]!, Number(parts.minute), 0, 59) && cronField(fields[1]!, Number(parts.hour), 0, 23) && cronField(fields[2]!, Number(parts.day), 1, 31) && cronField(fields[3]!, Number(parts.month), 1, 12) && cronField(fields[4]!, weekday, 0, 6), window };
  }
  return { matches: false, window };
}

function cronField(expression: string, value: number, minimum: number, maximum: number): boolean {
  return expression.split(",").some((part) => {
    const [rangePart, stepText] = part.split("/");
    const step = stepText ? Number(stepText) : 1;
    if (!Number.isInteger(step) || step < 1) return false;
    let start = minimum; let end = maximum;
    if (rangePart !== "*") {
      const bounds = rangePart!.split("-").map(Number);
      start = bounds[0]!; end = bounds.length === 2 ? bounds[1]! : start;
    }
    return Number.isInteger(start) && Number.isInteger(end) && start >= minimum && end <= maximum && start <= value && value <= end && (value - start) % step === 0;
  });
}

function windowsFor(job: JobDefinition, from: Date, to: Date): Array<{ at: Date; window: string }> {
  const output: Array<{ at: Date; window: string }> = [];
  let cursor = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
  const maximum = 60 * 24 * 31;
  for (let count = 0; cursor <= to && count < maximum; count += 1, cursor = new Date(cursor.getTime() + 60_000)) {
    const result = matches(job, cursor);
    if (result.matches) output.push({ at: cursor, window: result.window });
  }
  return output;
}

export async function evaluateScheduler(vaultRoot: string, now = new Date()): Promise<{ created: string[]; deduplicated: number; skipped: number }> {
  const repository = await RuntimeRepository.open(vaultRoot);
  const output = { created: [] as string[], deduplicated: 0, skipped: 0 };
  try {
    const checkpoints = new Map(repository.getCheckpoints().map((item) => [item.job_id, item]));
    for (const job of repository.listJobs().filter((item) => item.enabled && ["daily", "weekly", "monthly", "cron"].includes(String(item.trigger.type)))) {
      const checkpoint = checkpoints.get(job.job_id);
      const from = checkpoint?.last_evaluated_at ? new Date(checkpoint.last_evaluated_at) : new Date(now.getTime() - 60_000);
      let due = windowsFor(job, from, now);
      const policy = String(job.catch_up.policy ?? "none");
      const maxAge = Number(job.catch_up.max_age_days ?? Number.POSITIVE_INFINITY) * 86_400_000;
      if (policy === "skip-if-stale") due = due.filter((entry) => now.getTime() - entry.at.getTime() <= maxAge);
      if (policy === "none") due = due.filter((entry) => now.getTime() - entry.at.getTime() < 120_000);
      if (policy === "latest") due = due.slice(-1);
      if (policy === "all") due = due.slice(-Number(job.catch_up.max_tasks ?? 50));
      const groups = policy === "aggregate" && due.length ? [{ at: due[due.length - 1]!.at, window: due.map((entry) => entry.window).join(",") }] : due;
      for (const entry of groups) {
        const idempotency = `${job.job_id}:${entry.window}`;
        const result = repository.createTask({
          job_id: job.job_id, module: job.module, instance_id: typeof job.trigger.instance_id === "string" ? job.trigger.instance_id : null, task_type: job.task_type, workflow: job.workflow, priority: job.priority,
          scheduled_for: entry.at.toISOString(), resources: job.resources, trigger: { ...job.trigger, window: entry.window },
          catch_up_policy: policy as "none" | "latest" | "all" | "aggregate" | "skip-if-stale", idempotency_key: idempotency,
          max_attempts: Number(job.retry.max_attempts ?? 3), payload: policy === "aggregate" ? { windows: due.map((item) => item.window) } : { window: entry.window },
          concurrency_key: String(job.concurrency.key ?? job.job_id), concurrency_policy: String(job.concurrency.policy ?? "forbid") as "allow" | "forbid" | "replace" | "merge",
        });
        if (result.deduplicated) output.deduplicated += 1; else output.created.push(result.task.task_id);
      }
      output.skipped += Math.max(0, windowsFor(job, from, now).length - groups.length);
      repository.setCheckpoint({ job_id: job.job_id, last_evaluated_at: now.toISOString(), last_created_window: due.at(-1)?.window ?? checkpoint?.last_created_window ?? null, next_evaluation_at: null });
    }
    return output;
  } finally { repository.close(); }
}
