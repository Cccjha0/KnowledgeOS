import type { VerificationRecord } from "./domain.js";

const DAY = 86_400_000;

export function resolveVerificationInterval(options: { field?: number | null; entity?: number | null; module?: number | null; core?: number | null }): number | null {
  return options.field ?? options.entity ?? options.module ?? options.core ?? null;
}

export function evaluateFreshness(input: { lastVerified: string | null; intervalDays: number | null; historical?: boolean; unverifiable?: boolean; now?: Date; dueSoonRatio?: number }): VerificationRecord {
  if (input.historical) return { last_verified: input.lastVerified, verification_interval_days: null, stale_after: null, stale: false, verification_status: "historical" };
  if (input.unverifiable) return { last_verified: input.lastVerified, verification_interval_days: input.intervalDays, stale_after: null, stale: false, verification_status: "unverifiable" };
  if (!input.lastVerified || !input.intervalDays) return { last_verified: input.lastVerified, verification_interval_days: input.intervalDays, stale_after: null, stale: false, verification_status: "unknown" };
  const verified = Date.parse(input.lastVerified); const now = (input.now ?? new Date()).getTime();
  const staleAt = verified + input.intervalDays * DAY; const ratio = input.dueSoonRatio ?? 0.2;
  const status = now >= staleAt ? "stale" : now >= staleAt - input.intervalDays * DAY * ratio ? "due-soon" : "verified";
  return { last_verified: input.lastVerified, verification_interval_days: input.intervalDays, stale_after: new Date(staleAt).toISOString(), stale: status === "stale", verification_status: status };
}
