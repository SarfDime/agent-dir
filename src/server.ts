import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { authenticate, unauthorized } from "./auth.js";
import { logRequest } from "./logging.js";
import { createMcpHandler } from "./mcp.js";
import { deleteFile, listFiles, readFile, writeFile } from "./tools/files.js";
import type { ServerOptions } from "./types.js";

const MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface ServerHandle {
  close: () => Promise<void>;
}

export function startServer({
  root,
  port,
  token,
  commandConfig = {},
}: ServerOptions): Promise<ServerHandle> {
  const mcp = createMcpHandler(root, commandConfig);
  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      const body = await readBody(req);
      const requestInit: RequestInit = {
        method: req.method ?? "GET",
        headers: toFetchHeaders(req.headers),
      };
      if (body.length) requestInit.body = body;
      const request = new Request(url, requestInit);
      if (!authenticate(request, token)) {
        const response = unauthorized();
        await sendResponse(res, response);
        logRequest({
          method: req.method ?? "UNKNOWN",
          path: url.pathname,
          status: 401,
          detail: "unauthorized",
        });
        return;
      }
      if (url.pathname === "/mcp" && req.method === "POST") {
        const response = await mcp(request);
        await sendResponse(res, response);
        const mcpLog = getMcpLog(body);
        logRequest({
          method: req.method,
          path: url.pathname,
          status: response.status,
          detail: mcpLog?.detail ?? "MCP",
          ...(mcpLog ? { tool: mcpLog.name } : {}),
        });
        return;
      }
      if (url.pathname === "/__tree" && req.method === "GET") {
        const tree = await listFiles(root);
        sendText(res, 200, JSON.stringify(tree, null, 2), "application/json; charset=utf-8");
        logRequest({ method: req.method, path: url.pathname, status: 200, detail: "directory" });
        return;
      }
      const relative = decodeURIComponent(url.pathname.slice(1));
      if (!relative) {
        sendText(res, 200, "agent-dir\n");
        logRequest({
          method: req.method ?? "UNKNOWN",
          path: url.pathname,
          status: 200,
          detail: "server",
        });
        return;
      }
      if (req.method === "GET") {
        sendText(res, 200, await readFile(root, relative), "text/plain; charset=utf-8");
        logRequest({ method: req.method, path: url.pathname, status: 200, detail: "read_file" });
        return;
      }
      if (req.method === "PUT") {
        await writeFile(root, relative, body.toString("utf8"));
        sendText(res, 200, "File updated successfully\n");
        logRequest({ method: req.method, path: url.pathname, status: 200, detail: "write_file" });
        return;
      }
      if (req.method === "DELETE") {
        await deleteFile(root, relative);
        sendText(res, 200, "File deleted successfully\n");
        logRequest({ method: req.method, path: url.pathname, status: 200, detail: "delete_file" });
        return;
      }
      sendText(res, 404, "Not found\n");
      logRequest({
        method: req.method ?? "UNKNOWN",
        path: url.pathname,
        status: 404,
        detail: "not found",
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const status = code === "ENOENT" ? 404 : code === "PAYLOAD_TOO_LARGE" ? 413 : 500;
      sendText(res, status, `${error instanceof Error ? error.message : String(error)}\n`);
      logRequest({
        method: req.method ?? "UNKNOWN",
        path: url.pathname,
        status,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve({ close: () => new Promise<void>((done) => server.close(() => done())) }),
    );
  });
}

function getMcpLog(body: Buffer): { name: string; detail: string } | undefined {
  try {
    const message = JSON.parse(body.toString("utf8")) as {
      method?: string;
      params?: {
        name?: unknown;
        arguments?: Record<string, unknown>;
      };
    };
    if (message.method !== "tools/call" || typeof message.params?.name !== "string")
      return undefined;

    const name = message.params.name;
    const args = message.params.arguments ?? {};
    const detail = (() => {
      const paths = Array.isArray(args.paths)
        ? args.paths.filter((value): value is string => typeof value === "string")
        : [];
      const path = typeof args.path === "string" ? args.path : undefined;

      switch (name) {
        case "read_file":
        case "write_file":
        case "patch_file":
        case "delete_file":
          return path ?? "";
        case "read_files":
        case "write_files":
        case "patch_files":
        case "delete_files":
          return paths.join(", ");
        case "run_npm":
          return typeof args.script === "string" ? `npm run ${args.script}` : "";
        case "run_npm_batch": {
          const scripts = Array.isArray(args.scripts)
            ? args.scripts.filter((value): value is string => typeof value === "string")
            : [];
          return scripts.map((script) => `npm run ${script}`).join(", ");
        }
        case "run_command":
          return formatCommand(args.command, args.args);
        case "run_command_batch": {
          const commands = Array.isArray(args.commands) ? args.commands : [];
          return commands
            .filter(
              (value): value is Record<string, unknown> =>
                typeof value === "object" && value !== null,
            )
            .map((command) => formatCommand(command.command, command.args))
            .join("  •  ");
        }
        default:
          return "";
      }
    })();

    return { name, detail };
  } catch {
    return undefined;
  }
}

function formatCommand(command: unknown, args: unknown): string {
  if (typeof command !== "string") return "";
  const extra = Array.isArray(args) ? args.map(String).join(" ") : "";
  return extra ? `${command} ${extra}` : command;
}

function toFetchHeaders(headers: IncomingMessage["headers"]): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) result.set(name, value.join(", "));
    else if (value !== undefined) result.set(name, value);
  }
  return result;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer | string) => {
      if (tooLarge) return;
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (tooLarge) {
        const error = new Error(
          `Request body exceeds the ${MAX_BODY_BYTES / 1024 / 1024} MiB limit.`,
        ) as Error & {
          code?: string;
        };
        error.code = "PAYLOAD_TOO_LARGE";
        reject(error);
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function sendText(
  res: ServerResponse,
  status: number,
  text: string,
  contentType = "text/plain; charset=utf-8",
): void {
  res.statusCode = status;
  res.setHeader("content-type", contentType);
  res.setHeader("cache-control", "no-store");
  res.end(text);
}

async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  res.end(Buffer.from(await response.arrayBuffer()));
}
