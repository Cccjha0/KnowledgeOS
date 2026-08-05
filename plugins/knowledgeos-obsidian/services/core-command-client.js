const { execFile, spawn } = require("node:child_process");

class CoreCommandClient {
  constructor(settings, options = {}) {
    this.settings = settings;
    this.onModulesLoaded = options.onModulesLoaded || (() => {});
    this.missingBuiltCliFailure = options.missingBuiltCliFailure || (() => null);
    this.server = null;
    this.serverKey = null;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.pending = new Map();
  }

  invoke(method, params = {}, requestId = null) {
    if (!this.settings.coreCliPath || !this.settings.vaultPath) {
      return Promise.resolve({ ok: false, state: "failed", error: { message: "尚未配置 Core CLI 或 Vault 路径。", impact: "Today 暂时无法刷新，已有 Markdown 数据不受影响。", recovery_actions: ["打开 KnowledgeOS 设置并填写路径"] } });
    }
    requestId = requestId || `PLUGIN-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    if (this.ensureServer()) {
      return new Promise((resolve) => {
        this.pending.set(requestId, resolve);
        try {
          this.server.stdin.write(`${JSON.stringify({ request_id: requestId, method, params })}\n`, (error) => {
            if (!error) return;
            this.pending.delete(requestId);
            resolve(this.failure(error.message));
          });
        } catch (error) {
          this.pending.delete(requestId);
          resolve(this.failure(error instanceof Error ? error.message : String(error)));
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
      execFile(this.settings.nodePath || "node", args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
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
      this.server = spawn(this.settings.nodePath || "node", [this.settings.coreCliPath, "api-server", "--vault", this.settings.vaultPath], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      this.serverKey = key;
      this.stdoutBuffer = "";
      this.stderrBuffer = "";
      const server = this.server;
      server.stdout.on("data", (chunk) => this.handleServerOutput(String(chunk)));
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

  handleServerOutput(chunk) {
    this.stdoutBuffer += chunk;
    while (this.stdoutBuffer.includes("\n")) {
      const newline = this.stdoutBuffer.indexOf("\n");
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        const response = JSON.parse(line);
        const resolve = this.pending.get(response.request_id);
        if (!resolve) continue;
        this.pending.delete(response.request_id);
        resolve(this.resolveResponse(response));
      } catch { /* Wait for the next valid response; process exit reports malformed output. */ }
    }
  }

  handleServerExit(server, error) {
    if (this.server !== server) return;
    this.server = null;
    this.serverKey = null;
    for (const resolve of this.pending.values()) resolve(this.failure(error.message));
    this.pending.clear();
  }

  failure(message) {
    const buildFailure = this.missingBuiltCliFailure(message, this.settings.coreCliPath);
    if (buildFailure) return { ok: false, state: "failed", error: buildFailure };
    return { ok: false, state: "failed", error: { message, impact: "本次界面操作没有得到 Core 确认。", recovery_actions: ["检查 Core CLI 路径", "在设置页测试连接"] } };
  }

  close() {
    const server = this.server;
    this.server = null;
    this.serverKey = null;
    for (const resolve of this.pending.values()) resolve(this.failure("Core API server is restarting."));
    this.pending.clear();
    if (server && !server.killed) server.stdin.end();
  }
}

module.exports = { CoreCommandClient };
