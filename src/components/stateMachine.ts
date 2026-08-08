import { parseMarkdown } from "../core/bridge.js";
import { PkbError } from "../core/errors.js";
import { exists, fromVaultPath } from "../core/files.js";
import type { JsonObject, JsonValue } from "../core/types.js";

export interface StateMachineDefinition {
  initial: string;
  transitions: Record<string, string[]>;
}

export interface StateTransitionResult extends JsonObject {
  current_status: string | null;
  next_status: string;
  transition: "initial" | "unchanged" | "advanced";
}

function object(value: JsonValue | undefined, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PkbError("STATE_MACHINE_INVALID", `${label} must be an object.`);
  return value as JsonObject;
}

function state(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new PkbError("STATE_MACHINE_STATUS_INVALID", `${label} must be a non-empty state.`);
  return value;
}

export function validateStateTransition(machine: StateMachineDefinition, currentStatus: JsonValue | undefined, nextStatus: JsonValue | undefined): StateTransitionResult {
  const initial = state(machine.initial, "lifecycle.initial");
  const next = state(nextStatus, "next status");
  const transitions = machine.transitions;
  if (!Object.prototype.hasOwnProperty.call(transitions, initial)) throw new PkbError("STATE_MACHINE_INVALID", `Initial state ${initial} has no transition definition.`);
  if (!Object.prototype.hasOwnProperty.call(transitions, next)) throw new PkbError("STATE_MACHINE_STATE_UNKNOWN", `State ${next} is not declared by this lifecycle.`);
  if (currentStatus === undefined || currentStatus === null) {
    if (next !== initial) throw new PkbError("STATE_INITIAL_INVALID", `New records must begin in ${initial}, not ${next}.`, { initial, next_status: next });
    return { current_status: null, next_status: next, transition: "initial" };
  }
  const current = state(currentStatus, "current status");
  if (!Object.prototype.hasOwnProperty.call(transitions, current)) throw new PkbError("STATE_MACHINE_STATE_UNKNOWN", `Current state ${current} is not declared by this lifecycle.`);
  if (current === next) return { current_status: current, next_status: next, transition: "unchanged" };
  if (!transitions[current]!.includes(next)) {
    throw new PkbError("STATE_TRANSITION_DENIED", `Lifecycle does not permit ${current} → ${next}.`, { current_status: current, next_status: next, allowed: transitions[current] });
  }
  return { current_status: current, next_status: next, transition: "advanced" };
}

export async function validateStateTransitionForDocument(input: {
  vaultRoot: string;
  target: string;
  proposed: JsonObject;
  statusField: string;
  lifecycle: StateMachineDefinition;
}): Promise<StateTransitionResult> {
  const file = fromVaultPath(input.vaultRoot, input.target);
  const existing = await exists(file) ? parseMarkdown(input.vaultRoot, file).data : null;
  return validateStateTransition(input.lifecycle, existing?.[input.statusField], input.proposed[input.statusField]);
}
