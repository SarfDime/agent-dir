import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const version = (require("../../package.json") as { version: string }).version;
const READ_ONLY = new Set([
  "find_symbol",
  "find_referencing_symbols",
  "find_referencing_code_snippets",
  "get_symbols_overview",
  "search_for_pattern",
  "find_file",
  "list_dir",
]);
const SEMANTIC_WRITE = new Set([
  "rename_symbol",
  "replace_symbol_body",
  "insert_before_symbol",
  "insert_after_symbol",
]);
const ALLOWED_TOOLS = new Set([...READ_ONLY, ...SEMANTIC_WRITE]);
type Message = { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
export type SerenaTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};

export class SerenaIntegration {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private id = 1;
  private started: Promise<SerenaTool[]> | undefined;
  private closed = false;
  private pending = new Map<
    number,
    {
      resolve: (v: Message) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private readonly root: string) {}

  async prepare(): Promise<SerenaTool[]> {
    if (this.started) return this.started;
    this.started = this.start();
    try {
      return await this.started;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      console.error(`[Serena] Startup failed: ${failure.message}`);
      this.fail(failure);
      this.started = undefined;
      return [];
    }
  }

  async call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!ALLOWED_TOOLS.has(name))
      throw new Error(`Serena tool is not allowed through Agent Dir: ${name}`);
    const tools = await this.prepare();
    if (!tools.some((tool) => tool.name === name))
      throw new Error(`Serena tool unavailable: ${name}`);
    const response = await this.request("tools/call", { name, arguments: args });
    if (response.error || !response.result)
      throw new Error(response.error?.message ?? "Malformed Serena response.");
    return response.result;
  }

  async close(): Promise<void> {
    this.closed = true;
    const child = this.child;
    this.child = undefined;
    for (const [id, item] of this.pending) {
      clearTimeout(item.timer);
      item.reject(new Error("Serena stopped."));
      this.pending.delete(id);
    }
    if (child) {
      child.stdin.end();
      if (!child.killed) child.kill("SIGTERM");
    }
  }

  private async start(): Promise<SerenaTool[]> {
    let installed = false;
    await new Promise<void>((done) => {
      const probe = spawn("serena", ["--help"], {
        cwd: this.root,
        stdio: "ignore",
        shell: false,
        env: safeEnvironment(),
      });
      const timer = setTimeout(() => {
        probe.kill("SIGTERM");
        done();
      }, 4000);
      probe.once("error", () => {
        clearTimeout(timer);
        done();
      });
      probe.once("exit", (code) => {
        clearTimeout(timer);
        installed = code === 0;
        done();
      });
    });
    if (!installed) {
      console.error("[Serena] CLI unavailable; skipping Serena tools.");
      return [];
    }
    try {
      await access(resolve(this.root, ".serena", "project.yml"), constants.R_OK);
    } catch {
      console.error("[Serena] .serena/project.yml missing; skipping Serena tools.");
      return [];
    }
    if (process.env.AGENT_DIR_SERENA_AUTO_INDEX !== "0") {
      await this.indexIfNeeded();
    }
    if (this.closed) return [];
    const child = spawn(
      "serena",
      [
        "start-mcp-server",
        "--project",
        resolve(this.root),
        "--context",
        "ide",
        "--agent-interface",
        "tools",
        "--open-web-dashboard",
        "false",
      ],
      {
        cwd: this.root,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        env: safeEnvironment(),
      },
    );
    this.child = child;
    this.buffer = "";
    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    });
    child.once("error", (error) => this.fail(error));
    child.once("exit", () => {
      if (!this.closed) this.fail(new Error("Serena process exited."));
    });
    const init = await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "agent-dir", version },
    });
    if (init.error || !init.result)
      throw new Error(init.error?.message ?? "Serena initialization failed.");
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const list = await this.request("tools/list", {});
    const raw = Array.isArray(list.result?.tools) ? list.result.tools : [];
    const tools = raw.flatMap((item): SerenaTool[] => {
      if (typeof item !== "object" || item === null) return [];
      const value = item as Record<string, unknown>;
      if (typeof value.name !== "string" || !ALLOWED_TOOLS.has(value.name)) return [];
      return [
        {
          name: value.name,
          title: typeof value.title === "string" ? value.title : value.name,
          description:
            typeof value.description === "string"
              ? value.description
              : "Read-only Serena semantic navigation.",
          inputSchema:
            typeof value.inputSchema === "object" && value.inputSchema !== null
              ? (value.inputSchema as Record<string, unknown>)
              : { type: "object", properties: {} },
          ...(typeof value.outputSchema === "object" && value.outputSchema !== null
            ? { outputSchema: value.outputSchema as Record<string, unknown> }
            : {}),
        },
      ];
    });
    if (tools.length === 0) {
      const rawNames = raw.map((item) =>
        typeof item === "object" && item !== null && "name" in item ? String(item.name) : "unnamed",
      );
      console.error(
        `[Serena] Server returned ${raw.length} tools (${rawNames.join(", ")}); none matched the Agent Dir allowlist.${stderr ? ` stderr: ${stderr.trim()}` : ""}`,
      );
    } else {
      console.error(
        `[Serena] Registered ${tools.length} allowlisted tools (read-only navigation and selected semantic edits).`,
      );
    }
    return tools;
  }

  private async indexIfNeeded(): Promise<void> {
    const cacheDirectory = resolve(this.root, ".serena", "cache");
    try {
      const hasSymbolIndex = async (directory: string): Promise<boolean> => {
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && (await hasSymbolIndex(resolve(directory, entry.name)))) {
            return true;
          }
          if (
            entry.isFile() &&
            (entry.name === "document_symbols.pkl" || entry.name === "raw_document_symbols.pkl")
          ) {
            return true;
          }
        }
        return false;
      };
      if (await hasSymbolIndex(cacheDirectory)) {
        console.error("[Serena] Existing symbol index found; skipping initial indexing.");
        return;
      }
    } catch {
      // Missing cache is expected for a new project; let Serena create it.
    }

    console.error("[Serena] No symbol index found; indexing project before startup.");
    await new Promise<void>((done) => {
      const child = spawn("serena", ["project", "index", this.root], {
        cwd: this.root,
        stdio: ["ignore", "inherit", "inherit"],
        shell: false,
        env: safeEnvironment(),
      });
      let settled = false;
      const finish = (success: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (success) console.error("[Serena] Initial indexing completed.");
        else
          console.error("[Serena] Initial indexing failed; continuing without a confirmed index.");
        done();
      };
      const timer = setTimeout(
        () => {
          child.kill("SIGTERM");
          finish(false);
        },
        10 * 60 * 1000,
      );
      child.once("error", () => finish(false));
      child.once("exit", (code) => finish(code === 0));
    });
  }

  private request(method: string, params: Record<string, unknown>): Promise<Message> {
    const child = this.child;
    if (!child || child.killed || child.stdin.destroyed)
      return Promise.reject(new Error("Serena process is not running."));
    const id = this.id++;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Serena request timed out."));
      }, 120_000);
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  private consume(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    if (Buffer.byteLength(this.buffer, "utf8") > 1_000_000) {
      this.fail(new Error("Serena response exceeded 1 MB."));
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line) as Message;
        if (message.id === undefined) continue;
        const item = this.pending.get(message.id);
        if (!item) continue;
        this.pending.delete(message.id);
        clearTimeout(item.timer);
        item.resolve(message);
      } catch {
        this.fail(new Error("Serena returned invalid JSON."));
        return;
      }
    }
  }

  private fail(error: Error): void {
    for (const [id, item] of this.pending) {
      clearTimeout(item.timer);
      item.reject(error);
      this.pending.delete(id);
    }
    const child = this.child;
    this.child = undefined;
    if (child && !child.killed) child.kill("SIGTERM");
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
