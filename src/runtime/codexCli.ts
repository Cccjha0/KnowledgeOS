import { spawn, spawnSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PkbError } from "../core/errors.js";

export interface CodexLaunch {
  command: string;
  argsPrefix: string[];
  display: string;
}

export interface CodexModelOption {
  id: string;
  model: string;
  display_name: string;
  description: string;
  supported_reasoning_efforts: string[];
  default_reasoning_effort: string;
  is_default: boolean;
}

const CODEX_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

export function resolveCodexModel(model?: string): string {
  return model?.trim() || process.env.KNOWLEDGEOS_CODEX_MODEL?.trim() || "gpt-5.6-terra";
}

export function resolveCodexReasoningEffort(effort?: string): string {
  const resolved = effort?.trim() || process.env.KNOWLEDGEOS_CODEX_REASONING_EFFORT?.trim() || "low";
  if (!CODEX_REASONING_EFFORTS.has(resolved)) throw new PkbError("INVALID_CODEX_REASONING_EFFORT", `Unsupported Codex reasoning effort: ${resolved}.`);
  return resolved;
}

function codexFailure(stderr: string): PkbError {
  const detailMatches = [...stderr.matchAll(/ERROR:\s*(\{[^\r\n]*"detail"[^\r\n]*\})/g)];
  let message = "Codex invocation failed.";
  const lastDetail = detailMatches.at(-1)?.[1];
  if (lastDetail) {
    try { message = String((JSON.parse(lastDetail) as { detail?: unknown }).detail ?? message); }
    catch { /* use the safe fallback */ }
  } else {
    const useful = stderr.split(/\r?\n/).map((line) => line.trim())
      .filter((line) => /^ERROR:/.test(line) && !/Reconnecting/i.test(line));
    if (useful.length) message = useful.at(-1)!.replace(/^ERROR:\s*/, "").slice(0, 500);
  }
  const normalized = message.toLowerCase();
  if (/model.*(not supported|not found|unavailable|requires a newer version)/.test(normalized)) return new PkbError("CODEX_MODEL_UNAVAILABLE", message);
  if (/auth|unauthorized|login|credential|401|invalid access token/.test(normalized)) return new PkbError("CODEX_AUTHENTICATION_FAILED", message);
  if (/rate.?limit|quota|429/.test(normalized)) return new PkbError("CODEX_RATE_LIMITED", message, { retryable: true });
  if (/timeout|network|connect|socket|dns|econn|stream disconnected/.test(normalized)) return new PkbError("CODEX_CONNECTION_FAILED", message, { retryable: true });
  return new PkbError("CODEX_INVOCATION_FAILED", message);
}

function npmCodexLaunch(): CodexLaunch | null {
  if (process.platform !== "win32") return null;
  const located = spawnSync("where.exe", ["codex.cmd"], { encoding: "utf8", windowsHide: true });
  const candidates = located.status === 0
    ? located.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
    : [];
  for (const directory of [...candidates.map((candidate) => path.dirname(candidate)), path.dirname(process.execPath)]) {
    const script = path.join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(script)) {
      const display = candidates.find((candidate) => path.dirname(candidate).toLowerCase() === directory.toLowerCase()) ?? script;
      return { command: process.execPath, argsPrefix: [script], display };
    }
  }
  return null;
}

export function resolveCodexLaunch(executable = "codex"): CodexLaunch {
  if (executable === "codex") return npmCodexLaunch() ?? { command: executable, argsPrefix: [], display: executable };
  if (process.platform === "win32" && executable.toLowerCase().endsWith(".cmd")) {
    const script = path.join(path.dirname(executable), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(script)) return { command: process.execPath, argsPrefix: [script], display: executable };
  }
  return { command: executable, argsPrefix: [], display: executable };
}

export function probeCodexCli(executable = "codex"): { status: number | null; stdout: string; stderr: string; error?: NodeJS.ErrnoException } {
  const launch = resolveCodexLaunch(executable);
  const result = spawnSync(launch.command, [...launch.argsPrefix, "--version"], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error as NodeJS.ErrnoException | undefined };
}

