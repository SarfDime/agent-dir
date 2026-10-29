import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const packageVersion = (require("../../package.json") as { version: string }).version;
const CODEGRAPH_COMMAND = "codegraph";
const REQUEST_TIMEOUT_MS = 120_000;
const PROTOCOL_VERSION = "2025-11-25";
const MAX_MESSAGE_BYTES = 1_000_000;

export type CodeGraphStatus =
  | "not_installed"
  | "not_indexed"
  | "available"
  | "startup_failed"
  | "runtime_failed"
  | "stopped";

export interface CodeGraphCapability {
  status: CodeGraphStatus;
  installed: boolean;
  indexed: boolean;
  tool: "codegraph_explore" | null;
  detail?: string;
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string; data?: unknown };
}

const RECHECK_MS = 30_000;

interface PendingRequest {
  resolve: (message: JsonRpcMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CodeGraphIntegration {
  private readonly root: string;
  private capabilityPromise?: Promise<CodeGraphCapability>;
  private process: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private nextId = 1;
  private initialized = false;
  private closed = false;
  private runtimeFailure: string | undefined;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly retryBaseMs: number;
  private detectedAt = 0;
  private failures = 0;
  private nextRetryAt = 0;
  private lastStatus: string | undefined;
  private lastCapability: CodeGraphCapability | undefined;
  private discarding = false;
  /** Called when availability changes so tool lists can be refreshed and clients notified. */
  onChange: (() => void) | undefined;

  constructor(root: string, options: { retryBaseMs?: number } = {}) {
    this.root = resolve(root);
    this.retryBaseMs = options.retryBaseMs ?? 15_000;
  }

  /** Last known availability for discovery responses; never starts anything. */
  describe(): { status: string; detail?: string; retryInSeconds?: number } {
    const capability = this.lastCapability;
    if (!capability) return { status: "unknown" };
    const failed = capability.status === "startup_failed" || capability.status === "runtime_failed";
    return {
      status: capability.status,
      ...(capability.detail ? { detail: capability.detail } : {}),
      ...(failed
        ? { retryInSeconds: Math.max(0, Math.ceil((this.nextRetryAt - Date.now()) / 1000)) }
        : {}),
    };
  }

  private noteStatus(capability: CodeGraphCapability): void {
    this.lastCapability = capability;
    if (capability.status === this.lastStatus) return;
    this.lastStatus = capability.status;
    this.onChange?.();
  }

  /**
   * Availability is re-checked so setup is picked up (a later `codegraph init`) and a failed
   * process is restarted automatically once its backoff has passed.
   */
  async capability(): Promise<CodeGraphCapability> {
    if (this.capabilityPromise) {
      const current = await this.capabilityPromise;
      const now = Date.now();
      const setupMissing = current.status === "not_installed" || current.status === "not_indexed";
      const failed = current.status === "startup_failed" || current.status === "runtime_failed";
      const stale = setupMissing && now - this.detectedAt >= RECHECK_MS;
      const retry = failed && now >= this.nextRetryAt && !this.closed;
      if (!stale && !retry) {
        this.lastCapability = current;
        return current;
      }
      this.runtimeFailure = undefined;
    }
    this.capabilityPromise = this.detect();
    this.detectedAt = Date.now();
    const detected = await this.capabilityPromise;
    this.noteStatus(detected);
    return detected;
  }

  async prepare(): Promise<CodeGraphCapability> {
    const capability = await this.capability();
    if (capability.status === "available") {
      try {
        await this.ensureStarted();
      } catch {
        // Keep Agent Dir startup available even if CodeGraph fails to start.
      }
    }
    return this.capability();
  }

  async explore(query: string, maxFiles?: number): Promise<Record<string, unknown>> {
    const capability = await this.capability();
    if (capability.status === "not_installed")
      throw new Error("CodeGraph is not installed or the codegraph executable is unavailable.");
    if (capability.status === "not_indexed")
      throw new Error(
        "CodeGraph is not initialized for this project; no usable .codegraph index exists.",
      );
    if (capability.status === "startup_failed" || capability.status === "runtime_failed")
      throw new Error(capability.detail ?? "CodeGraph is unavailable.");
    if (capability.status === "stopped") throw new Error("CodeGraph is stopped.");

    await this.ensureStarted();
    const result = await this.request("tools/call", {
      name: "codegraph_explore",
      arguments: {
        query,
        ...(maxFiles === undefined ? {} : { maxFiles }),
      },
    });
    if (result.error) throw new Error(result.error.message ?? "CodeGraph MCP request failed.");
    if (!result.result) throw new Error("CodeGraph returned a malformed MCP response.");
    return result.result;
  }

  async close(): Promise<void> {
    this.closed = true;
    const child = this.process;
    this.process = undefined;
    this.initialized = false;
    this.rejectPending(new Error("CodeGraph integration closed."));
    if (!child) return;
    child.stdin.end();
    if (!child.killed) child.kill("SIGTERM");
  }

  private async detect(): Promise<CodeGraphCapability> {
    const installed = await this.isInstalled();
    const indexed = await this.hasIndex();
    if (!installed) return { status: "not_installed", installed: false, indexed, tool: null };
    if (!indexed) return { status: "not_indexed", installed: true, indexed: false, tool: null };
    return { status: "available", installed: true, indexed: true, tool: "codegraph_explore" };
  }

  private async hasIndex(): Promise<boolean> {
    try {
      await access(resolve(this.root, ".codegraph", "codegraph.db"), constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async isInstalled(): Promise<boolean> {
    return new Promise((resolveInstalled) => {
      const child = spawn(CODEGRAPH_COMMAND, ["--version"], {
        cwd: this.root,
        stdio: ["ignore", "ignore", "ignore"],
        shell: false,
        env: safeEnvironment(),
      });
      const timer = setTimeout(() => {
        if (!child.killed) child.kill("SIGTERM");
        resolveInstalled(false);
      }, 3_000);
      child.once("error", () => {
        clearTimeout(timer);
        resolveInstalled(false);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolveInstalled(code === 0);
      });
    });
  }

  private async ensureStarted(): Promise<void> {
    if (this.closed) throw new Error("CodeGraph is stopped.");
    if (this.process && this.initialized) return;

    const child = spawn(CODEGRAPH_COMMAND, ["serve", "--mcp", "--path", this.root], {
      cwd: this.root,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: safeEnvironment(),
    });
    this.process = child;
    this.buffer = "";

    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    child.stderr.on("data", () => undefined);
    child.once("error", (error) =>
      this.handleProcessFailure(`CodeGraph failed to start: ${error.message}`),
    );
    child.once("exit", (code, signal) => {
      if (!this.closed && !this.runtimeFailure)
        this.handleProcessFailure(
          "CodeGraph process terminated (" +
            (signal ? `signal ${signal}` : `code ${code ?? 1}`) +
            ").",
        );
    });

    try {
      const initialize = await this.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "agent-dir", version: packageVersion },
      });
      if (initialize.error)
        throw new Error(initialize.error.message ?? "CodeGraph MCP initialization failed.");
      if (!initialize.result)
        throw new Error("CodeGraph returned a malformed initialize response.");

      await this.notify("notifications/initialized");
      const tools = await this.request("tools/list", {});
      if (tools.error) throw new Error(tools.error.message ?? "CodeGraph tools/list failed.");
      const listed = Array.isArray(tools.result?.tools) ? tools.result.tools : [];
      const explore = listed.find(
        (tool): tool is Record<string, unknown> =>
          typeof tool === "object" &&
          tool !== null &&
          (tool as Record<string, unknown>).name === "codegraph_explore",
      );
      if (!explore) throw new Error("CodeGraph does not advertise codegraph_explore.");

      this.initialized = true;
      this.runtimeFailure = undefined;
      this.failures = 0;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.handleProcessFailure(`CodeGraph startup failed: ${detail}`, "startup_failed");
      throw new Error(`CodeGraph startup failed: ${detail}`);
    }
  }

  private request(method: string, params: Record<string, unknown>): Promise<JsonRpcMessage> {
    const child = this.process;
    if (!child || child.killed || child.stdin.destroyed)
      return Promise.reject(new Error("CodeGraph process is not running."));

    const id = this.nextId++;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES)
      return Promise.reject(new Error("CodeGraph MCP request is too large."));

    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`CodeGraph MCP request timed out after ${REQUEST_TIMEOUT_MS}ms.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      child.stdin.write(`${message}\n`, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          rejectRequest(error);
        }
      });
    });
  }

  private async notify(method: string): Promise<void> {
    const child = this.process;
    if (!child || child.killed || child.stdin.destroyed)
      throw new Error("CodeGraph process is not running.");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  private consume(chunk: Buffer): void {
    let text = chunk.toString("utf8");
    if (this.discarding) {
      const newline = text.indexOf("\n");
      if (newline === -1) return;
      this.discarding = false;
      text = text.slice(newline + 1);
    }
    this.buffer += text;
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_MESSAGE_BYTES) {
      // Drop the oversized message and fail only the waiting requests, not the whole process.
      this.buffer = "";
      this.discarding = true;
      this.rejectPending(
        new Error("CodeGraph returned an oversized MCP message; narrow the query."),
      );
      return;
    }

    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as JsonRpcMessage;
        if (message.id === undefined) continue;
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.resolve(message);
      } catch {
        // A stray log line on stdout must not take the integration down.
      }
    }
  }

  private handleProcessFailure(
    detail: string,
    status: "startup_failed" | "runtime_failed" = "runtime_failed",
  ): void {
    this.runtimeFailure = detail;
    this.initialized = false;
    this.rejectPending(new Error(detail));
    const child = this.process;
    this.process = undefined;
    if (child && !child.killed) child.kill("SIGTERM");
    this.failures += 1;
    const delayMs = Math.min(300_000, this.retryBaseMs * 2 ** (this.failures - 1));
    this.nextRetryAt = Date.now() + delayMs;
    const capability: CodeGraphCapability = {
      status,
      installed: true,
      indexed: true,
      tool: "codegraph_explore",
      detail: `${detail} CodeGraph restarts automatically (next attempt in about ${Math.round(delayMs / 1000)} s); use search_code and read_range meanwhile.`,
    };
    this.capabilityPromise = Promise.resolve(capability);
    this.noteStatus(capability);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const keys = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TERM",
    "TMPDIR",
    "TMP",
    "TEMP",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
  ];
  const environment: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}
