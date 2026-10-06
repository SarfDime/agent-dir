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
      if (url.pathname === "/mcp") {
        if (req.method !== "POST") {
          res.setHeader("allow", "POST");
          sendText(res, 405, "Method Not Allowed\n");
          logRequest({
            method: req.method ?? "UNKNOWN",
            path: url.pathname,
            status: 405,
            detail: "method not allowed",
          });
          return;
        }
        const headerError = validateMcpHeaders(request, messageBody(body));
        if (headerError) {
          await sendResponse(res, headerError);
          logRequest({
            method: req.method,
            path: url.pathname,
            status: headerError.status,
            detail: "MCP header validation",
          });
          return;
        }
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
        logRequest({ method: req.method, path: url.pathname, status: 200, detail: "REST GET" });
        return;
      }
      if (req.method === "PUT") {
        await writeFile(root, relative, body.toString("utf8"));
        sendText(res, 200, "File updated successfully\n");
        logRequest({ method: req.method, path: url.pathname, status: 200, detail: "REST PUT" });
        return;
      }
      if (req.method === "DELETE") {
        await deleteFile(root, relative);
        sendText(res, 200, "File deleted successfully\n");
        logRequest({ method: req.method, path: url.pathname, status: 200, detail: "REST DELETE" });
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
      resolve({
        close: () =>
          new Promise<void>((done) => {
            mcp.closeSubscriptions();
            server.close(() => done());
          }),
      }),
    );
  });
}

function messageBody(body: Buffer): Record<string, unknown> | null {
  try {
    const value = JSON.parse(body.toString("utf8")) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function validateMcpHeaders(
  request: Request,
  message: Record<string, unknown> | null,
): Response | undefined {
  const method = typeof message?.method === "string" ? message.method : undefined;
  const isNotification = method !== undefined && !Object.hasOwn(message ?? {}, "id");
  const params =
    typeof message?.params === "object" && message?.params !== null
      ? (message.params as Record<string, unknown>)
      : {};
  const protocolHeader = request.headers.get("mcp-protocol-version");
  const methodHeader = request.headers.get("mcp-method");
  const accept = request.headers.get("accept") ?? "";
  const contentType = request.headers.get("content-type") ?? "";
  const origin = request.headers.get("origin");

  if (isNotification) return undefined;
  if (!contentType.toLowerCase().startsWith("application/json"))
    return jsonRpcErrorForServer(message, -32020, "Content-Type must be application/json.", 400);
  if (
    !accept
      .split(",")
      .map((value) => value.trim().split(";")[0]?.toLowerCase())
      .some((value) => value === "application/json") ||
    !accept
      .split(",")
      .map((value) => value.trim().split(";")[0]?.toLowerCase())
      .some((value) => value === "text/event-stream")
  ) {
    return jsonRpcErrorForServer(
      message,
      -32020,
      "Accept must include application/json and text/event-stream.",
      400,
    );
  }
  if (!protocolHeader)
    return jsonRpcErrorForServer(message, -32020, "MCP-Protocol-Version header is required.", 400);
  const bodyProtocolVersion =
    typeof params._meta === "object" && params._meta !== null
      ? (params._meta as Record<string, unknown>)["io.modelcontextprotocol/protocolVersion"]
      : undefined;
  if (bodyProtocolVersion !== undefined && bodyProtocolVersion !== protocolHeader)
    return jsonRpcErrorForServer(
      message,
      -32020,
      "MCP-Protocol-Version does not match the request metadata.",
      400,
    );
  if (!method || methodHeader !== method)
    return jsonRpcErrorForServer(
      message,
      -32020,
      "Mcp-Method does not match the JSON-RPC method.",
      400,
    );
  if (
    method === "tools/call" ||
    method === "resources/read" ||
    method === "resources/directory/read" ||
    method === "skills/get" ||
    method === "prompts/get"
  ) {
    const bodyName =
      typeof params.name === "string"
        ? params.name
        : typeof params.uri === "string"
          ? params.uri
          : undefined;
    const headerName = request.headers.get("mcp-name");
    const decodedHeaderName = headerName === null ? undefined : decodeMcpHeaderValue(headerName);
    if (!bodyName || decodedHeaderName !== bodyName)
      return jsonRpcErrorForServer(
        message,
        -32020,
        "Mcp-Name does not match the request parameter.",
        400,
      );
  }
  if (origin && origin !== new URL(request.url).origin)
    return jsonRpcErrorForServer(message, -32020, "Invalid Origin.", 403);
  return undefined;
}

function decodeMcpHeaderValue(value: string): string | undefined {
  const prefix = "=?base64?";
  const suffix = "?=";
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return value;
  const encoded = value.slice(prefix.length, -suffix.length);
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64") !== encoded) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

function jsonRpcErrorForServer(
  message: Record<string, unknown> | null,
  code: number,
  text: string,
  status: number,
): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: message?.id ?? null, error: { code, message: text } }),
    {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    },
  );
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
      const files = Array.isArray(args.files)
        ? args.files
            .filter(
              (value): value is Record<string, unknown> =>
                typeof value === "object" && value !== null,
            )
            .map((value) => value.path)
            .filter((value): value is string => typeof value === "string")
        : [];

      switch (name) {
        case "read_files":
        case "delete_files":
          return paths.join(", ");
        case "write_files":
        case "patch_files":
          return files.join(", ");
        case "run_npm_batch": {
          const scripts = Array.isArray(args.scripts)
            ? args.scripts.filter((value): value is string => typeof value === "string")
            : [];
          return scripts.map((script) => `npm run ${script}`).join(", ");
        }
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
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  const onClose = () => {
    void reader.cancel();
  };
  res.once("close", onClose);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch {
    res.destroy();
  } finally {
    res.off("close", onClose);
    reader.releaseLock();
  }
  if (!res.destroyed) res.end();
}