export async function listCodexModels(executable = "codex", timeoutMs = 20_000): Promise<CodexModelOption[]> {
  const launch = resolveCodexLaunch(executable);
  return new Promise<CodexModelOption[]>((resolve, reject) => {
    const child = spawn(launch.command, [...launch.argsPrefix, "app-server", "--listen", "stdio://"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let requestId = 1;
    const models: CodexModelOption[] = [];
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(models);
    };
    const send = (method: string, params: Record<string, unknown>) => {
      requestId += 1;
      child.stdin.write(`${JSON.stringify({ method, id: requestId, params })}\n`);
    };
    const timer = setTimeout(() => finish(new PkbError("CODEX_MODEL_DISCOVERY_FAILED", "Codex model discovery timed out.", { retryable: true })), timeoutMs);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-8_192); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: { id?: number; result?: unknown; error?: { message?: string } };
        try { message = JSON.parse(line) as typeof message; } catch { continue; }
        if (message.error) { finish(new PkbError("CODEX_MODEL_DISCOVERY_FAILED", message.error.message ?? "Codex rejected model discovery.")); return; }
        if (message.id === 1) {
          send("model/list", { limit: 100, includeHidden: false });
          continue;
        }
        if (message.id !== requestId || !message.result || typeof message.result !== "object") continue;
        const result = message.result as { data?: unknown[]; nextCursor?: string | null };
        for (const raw of result.data ?? []) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
          const model = raw as Record<string, unknown>;
          const id = typeof model.id === "string" ? model.id : typeof model.model === "string" ? model.model : "";
          if (!id) continue;
          const efforts = Array.isArray(model.supportedReasoningEfforts)
            ? model.supportedReasoningEfforts.map((entry) => entry && typeof entry === "object" && !Array.isArray(entry) ? String((entry as Record<string, unknown>).reasoningEffort ?? "") : "").filter(Boolean)
            : [];
          models.push({
            id, model: typeof model.model === "string" ? model.model : id,
            display_name: typeof model.displayName === "string" ? model.displayName : id,
            description: typeof model.description === "string" ? model.description : "",
            supported_reasoning_efforts: efforts,
            default_reasoning_effort: typeof model.defaultReasoningEffort === "string" ? model.defaultReasoningEffort : efforts.includes("medium") ? "medium" : efforts[0] ?? "low",
            is_default: model.isDefault === true,
          });
        }
        if (result.nextCursor) send("model/list", { cursor: result.nextCursor, limit: 100, includeHidden: false });
        else finish();
      }
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (!settled) finish(new PkbError("CODEX_MODEL_DISCOVERY_FAILED", stderr.trim() || `Codex App Server exited with status ${code}.`));
    });
    child.stdin.write(`${JSON.stringify({ method: "initialize", id: 1, params: { clientInfo: { name: "knowledgeos", title: "KnowledgeOS", version: "0.1.0" }, capabilities: { experimentalApi: true } } })}\n`);
  });
}

export async function executeCodexJson(options: {
  vaultRoot: string;
  prompt: string;
  executable?: string;
  model?: string;
  reasoningEffort?: string;
  timeoutMs?: number;
}): Promise<{ output: unknown; stderr: string }> {
  const launch = resolveCodexLaunch(options.executable ?? "codex");
  const model = resolveCodexModel(options.model);
  const reasoningEffort = resolveCodexReasoningEffort(options.reasoningEffort);
  const outputPath = path.join(os.tmpdir(), `knowledgeos-codex-${process.pid}-${Date.now()}.json`);
  const args = [
    ...launch.argsPrefix,
    "exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check",
    "--color", "never", "-m", model,
    "-c", "plugins={}", "-c", `model_reasoning_effort="${reasoningEffort}"`,
    "-C", options.vaultRoot, "-o", outputPath, "-",
  ];
  let stderr = "";
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(launch.command, args, { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
      const timer = setTimeout(() => {
        child.kill();
        reject(new PkbError("CODEX_CONNECTION_FAILED", "Codex processing timed out."));
      }, options.timeoutMs ?? 10 * 60_000);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(codexFailure(stderr || `Codex exited with status ${code}.`));
      });
      child.stdin.end(options.prompt, "utf8");
    });
    const raw = (await fs.readFile(outputPath, "utf8")).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    return { output: JSON.parse(raw), stderr };
  } finally {
    await fs.unlink(outputPath).catch(() => undefined);
  }
}
