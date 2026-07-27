import path from "node:path";
import type { DiscoveredDocument } from "./discovery.js";
import { discoverInstances, discoverModulesForVault } from "./discovery.js";
import { PkbError } from "./errors.js";
import type { JsonObject } from "./types.js";

export type CaptureScope = "global" | "module" | "instance";

export interface CaptureContext {
  scope: CaptureScope;
  moduleId: string | null;
  instanceId: string | null;
  destination: string;
  destinationLabel: string;
  reason: "explicit-instance" | "current-instance" | "explicit-module" | "current-module" | "global-default";
}

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function normalizeVaultPath(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.split("/").includes("..") || /^[A-Za-z]:/.test(normalized)) return null;
  return normalized;
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function enabledModules(modules: DiscoveredDocument[]): Map<string, DiscoveredDocument> {
  return new Map(
    modules.filter((module) => module.data.status === "enabled").map((module) => [String(module.data.id), module]),
  );
}

function instanceInbox(instance: DiscoveredDocument): string {
  if (typeof instance.data.inbox_path === "string") return instance.data.inbox_path;
  return `${String(instance.data.content_root).replace(/\/$/, "")}/Inbox`;
}

function moduleInbox(module: DiscoveredDocument): string {
  const inbox = object(module.data.inbox);
  const moduleLevel = object(inbox?.module_level);
  if (moduleLevel?.enabled !== true || typeof moduleLevel.path !== "string") {
    throw new PkbError("MODULE_INBOX_UNAVAILABLE", `Module ${String(module.data.id)} does not expose a module Inbox.`);
  }
  return moduleLevel.path;
}

export async function inferCaptureContext(options: {
  vaultRoot: string;
  engineRoot: string;
  moduleId?: string | null;
  instanceId?: string | null;
  activePath?: string | null;
}): Promise<CaptureContext> {
  const modules = enabledModules(await discoverModulesForVault(options.engineRoot, options.vaultRoot));
  const instances = await discoverInstances(options.vaultRoot);
  const activeInstances = instances.filter((instance) => instance.data.status === "active" && modules.has(String(instance.data.module_id)));
  const requestedModule = options.moduleId ?? null;
  const requestedInstance = options.instanceId ?? null;

  if (requestedInstance) {
    const instance = instances.find((candidate) => candidate.data.instance_id === requestedInstance);
    if (!instance) throw new PkbError("INSTANCE_NOT_FOUND", `Instance ${requestedInstance} was not found.`);
    const moduleId = String(instance.data.module_id);
    if (!modules.has(moduleId)) throw new PkbError("MODULE_DISABLED", `Module ${moduleId} is disabled.`);
    if (instance.data.status !== "active") throw new PkbError("INSTANCE_NOT_ACTIVE", `Instance ${requestedInstance} is not active.`);
    if (requestedModule && requestedModule !== moduleId) {
      throw new PkbError("CAPTURE_CONTEXT_MISMATCH", `Instance ${requestedInstance} does not belong to module ${requestedModule}.`);
    }
    return {
      scope: "instance", moduleId, instanceId: requestedInstance, destination: instanceInbox(instance),
      destinationLabel: `${String(instance.data.display_name)} Inbox`, reason: "explicit-instance",
    };
  }

  const activePath = normalizeVaultPath(options.activePath);
  if (!requestedModule && activePath) {
    const instance = [...activeInstances]
      .filter((candidate) => typeof candidate.data.content_root === "string" && isWithin(activePath, String(candidate.data.content_root)))
      .sort((a, b) => String(b.data.content_root).length - String(a.data.content_root).length)[0];
    if (instance) {
      return {
        scope: "instance", moduleId: String(instance.data.module_id), instanceId: String(instance.data.instance_id),
        destination: instanceInbox(instance), destinationLabel: `${String(instance.data.display_name)} Inbox`, reason: "current-instance",
      };
    }
  }

  if (requestedModule) {
    const module = modules.get(requestedModule);
    if (!module) throw new PkbError("MODULE_NOT_AVAILABLE", `Enabled module ${requestedModule} was not found.`);
    return {
      scope: "module", moduleId: requestedModule, instanceId: null, destination: moduleInbox(module),
      destinationLabel: `${String(module.data.name)} Inbox`, reason: "explicit-module",
    };
  }

  if (activePath) {
    const module = [...modules.values()].find((candidate) => {
      try {
        const root = path.posix.dirname(moduleInbox(candidate));
        return isWithin(activePath, root);
      } catch {
        return false;
      }
    });
    if (module) {
      const moduleId = String(module.data.id);
      return {
        scope: "module", moduleId, instanceId: null, destination: moduleInbox(module),
        destinationLabel: `${String(module.data.name)} Inbox`, reason: "current-module",
      };
    }
  }

  return {
    scope: "global", moduleId: null, instanceId: null, destination: "00-Inbox",
    destinationLabel: "全局 Inbox", reason: "global-default",
  };
}
