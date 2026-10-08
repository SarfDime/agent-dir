import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { authenticate, unauthorized } from "./auth.js";
import { logRequest } from "./logging.js";
import { createMcpHandler } from "./mcp.js";
import { TelemetryRecorder } from "./telemetry/recorder.js";
import { deleteFile, listFiles, readFile, writeFile } from "./tools/files.js";
import type { ServerOptions } from "./types.js";

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const REQUEST_BODY_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 120_000;
const HEADERS_TIMEOUT_MS = 30_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
const HEALTH_PATH = "/__health";

export interface ServerHandle {
  close: () => Promise<void>;
}

export function startServer({
  root,
  port,
  token,
  commandConfig = {},
  telemetry = { level: "none" },
}: ServerOptions): Promise<ServerHandle> {
  const mcp = createMcpHandler(root, commandConfig, telemetry);
  const httpTelemetry = new TelemetryRecorder({
    level: telemetry.level,
    persist: telemetry.persist ?? false,
    ...(telemetry.configId ? { configId: telemetry.configId } : {}),
    sessionId: `http-${Date.now()}`,
  });
  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const startedAt = performance.now();
    const requestController = new AbortController();
    req.once("aborted", () => requestController.abort());
    res.once("close", () => {
      if (!res.writableFinished) requestController.abort();
    });
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    let authenticated = false;
    try {
      const body = await readBody(req, requestController.signal);
      const requestInit: RequestInit = {
        method: req.method ?? "GET",
        headers: toFetchHeaders(req.headers),
        signal: requestController.signal,
      };
      if (body.length) requestInit.body = body;
      const request = new Request(url, requestInit);
      authenticated = authenticate(request, token);
      if (!authenticated) {
        const response = unauthorized();
        await sendResponse(res, response);
        logRequest({
          method: req.method ?? "UNKNOWN",
          path: url.pathname,
          status: 401,
          detail: "unauthorized",
        });
        recordHttpTelemetry(
          httpTelemetry,
          req.method ?? "UNKNOWN",
          url.pathname,
          401,
          authenticated,
          startedAt,
        );
        return;
      }
      if (url.pathname === HEALTH_PATH && req.method === "HEAD") {
        sendText(res, 200, "ok\n");
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
          recordHttpTelemetry(
            httpTelemetry,
            req.method ?? "UNKNOWN",
            url.pathname,
            405,
            authenticated,
            startedAt,
          );
          return;
        }
        const headerError = validateMcpHeaders(request, messageBody(body));
        if (headerError) {
          const errorDetail = await getResponseErrorDetail(headerError);
          await sendResponse(res, headerError);
          logRequest({
            method: req.method,
            path: url.pathname,
            status: headerError.status,
            detail: errorDetail ? `MCP header validation: ${errorDetail}` : "MCP header validation",
          });
          recordHttpTelemetry(
            httpTelemetry,
            req.method,
            url.pathname,
            headerError.status,
            authenticated,
            startedAt,
          );
          return;
        }
        const response = await mcp(request);
        const errorDetail = await getResponseErrorDetail(response);
        await sendResponse(res, response);
        const mcpLog = getMcpLog(body);
        const mcpErrorContext =
          response.status >= 400 ? getMcpErrorContext(body, request) : undefined;
        logRequest({
          method: req.method,
          path: url.pathname,
          status: response.status,
          detail: errorDetail
            ? `MCP error: ${errorDetail}${mcpErrorContext ? `\n${mcpErrorContext}` : ""}`
            : (mcpLog?.detail ?? "MCP"),
          ...(mcpLog ? { tool: mcpLog.name } : {}),
        });
        recordHttpTelemetry(
          httpTelemetry,
          req.method,
          url.pathname,
          response.status,
          authenticated,
          startedAt,
        );
        return;
      }
      if (url.pathname === "/__tree" && req.method === "GET") {
        const tree = await listFiles(root);
        sendText(res, 200, JSON.stringify(tree, null, 2), "application/json; charset=utf-8");
        logRequest({ method: req.method, path: url.pathname, status: 200, detail: "directory" });
        recordHttpTelemetry(httpTelemetry, req.method, url.pathname, 200, authenticated, startedAt);
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
        recordHttpTelemetry(
          httpTelemetry,
          req.method ?? "UNKNOWN",
          url.pathname,
          200,
          authenticated,
          startedAt,
        );
        return;
      }
      if (req.method === "GET") {
        sendText(res, 200, await readFile(root, relative), "text/plain; charset=utf-8");
        logRequest({ method: req.method, path: url.pathname, status: 200, detail: "REST GET" });
        recordHttpTelemetry(httpTelemetry, req.method, url.pathname, 200, authenticated, startedAt);
        return;
      }
      if (req.method === "PUT") {
        await writeFile(root, relative, body.toString("utf8"));
        sendText(res, 200, "File updated successfully\n");
        logRequest({ method: req.method, path: url.pathname, status: 200, detail: "REST PUT" });
        recordHttpTelemetry(httpTelemetry, req.method, url.pathname, 200, authenticated, startedAt);
        return;
      }
      if (req.method === "DELETE") {
        await deleteFile(root, relative);
        sendText(res, 200, "File deleted successfully\n");
        logRequest({
          method: req.method,
          path: url.pathname,
          status: 200,
          detail: "REST DELETE",
        });
        recordHttpTelemetry(httpTelemetry, req.method, url.pathname, 200, authenticated, startedAt);
        return;
      }
      sendText(res, 404, "Not found\n");
      logRequest({
        method: req.method ?? "UNKNOWN",
        path: url.pathname,
        status: 404,
        detail: "not found",
      });
      recordHttpTelemetry(
        httpTelemetry,
        req.method ?? "UNKNOWN",
        url.pathname,
        404,
        authenticated,
        startedAt,
      );
    } catch (error) {
      if (requestController.signal.aborted || res.destroyed) return;
      const code = (error as NodeJS.ErrnoException).code;
      const status =
        code === "ENOENT"
          ? 404
          : code === "PAYLOAD_TOO_LARGE"
            ? 413
            : code === "REQUEST_TIMEOUT"
              ? 408
              : 500;
      sendText(res, status, `${error instanceof Error ? error.message : String(error)}\n`);
      logRequest({
        method: req.method ?? "UNKNOWN",
        path: url.pathname,
        status,
        detail: error instanceof Error ? error.message : String(error),
      });
      recordHttpTelemetry(
        httpTelemetry,
        req.method ?? "UNKNOWN",
        url.pathname,
        status,
        authenticated,
        startedAt,
      );
    }
  });

  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;

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
  const bodyProtocolVersion =
    typeof params._meta === "object" && params._meta !== null
      ? (params._meta as Record<string, unknown>)["io.modelcontextprotocol/protocolVersion"]
      : undefined;
  if (
    protocolHeader !== null &&
    bodyProtocolVersion !== undefined &&
    bodyProtocolVersion !== protocolHeader
  )
    return jsonRpcErrorForServer(
      message,
      -32020,
      "MCP-Protocol-Version does not match the request metadata.",
      400,
    );
  if (methodHeader !== null && (!method || methodHeader !== method))
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
    if (headerName !== null && (!bodyName || decodedHeaderName !== bodyName))
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

