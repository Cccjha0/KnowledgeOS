import { constants, promises as fs } from "node:fs";
import type { JsonObject } from "../core/types.js";
import type { ResourceAvailability, ResourceStatus, RuntimeTask, TaskStatus } from "./domain.js";
import { RuntimeRepository } from "./repository.js";

export interface ResourceGateResult {
  ready: boolean;
  waiting_status: Extract<TaskStatus, "waiting-for-network" | "waiting-for-ai" | "waiting-for-user"> | null;
  checked: JsonObject;
  reason: string | null;
}

async function filesystemAvailability(vaultRoot: string): Promise<ResourceAvailability> {
  try { await fs.access(vaultRoot, constants.R_OK | constants.W_OK); return "available"; }
  catch { return "unavailable"; }
}

export async function evaluateResourceGate(vaultRoot: string, repository: RuntimeRepository, task: RuntimeTask): Promise<ResourceGateResult> {
  const persisted = new Map(repository.getResourceStatuses().map((entry) => [entry.resource, entry]));
  const filesystem = await filesystemAvailability(vaultRoot);
  const checked: JsonObject = {
    filesystem,
    network: persisted.get("network")?.status ?? "unknown",
    codex: persisted.get("codex")?.status ?? "unknown",
    user: task.resources.user === "required" ? "waiting" : "not-required",
  };
  if (task.payload.risk === "red") return { ready: false, waiting_status: "waiting-for-user", checked, reason: "Red-risk tasks require explicit user confirmation." };
  if (task.resources.filesystem === "required" && filesystem !== "available") {
    return { ready: false, waiting_status: "waiting-for-user", checked, reason: "Vault filesystem is unavailable or not writable." };
  }
  if (task.resources.user === "required") return { ready: false, waiting_status: "waiting-for-user", checked, reason: "Task requires user action." };
  if (task.resources.network === "required" && checked.network !== "available") {
    return { ready: false, waiting_status: "waiting-for-network", checked, reason: `Network is ${checked.network}.` };
  }
  if (task.resources.codex === "required" && checked.codex !== "available") {
    return { ready: false, waiting_status: "waiting-for-ai", checked, reason: `Codex is ${checked.codex}.` };
  }
  return { ready: true, waiting_status: null, checked, reason: null };
}

export function updateResourceStatus(repository: RuntimeRepository, status: ResourceStatus): number {
  repository.setResourceStatus(status);
  return status.status === "available" ? repository.wakeResourceTasks(status.resource) : 0;
}
