import { promises as fs } from "node:fs";
import path from "node:path";
import type { ResourceAvailability, ResourceStatus } from "./domain.js";
import { RuntimeRepository } from "./repository.js";
import { probeCodexCli, resolveCodexLaunch } from "./codexCli.js";

async function filesystemStatus(vaultRoot: string, now: string): Promise<ResourceStatus> {
  const probe = path.join(vaultRoot, "90-System", "State", `.resource-probe-${process.pid}`);
  try {
    await fs.mkdir(path.dirname(probe), { recursive: true });
    await fs.writeFile(probe, "ok", { flag: "wx" }); await fs.unlink(probe);
    return { resource: "filesystem", status: "available", reason: null, checked_at: now, details: { vault: vaultRoot } };
  } catch (error) {
    return { resource: "filesystem", status: "unavailable", reason: "vault-not-writable", checked_at: now, details: { message: error instanceof Error ? error.message : String(error) } };
  }
}

async function networkStatus(now: string, probeUrl?: string): Promise<ResourceStatus> {
  if (!probeUrl) return { resource: "network", status: "unknown", reason: "probe-not-configured", checked_at: now, details: {} };
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(probeUrl, { method: "HEAD", signal: controller.signal });
    return { resource: "network", status: response.ok ? "available" : "unavailable", reason: response.ok ? null : `http-${response.status}`, checked_at: now, details: { probe_url: probeUrl, status: response.status } };
  } catch (error) {
    return { resource: "network", status: "unavailable", reason: "connection-failed", checked_at: now, details: { probe_url: probeUrl, message: error instanceof Error ? error.message : String(error) } };
  } finally { clearTimeout(timer); }
}

function codexStatus(now: string, executable: string): ResourceStatus {
  const result = probeCodexCli(executable);
  if (result.error) return { resource: "codex", status: "unavailable", reason: (result.error as NodeJS.ErrnoException).code === "ENOENT" ? "cli-not-installed" : "cli-launch-failed", checked_at: now, details: { message: result.error.message } };
  if (result.status !== 0) return { resource: "codex", status: "unavailable", reason: "cli-unhealthy", checked_at: now, details: { exit_code: result.status, stderr: result.stderr.trim().slice(0, 500) } };
  return { resource: "codex", status: "available", reason: null, checked_at: now, details: { executable: resolveCodexLaunch(executable).display, version: result.stdout.trim().slice(0, 200), authentication: "not-probed" } };
}

export async function probeRuntimeResources(vaultRoot: string, options: { networkProbeUrl?: string; codexExecutable?: string } = {}): Promise<ResourceStatus[]> {
  const now = new Date().toISOString();
  const statuses = [await filesystemStatus(vaultRoot, now), await networkStatus(now, options.networkProbeUrl), codexStatus(now, options.codexExecutable ?? "codex")];
  const repository = await RuntimeRepository.open(vaultRoot);
  try {
    for (const status of statuses) {
      const previous = repository.getResourceStatuses().find((item) => item.resource === status.resource);
      repository.setResourceStatus(status);
      if (status.status === "available" && previous?.status !== "available") repository.wakeResourceTasks(status.resource);
    }
    return statuses;
  } finally { repository.close(); }
}

export function resourceIsUsable(status: ResourceAvailability): boolean { return status === "available"; }