function getMcpErrorContext(body: Buffer, request: Request): string | undefined {
  try {
    const message = JSON.parse(body.toString("utf8")) as {
      id?: string | number | null;
      method?: unknown;
      params?: unknown;
    };
    const params = isRecordValue(message.params) ? message.params : undefined;
    const meta = params && isRecordValue(params._meta) ? params._meta : undefined;
    const parts = [
      typeof message.method === "string" ? `method       : ${message.method}` : undefined,
      message.id !== undefined ? `id           : ${String(message.id)}` : undefined,
      params ? "params       : present" : "params       : missing",
      params ? `params keys  : ${Object.keys(params).sort().join(", ") || "(none)"}` : undefined,
      meta ? "params._meta  : present" : "params._meta  : missing",
      meta && typeof meta["io.modelcontextprotocol/protocolVersion"] === "string"
        ? `protocol     : ${meta["io.modelcontextprotocol/protocolVersion"]}`
        : meta
          ? "protocol     : missing"
          : undefined,
      meta && isRecordValue(meta["io.modelcontextprotocol/clientCapabilities"])
        ? "capabilities : present"
        : meta
          ? "capabilities : missing"
          : undefined,
      request.headers.get("mcp-protocol-version")
        ? `header       : MCP-Protocol-Version=${request.headers.get("mcp-protocol-version")}`
        : "header       : MCP-Protocol-Version=missing",
    ].filter((value): value is string => value !== undefined);
    return parts.join("\n");
  } catch {
    return undefined;
  }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function getResponseErrorDetail(response: Response): Promise<string | undefined> {
  if (response.status < 400) return undefined;
  try {
    const body = (await response.clone().json()) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    if (typeof body.error === "object" && body.error !== null) {
      const message = body.error.message;
      if (typeof message === "string") return message;
    }
    if (typeof body.message === "string") return body.message;
    if (typeof body.error === "string") return body.error;
  } catch {
    // Keep logging the status even when the error response is not JSON.
  }
  return undefined;
}

export function getMcpLog(body: Buffer): { name: string; detail: string } | undefined {
  try {
    const message = JSON.parse(body.toString("utf8")) as {
      method?: string;
      params?: Record<string, unknown>;
    };
    if (typeof message.method !== "string") return undefined;

    if (message.method !== "tools/call") {
      return { name: message.method, detail: getMcpMethodDetail(message.method, message.params) };
    }
    if (typeof message.params?.name !== "string")
      return { name: message.method, detail: "tool name missing" };

    const name = message.params.name;
    const args = isRecordValue(message.params.arguments) ? message.params.arguments : {};
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
        case "list_files":
          return "all project files";
        case "list_dirs":
          return paths.join(", ");
        case "read_range": {
          const path = typeof args.path === "string" ? args.path : "";
          const startLine = typeof args.startLine === "number" ? args.startLine : undefined;
          const endLine = typeof args.endLine === "number" ? args.endLine : undefined;
          return path && startLine !== undefined && endLine !== undefined
            ? `${path}:${startLine}-${endLine}`
            : path;
        }
        case "read_files":
        case "delete_files":
        case "git_stage":
        case "git_unstage":
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
        case "search_files":
        case "search_code": {
          const query = typeof args.query === "string" ? args.query : "";
          const maxResults = typeof args.maxResults === "number" ? args.maxResults : undefined;
          const regex = args.regex === true ? "regex" : undefined;
          const options = [regex, maxResults !== undefined ? `max ${maxResults}` : undefined]
            .filter(Boolean)
            .join(", ");
          return options ? `${query} (${options})` : query;
        }
        case "find_files": {
          const pattern = typeof args.pattern === "string" ? args.pattern : "";
          const maxResults = typeof args.maxResults === "number" ? args.maxResults : undefined;
          return maxResults !== undefined ? `${pattern} (max ${maxResults})` : pattern;
        }
        case "find_symbol": {
          const symbol = typeof args.symbol === "string" ? args.symbol : "";
          const maxResults = typeof args.maxResults === "number" ? args.maxResults : undefined;
          return symbol
            ? maxResults !== undefined
              ? `symbol: ${symbol} (max ${maxResults})`
              : `symbol: ${symbol}`
            : "";
        }
        case "find_definition": {
          const symbol = typeof args.symbol === "string" ? args.symbol : "";
          const maxResults = typeof args.maxResults === "number" ? args.maxResults : undefined;
          return symbol
            ? maxResults !== undefined
              ? `definition: ${symbol} (max ${maxResults})`
              : `definition: ${symbol}`
            : "";
        }
        case "find_references": {
          const symbol = typeof args.symbol === "string" ? args.symbol : "";
          const maxResults = typeof args.maxResults === "number" ? args.maxResults : undefined;
          return symbol
            ? maxResults !== undefined
              ? `references: ${symbol} (max ${maxResults})`
              : `references: ${symbol}`
            : "";
        }
        case "git_commit":
          return "commit (message omitted)";
        case "find_imports": {
          const maxResults = typeof args.maxResults === "number" ? args.maxResults : undefined;
          return maxResults !== undefined ? `all imports (max ${maxResults})` : "all imports";
        }
        case "find_exports": {
          const maxResults = typeof args.maxResults === "number" ? args.maxResults : undefined;
          return maxResults !== undefined ? `all exports (max ${maxResults})` : "all exports";
        }
        case "diagnostics": {
          const maxResults = typeof args.maxResults === "number" ? args.maxResults : undefined;
          return maxResults !== undefined ? `max ${maxResults}` : "";
        }
        case "git_restore":
          return paths.join(", ");
        case "git_push":
          return "push (remote/branch omitted)";
        case "git_diff": {
          const staged = args.staged === true ? "staged" : "working tree";
          const path = typeof args.path === "string" ? args.path : "";
          return path ? `${staged}: ${path}` : staged;
        }
        case "git_log": {
          const limit = typeof args.limit === "number" ? args.limit : 20;
          const path = typeof args.path === "string" ? args.path : "";
          return path ? `last ${limit}: ${path}` : `last ${limit}`;
        }
        case "file_info":
          return typeof args.path === "string" ? args.path : "";
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

function getMcpMethodDetail(method: string, params: Record<string, unknown> | undefined): string {
  const value = params ?? {};
  const capabilities = isRecordValue(value.capabilities)
    ? Object.keys(value.capabilities).sort()
    : [];
  const clientInfo = isRecordValue(value.clientInfo) ? value.clientInfo : undefined;
  const clientName = typeof clientInfo?.name === "string" ? clientInfo.name : undefined;
  const clientVersion = typeof clientInfo?.version === "string" ? clientInfo.version : undefined;
  const protocol =
    typeof value.protocolVersion === "string"
      ? value.protocolVersion
      : isRecordValue(value._meta) &&
          typeof value._meta["io.modelcontextprotocol/protocolVersion"] === "string"
        ? value._meta["io.modelcontextprotocol/protocolVersion"]
        : undefined;

  switch (method) {
    case "initialize": {
      const client = clientName
        ? clientVersion
          ? `${clientName} v${clientVersion}`
          : clientName
        : undefined;
      return (
        [
          protocol ? `protocol: ${protocol}` : undefined,
          client ? `client: ${client}` : undefined,
          capabilities.length ? `capabilities: ${capabilities.join(", ")}` : undefined,
        ]
          .filter((part): part is string => Boolean(part))
          .join(" • ") || "initialization handshake"
      );
    }
    case "notifications/initialized":
      return "initialization complete";
    case "tools/list":
      return "list tools";
    case "resources/list":
      return "list resources";
    case "resources/templates/list":
      return "list resource templates";
    case "prompts/list":
      return "list prompts";
    case "skills/list":
      return typeof value.cursor === "string" ? `cursor: ${value.cursor}` : "list skills";
    case "server/discover":
      return "discover server capabilities";
    case "ping":
      return "health check";
    case "subscriptions/listen": {
      const notifications = isRecordValue(value.notifications) ? value.notifications : undefined;
      const resourceSubscriptions = Array.isArray(notifications?.resourceSubscriptions)
        ? notifications.resourceSubscriptions.length
        : 0;
      const parts = [
        notifications?.resourcesListChanged === true ? "resources list changes" : undefined,
        resourceSubscriptions
          ? `${resourceSubscriptions} resource subscription${resourceSubscriptions === 1 ? "" : "s"}`
          : undefined,
      ].filter((part): part is string => Boolean(part));
      return parts.length ? parts.join(" • ") : "listen for notifications";
    }
    default: {
      const keys = Object.keys(value)
        .filter((key) => key !== "_meta")
        .sort();
      return keys.length ? `params: ${keys.join(", ")}` : "no parameters";
    }
  }
}

function formatCommand(command: unknown, args: unknown): string {
  if (typeof command !== "string") return "";
  const count = Array.isArray(args) ? args.length : 0;
  return count ? `${command} (args: ${count})` : command;
}

function recordHttpTelemetry(
  recorder: TelemetryRecorder,
  method: string,
  pathname: string,
  status: number,
  authenticated: boolean,
  startedAt: number,
): void {
  const route =
    pathname === "/mcp"
      ? "mcp"
      : pathname === "/__tree"
        ? "tree"
        : pathname === "/"
          ? "root"
          : pathname.startsWith("/") && pathname.length > 1
            ? "file"
            : "other";
  recorder.record({
    event: "http_request",
    method,
    route,
    status,
    success: status < 400,
    durationMs: performance.now() - startedAt,
    authenticated,
  });
}

function toFetchHeaders(headers: IncomingMessage["headers"]): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) result.set(name, value.join(", "));
    else if (value !== undefined) result.set(name, value);
  }
  return result;
}

