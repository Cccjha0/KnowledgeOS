export interface PerformanceDiagnosticsSnapshot {
  python_subprocesses: number;
  files_discovered: number;
  markdown_parse_requests: number;
  markdown_files_parsed: number;
  yaml_parse_requests: number;
  schema_validations: number;
  parse_cache_hits: number;
  parse_cache_misses: number;
  parse_cache_evictions: number;
}

const EMPTY: PerformanceDiagnosticsSnapshot = {
  python_subprocesses: 0,
  files_discovered: 0,
  markdown_parse_requests: 0,
  markdown_files_parsed: 0,
  yaml_parse_requests: 0,
  schema_validations: 0,
  parse_cache_hits: 0,
  parse_cache_misses: 0,
  parse_cache_evictions: 0,
};

let enabled = false;
let counters: PerformanceDiagnosticsSnapshot = { ...EMPTY };

export function enablePerformanceDiagnostics(value = true): void { enabled = value; }

export function incrementPerformanceDiagnostic(
  key: keyof PerformanceDiagnosticsSnapshot,
  amount = 1,
): void {
  if (enabled) counters[key] += amount;
}

export function resetPerformanceDiagnostics(): void { counters = { ...EMPTY }; }

export function performanceDiagnosticsSnapshot(): PerformanceDiagnosticsSnapshot {
  return { ...counters };
}
