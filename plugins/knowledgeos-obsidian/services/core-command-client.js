const { execFile, spawn } = require("node:child_process");

const MUTATING_METHODS = new Set([
  "createCapture", "processInboxItem", "processInboxBatch", "resolveReview", "rollbackRun", "manageModule", "createInstance",
  "manageInstance", "manageTask", "enqueueTask", "runTaskCycle", "manageQualityIssue", "runQualityAudit", "updateAssetAccessPolicy",
  "classifyInboxAttachment", "reviewPartialInboxExtraction", "migrateLegacyAccessPolicies", "backfillQualityMetadata",
  "saveModuleBuilderGapReport", "saveExtensionDesignDraft", "createModuleFromBlueprint", "runModuleReadinessAction",
]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

class CoreCommandClient {
  constructor(settings, options = {}) {
    this.settings = settings;
    this.onModulesLoaded = options.onModulesLoaded || (() => {});
    this.missingBuiltCliFailure = options.missingBuiltCliFailure || (() => null);
    this.execFile = options.execFile || execFile;
    this.spawn = options.spawn || spawn;
    this.requestTimeoutMs = Number.isFinite(options.requestTimeoutMs)
      ? Math.max(1, options.requestTimeoutMs)
      : 20_000;
    this.server = null;
    this.serverKey = null;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.pending = new Map();
    this.operations = new Map();
    this.inFlightReads = new Map();
  }

  invoke(method, params = {}, requestId = null, options = {}) {
    if (!this.settings.coreCliPath || !this.settings.vaultPath) {
      return Promise.resolve({ ok: false, state: "failed", error: { message: "尚未配置 Core CLI 或 Vault 路径。", impact: "Today 暂时无法刷新，已有 Markdown 数据不受影响。", recovery_actions: ["打开 KnowledgeOS 设置并填写路径"] } });
    }
    const mutation = MUTATING_METHODS.has(method);
    if (mutation) return this.invokeRequest(method, params, requestId, options, true);
    const readKey = `${method}:${canonicalJson(params)}`;
    const existingRead = this.inFlightReads.get(readKey);
    if (existingRead) return existingRead;
    const request = this.invokeRequest(method, params, requestId, options, false);
    const tracked = Promise.resolve(request).then(
      (response) => { if (this.inFlightReads.get(readKey) === tracked) this.inFlightReads.delete(readKey); return response; },
      (error) => { if (this.inFlightReads.get(readKey) === tracked) this.inFlightReads.delete(readKey); throw error; },
    );
    this.inFlightReads.set(readKey, tracked);
    return tracked;
  }

  invokeRequest(method, params, requestId, options, mutation) {
    const serverReady = this.ensureServer();
    const operationKey = mutation ? JSON.stringify([method, params]) : null;
    const existing = operationKey ? this.operations.get(operationKey) : null;
    if (existing && existing.expiresAt > Date.now()) {
      if (existing.response) return Promise.resolve(existing.response);
      return Promise.resolve(this.running(existing.requestId, method));
    }
    requestId = requestId || `PLUGIN-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    if (operationKey) this.operations.set(operationKey, { requestId, response: null, expiresAt: Date.now() + 5 * 60_000 });
    if (serverReady) {
      return new Promise((resolve) => {
        const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : mutation ? Math.max(this.requestTimeoutMs, 120_000) : this.requestTimeoutMs;
        const timeout = setTimeout(() => {
          if (mutation) {
            const pending = this.pending.get(requestId);
            if (pending) { pending.uiResolved = true; resolve(this.running(requestId, method)); }
          } else this.resolvePending(requestId, this.failure("Core API request timed out."));
        }, timeoutMs);
        this.pending.set(requestId, { resolve, timeout, method, operationKey, uiResolved: false });
        try {
          this.server.stdin.write(`${JSON.stringify({ request_id: requestId, method, params, deadline_at: new Date(Date.now() + timeoutMs).toISOString() })}\n`, (error) => {
            if (!error) return;
            this.resolvePending(requestId, this.failure(error.message));
          });
        } catch (error) {
          this.resolvePending(requestId, this.failure(error instanceof Error ? error.message : String(error)));
        }
      });
    }
    return this.invokeOnce(method, params, requestId);
  }

  resolveResponse(response) {
    if (response?.ok && Array.isArray(response.data)) this.onModulesLoaded(response.data);
    return response;
  }

  invokeOnce(method, params, requestId) {
    const args = [this.settings.coreCliPath, "api", method, "--vault", this.settings.vaultPath, "--request-id", requestId, "--input", JSON.stringify(params)];
    return new Promise((resolve) => {
      this.execFile(this.settings.nodePath || "node", args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
        try { resolve(this.resolveResponse(JSON.parse(stdout))); }
        catch {
          resolve({ ok: false, state: "failed", error: { message: error?.message || "Core 返回了无法解析的结果。", impact: "本次界面操作没有得到 Core 确认。", recovery_actions: ["检查 Core CLI 路径", "在设置页测试连接"] } });
        }
      });
    });
  }

  ensureServer() {
    const key = JSON.stringify([this.settings.nodePath || "node", this.settings.coreCliPath, this.settings.vaultPath]);
    if (this.server && this.serverKey === key && !this.server.killed) return true;
    this.close();
    try {
      this.server = this.spawn(this.settings.nodePath || "node", [this.settings.coreCliPath, "api-server", "--vault", this.settings.vaultPath], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      this.serverKey = key;
      this.stdoutBuffer = "";
      this.stderrBuffer = "";
      const server = this.server;
      server.stdout.on("data", (chunk) => this.handleServerOutput(server, String(chunk)));
      server.stderr.on("data", (chunk) => { this.stderrBuffer = `${this.stderrBuffer}${String(chunk)}`.slice(-4096); });
      server.on("error", (error) => this.handleServerExit(server, error));
      server.on("exit", (code) => this.handleServerExit(server, new Error(this.stderrBuffer || `Core API server exited with status ${code}.`)));
      return true;
    } catch {
      this.server = null;
      this.serverKey = null;
      return false;
    }
  }

  handleServerOutput(server, chunk) {
    if (this.server !== server) return;
    this.stdoutBuffer += chunk;
    while (this.stdoutBuffer.includes("\n")) {
      const newline = this.stdoutBuffer.indexOf("\n");
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        const response = JSON.parse(line);
        this.resolvePending(response.request_id, this.resolveResponse(response));
      } catch {
        this.handleServerExit(server, new Error("Core API server returned malformed JSON."));
        if (!server.killed) server.stdin.end();
        return;
      }
    }
  }

  resolvePending(requestId, response) {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    clearTimeout(pending.timeout);
    if (pending.operationKey) this.operations.set(pending.operationKey, { requestId, response, expiresAt: Date.now() + 60_000 });
    if (!pending.uiResolved) pending.resolve(response);
    return true;
  }

  resolveAllPending(response) {
    for (const { resolve, timeout } of this.pending.values()) {
      clearTimeout(timeout);
      resolve(response);
    }
    this.pending.clear();
  }

  handleServerExit(server, error) {
    if (this.server !== server) return;
    this.server = null;
    this.serverKey = null;
    this.resolveAllPending(this.failure(error.message));
  }

  failure(message) {
    const buildFailure = this.missingBuiltCliFailure(message, this.settings.coreCliPath);
    if (buildFailure) return { ok: false, state: "failed", error: buildFailure };
    return { ok: false, state: "failed", error: { message, impact: "本次界面操作没有得到 Core 确认。", recovery_actions: ["检查 Core CLI 路径", "在设置页测试连接"] } };
  }

  running(requestId, method) {
    return { request_id: requestId, method, ok: false, state: "running", error: {
      code: "CORE_REQUEST_STILL_RUNNING", message: "Core is still processing this operation.",
      impact: "The operation was not submitted again. Refresh the related view to see its final state.",
      recovery_actions: ["Wait for Core to finish", "Refresh the related view"], retryable: false,
    } };
  }

  close() {
    const server = this.server;
    this.server = null;
    this.serverKey = null;
    this.resolveAllPending(this.failure("Core API server is restarting."));
    this.operations.clear();
    this.inFlightReads.clear();
    if (server && !server.killed) server.stdin.end();
  }
}

module.exports = { CoreCommandClient };