function readBody(req: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    let settled = false;
    const timer = setTimeout(() => {
      const error = new Error(
        `Request body timed out after ${REQUEST_BODY_TIMEOUT_MS / 1000}s.`,
      ) as Error & {
        code?: string;
      };
      error.code = "REQUEST_TIMEOUT";
      finish(error);
    }, REQUEST_BODY_TIMEOUT_MS);

    const cleanup = (): void => {
      clearTimeout(timer);
      req.removeListener("aborted", onAborted);
      req.removeListener("error", onError);
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      signal.removeEventListener("abort", onSignalAbort);
    };

    const finish = (error?: Error, value?: Buffer): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value ?? Buffer.alloc(0));
    };

    const onAborted = (): void => finish(new Error("Request aborted by the client."));
    const onError = (error: Error): void => finish(error);
    const onSignalAbort = (): void => finish(new Error("Request aborted by the client."));
    const onData = (chunk: Buffer | string): void => {
      if (tooLarge) return;
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      if (tooLarge) {
        const error = new Error(
          `Request body exceeds the ${MAX_BODY_BYTES / 1024 / 1024} MiB limit.`,
        ) as Error & {
          code?: string;
        };
        error.code = "PAYLOAD_TOO_LARGE";
        finish(error);
        return;
      }
      finish(undefined, Buffer.concat(chunks));
    };

    if (signal.aborted) {
      onSignalAbort();
      return;
    }
    req.once("aborted", onAborted);
    req.once("error", onError);
    signal.addEventListener("abort", onSignalAbort, { once: true });
    req.on("data", onData);
    req.on("end", onEnd);
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
