import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { hostname, release, userInfo } from "node:os";
import type { CodeGraphCapability } from "./codegraph.js";
import { CodeGraphIntegration } from "./codegraph.js";
import type { SerenaTool } from "./serena.js";
import { SerenaIntegration } from "./serena.js";
import { summarizeTelemetry } from "./telemetry/aggregate.js";
import {
  fingerprintInput,
  telemetryHmac,
  usePersistentTelemetryKey,
} from "./telemetry/fingerprint.js";
import { TelemetryRecorder } from "./telemetry/recorder.js";
import { readTelemetryEvents } from "./telemetry/storage.js";
import type { TelemetryConfig, TelemetryLevel } from "./telemetry/types.js";
import { isAstGrepAvailable, runAstGrep } from "./tools/astgrep.js";
import { type BatchOnError, runBatch } from "./tools/batch.js";
import { findFiles, findReferences, findSymbol, searchCode } from "./tools/code.js";
import { checkCommand, spawnCapture } from "./tools/commands.js";
import { diagnostics } from "./tools/diagnostics.js";
import { applyFileChanges, readFile, readRange } from "./tools/files.js";
import { fileInfo, projectOverview } from "./tools/metadata.js";
import {
  packageScriptCapture,
  packageScriptLabel,
  packageScriptProblem,
  runPackageScript,
} from "./tools/package-scripts.js";
import type { CommandPolicyConfig } from "./tools/policy.js";
import type { PathProtectionConfig } from "./tools/protected-paths.js";

import {
  getSkill,
  invalidateSkillDiscoveryCache,
  listSkillResources,
  listSkills,
  readSkillDirectory,
  readSkillResource,
  skillResourceUrisForPath,
} from "./tools/skills.js";
import type { CommandConfig } from "./types.js";

const require = createRequire(import.meta.url);
const packageVersion = (require("../../package.json") as { version: string }).version;
const PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION];
const SERVER_INFO = { name: "agent-dir", version: packageVersion };
const SERVER_INFO_META = { "io.modelcontextprotocol/serverInfo": SERVER_INFO };
const PROTOCOL_META = "io.modelcontextprotocol/protocolVersion";
const PAGE_SIZE = 50;
const DISCOVERY_CACHE_TTL_MS = 300_000;
const DEFAULT_OUTPUT_BYTES = 8_000;
const INSTRUCTIONS_URI = "agent-dir://instructions";
const CAPABILITIES_URI = "agent-dir://capabilities";
const SUBSCRIPTION_ID_META = "io.modelcontextprotocol/subscriptionId";

interface Subscription {
  id: string | number | null | undefined;
  controller: ReadableStreamDefaultController<Uint8Array>;
  notifications: {
    toolsListChanged: boolean;
    promptsListChanged: boolean;
    resourcesListChanged: boolean;
    resourceSubscriptions: Set<string>;
  };
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}
interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

const stringSchema = { type: "string" };
const pathSchema = { type: "string", description: "Path relative to the exposed project root." };
const objectOutput = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
});
const arrayOutput = (items: Record<string, unknown>): Record<string, unknown> => ({
  type: "array",
  items,
});
const searchMatchSchema = objectOutput(
  {
    path: stringSchema,
    line: { type: "integer" },
    column: { type: "integer" },
    text: stringSchema,
  },
  ["path", "line", "column", "text"],
);
const batchItemSchema = objectOutput(
  {
    index: { type: "integer" },
    command: { type: "string" },
    status: { type: "string", enum: ["success", "failure", "skipped"] },
    reason: { type: "string" },
    ran: { type: "boolean" },
    exitCode: { type: "integer" },
    durationMs: { type: "number" },
    stdout: { type: "string" },
    stderr: { type: "string" },
    outputTruncated: { type: "boolean" },
  },
  ["index", "command", "status", "ran"],
);
const batchResultSchema = objectOutput(
  {
    ok: { type: "boolean" },
    onError: { type: "string", enum: ["continue", "stop"] },
    summary: objectOutput(
      {
        total: { type: "integer" },
        success: { type: "integer" },
        failure: { type: "integer" },
        skipped: { type: "integer" },
      },
      ["total", "success", "failure", "skipped"],
    ),
    items: arrayOutput(batchItemSchema),
    truncated: { type: "boolean" },
  },
  ["ok", "onError", "summary", "items", "truncated"],
);
const timeoutMsSchema = {
  type: "integer",
  minimum: 1000,
  maximum: 600000,
  default: 120000,
  description: "Timeout per item in milliseconds. A timed-out item fails with its partial output.",
};
const onErrorSchema = {
  type: "string",
  enum: ["continue", "stop"],
  description:
    "What to do after an item fails. Every item always reports status success, failure or skipped (with a reason), so you never have to guess whether it ran.",
};

const codeGraphTool: ToolDefinition = tool(
  "codegraph_explore",
  "Use first for most non-trivial code-understanding tasks: explain behavior, trace call/data flow, map symbol relationships, or assess change impact. Prefer this over repeated grep/read loops for structural questions. Use search_code/find_symbol/read_range for exact-text lookup and targeted follow-up. Treat returned source as read; avoid re-verifying without a concrete gap. Output is capped; large responses return a preview.",
  {
    query: { type: "string", minLength: 1 },
    maxFiles: { type: "integer", minimum: 1, maximum: 100, default: 10 },
    maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
  },
  { type: "object" },
  ["query"],
);

const astGrepTool: ToolDefinition = tool(
  "ast_grep_search",
  "Search code structurally using ast-grep patterns rather than plain text. Use for syntax-aware matching; prefer codegraph_explore for call/data flow and impact analysis, and search_code for exact text or regex.",
  {
    pattern: { type: "string", minLength: 1, maxLength: 2000 },
    lang: { type: "string", maxLength: 32 },
    globs: { type: "array", items: stringSchema, maxItems: 20 },
    context: { type: "integer", minimum: 0, maximum: 5, default: 0 },
    maxResults: { type: "integer", minimum: 1, maximum: 500, default: 100 },
    maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
  },
  { type: "object", additionalProperties: true },
  ["pattern"],
);

const baseTools: ToolDefinition[] = [
  tool(
    "read_range",
    "Read a bounded line range from one UTF-8 project file.",
    {
      path: pathSchema,
      startLine: { type: "integer", minimum: 1 },
      endLine: { type: "integer", minimum: 1 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
    },
    objectOutput(
      {
        path: stringSchema,
        startLine: { type: "integer" },
        endLine: { type: "integer" },
        content: stringSchema,
        truncated: { type: "boolean" },
      },
      ["path", "startLine", "endLine", "content"],
    ),
    ["path", "startLine", "endLine"],
  ),
  tool(
    "apply_changes",
    "Atomically apply related writes, exact patches, and deletes. Returns only per-file status; never returns file contents or diffs. Use dryRun=true to preview changes.",
    {
      dryRun: { type: "boolean", default: false },
      changes: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["write", "patch", "delete"] },
            path: pathSchema,
            content: stringSchema,
            patches: {
              type: "array",
              items: objectOutput(
                {
                  search: stringSchema,
                  replace: stringSchema,
                  count: { type: "integer", minimum: 1 },
                },
                ["search", "replace"],
              ),
              minItems: 1,
            },
          },
          required: ["kind", "path"],
          additionalProperties: false,
        },
      },
    },
    arrayOutput(
      objectOutput(
        {
          kind: { type: "string", enum: ["write", "patch", "delete"] },
          path: stringSchema,
          changed: { type: "boolean" },
          dryRun: { type: "boolean" },
        },
        ["kind", "path", "changed"],
      ),
    ),
    ["changes"],
  ),
  tool(
    "find_files",
    "Find project paths by a simple glob pattern using * and ?. Returns {items, truncated}; use this for targeted filename discovery.",
    {
      pattern: stringSchema,
      maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
    },
    objectOutput({ items: arrayOutput(stringSchema), truncated: { type: "boolean" } }, [
      "items",
      "truncated",
    ]),
    ["pattern"],
  ),
  tool(
    "search_code",
    "Search source files by text or regex within an 8 KB default budget. Binary files and files over 1 MB are skipped; start narrow and expand only when needed.",
    {
      query: stringSchema,
      regex: { type: "boolean", default: false },
      maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
    },
    arrayOutput(searchMatchSchema),
    ["query"],
  ),
  tool(
    "find_symbol",
    "Find symbol definitions and locations. Use read_range for source context and find_references to trace usage.",
    {
      symbol: stringSchema,
      maxResults: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
    },
    arrayOutput(
      objectOutput(
        {
          ...(searchMatchSchema.properties as Record<string, unknown>),
          symbol: stringSchema,
          kind: stringSchema,
        },
        ["path", "line", "column", "text", "symbol", "kind"],
      ),
    ),
    ["symbol"],
  ),
  tool(
    "find_references",
    "Find source-code references to a symbol. Use this instead of searching entire files when tracing usage of a known symbol.",
    {
      symbol: stringSchema,
      maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
    },
    arrayOutput(searchMatchSchema),
    ["symbol"],
  ),
  tool(
    "project_context",
    "Return a compact LLM-oriented project snapshot combining project overview, package metadata, and active execution policy. Prefer this over separate orientation calls.",
    {
      maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
    },
    { type: "object", additionalProperties: true },
  ),
  tool(
    "validate",
    "Run a unified project validation pass: lightweight diagnostics first, then explicitly requested allowed package scripts. Use level=diagnostics for cheap checks and request scripts only when executable validation is needed.",
    {
      level: { type: "string", enum: ["diagnostics", "scripts", "full"], default: "diagnostics" },
      scripts: { type: "array", items: stringSchema, minItems: 1, maxItems: 10 },
      maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
    },
    { type: "object", additionalProperties: true },
  ),
  tool(
    "file_info",
    "Return filesystem metadata for a project path.",
    { path: pathSchema },
    { type: "object", additionalProperties: true },
    ["path"],
  ),
  tool(
    "run_package_scripts_batch",
    "Run one or more explicitly allowed package scripts sequentially. Prefer the narrowest relevant script and avoid running full check/test when a targeted check answers the question. Default onError is stop: later scripts are reported as skipped after a failure. The whole batch is validated before anything runs.",
    {
      scripts: { type: "array", items: stringSchema, minItems: 1, maxItems: 10 },
      onError: onErrorSchema,
      timeoutMs: timeoutMsSchema,
      maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
    },
    batchResultSchema,
    ["scripts"],
  ),
  tool(
    "run_command_batch",
    "Run one or more explicitly allowed commands sequentially without a shell. Prefer dedicated Agent Dir tools over generic commands because they return structured, bounded results with less token overhead. Default onError is continue, so independent inspection commands still run after one fails. Use okExitCodes (for example [0, 1] for rg or grep) when a non-zero exit is a normal outcome.",
    {
      commands: {
        type: "array",
        items: objectOutput(
          {
            command: stringSchema,
            args: { type: "array", items: stringSchema },
            okExitCodes: {
              type: "array",
              items: { type: "integer", minimum: 0, maximum: 255 },
              maxItems: 8,
              description: "Exit codes that count as success. Default [0].",
            },
          },
          ["command"],
        ),
        minItems: 1,
        maxItems: 10,
      },
      onError: onErrorSchema,
      timeoutMs: timeoutMsSchema,
      maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
    },
    batchResultSchema,
    ["commands"],
  ),
];

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  outputSchema: Record<string, unknown>,
  required: string[] = [],
): ToolDefinition {
  return {
    name,
    title: name.replace(/_/g, " "),
    description,
    inputSchema: {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    },
    outputSchema,
  };
}

interface McpHandler {
  (request: Request): Promise<Response>;
  closeSubscriptions: () => void;
  telemetrySnapshot: () => ReturnType<TelemetryRecorder["snapshot"]>;
}

export function createMcpHandler(
  root: string,
  commandConfig: CommandConfig = {},
  telemetry: TelemetryConfig = { level: "none" },
  codeGraphIntegration?: CodeGraphIntegration,
  serenaIntegration?: SerenaIntegration,
  analyticsEnabled = false,
): McpHandler {
  const codeGraph = codeGraphIntegration ?? new CodeGraphIntegration(root);
  const serena = serenaIntegration ?? new SerenaIntegration(root);
  const telemetryRecorder = new TelemetryRecorder({
    level: telemetry.level,
    persist: telemetry.persist ?? false,
    ...(telemetry.configId ? { configId: telemetry.configId } : {}),
    sessionId: telemetry.sessionId ?? randomUUID(),
  });
  if (telemetry.level !== "none" && telemetry.persist) usePersistentTelemetryKey();
  let sessionStartedAt: number | undefined;
  let sessionLastActivityAt: number | undefined;
  let sessionActiveRequestDurationMs = 0;
  let sessionRequestCount = 0;
  let sessionToolCallCount = 0;
  let sessionCommandCallCount = 0;
  let sessionOutputBytes = 0;
  let sessionEstimatedOutputTokens = 0;
  const seenOutputFingerprints = new Set<string>();
  // Session summaries are snapshotted periodically (last one wins in aggregation) so a killed
  // process still leaves a summary behind, and written again on graceful close.
  const sessionSnapshotMs = telemetry.sessionSnapshotMs ?? 60_000;
  let lastSessionSnapshotAt = Date.now();
  const recordSessionSummary = (): void => {
    if (sessionRequestCount === 0 || telemetry.level === "none") return;
    const started = sessionStartedAt ?? performance.now();
    const lastActivity = sessionLastActivityAt ?? performance.now();
    telemetryRecorder.record({
      event: "session",
      wallClockDurationMs: Math.max(0, lastActivity - started),
      activeRequestDurationMs: sessionActiveRequestDurationMs,
      idleGapDurationMs: Math.max(0, lastActivity - started - sessionActiveRequestDurationMs),
      requestCount: sessionRequestCount,
      toolCallCount: sessionToolCallCount,
      commandCallCount: sessionCommandCallCount,
    });
    lastSessionSnapshotAt = Date.now();
  };
  const maybeSnapshotSession = (): void => {
    if (Date.now() - lastSessionSnapshotAt >= sessionSnapshotMs) recordSessionSummary();
  };
  let cachedTools: { expiresAt: number; value: ToolDefinition[] } | undefined;
  const getAvailableTools = async () => {
    if (cachedTools && cachedTools.expiresAt > Date.now()) return cachedTools.value;
    const value = await availableTools(codeGraph, serena, analyticsEnabled);
    cachedTools = { expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS, value };
    return value;
  };
  const telemetryProjectPromise =
    telemetry.level === "detailed" || telemetry.level === "diagnostic"
      ? buildTelemetryProjectContext(root, codeGraph).catch(() => undefined)
      : undefined;
  const allowedScripts = commandConfig.scripts?.allowedScripts ?? [];
  const packageManager = commandConfig.packageManager ?? "npm";
  const allowedCommands = commandConfig.commands ?? [];
  const blacklistedCommands = commandConfig.blacklistedCommands ?? [];
  const commandPolicy = commandConfig.commandPolicy;
  const pathProtection = commandConfig.protectedPaths;
  const subscriptions = new Set<Subscription>();
  const notify = (event: { type: "tools" | "prompts" | "resources"; uri?: string }) => {
    for (const subscription of subscriptions) {
      const shouldNotify =
        event.type === "tools"
          ? subscription.notifications.toolsListChanged
          : event.type === "prompts"
            ? subscription.notifications.promptsListChanged
            : event.uri !== undefined
              ? subscription.notifications.resourceSubscriptions.has(event.uri)
              : subscription.notifications.resourcesListChanged;
      if (shouldNotify) {
        const method =
          event.type === "tools"
            ? "notifications/tools/list_changed"
            : event.type === "prompts"
              ? "notifications/prompts/list_changed"
              : event.uri !== undefined &&
                  subscription.notifications.resourceSubscriptions.has(event.uri)
                ? "notifications/resources/updated"
                : "notifications/resources/list_changed";
        const params = event.uri === undefined ? undefined : { uri: event.uri };
        writeSse(subscription.controller, {
          jsonrpc: "2.0",
          method,
          ...(params ? { params } : {}),
          _meta: { [SUBSCRIPTION_ID_META]: subscription.id },
        });
      }
    }
  };

  const handler = async (request: Request): Promise<Response> => {
    const requestStartedAt = performance.now();
    let responseBytes: number | undefined;
    let estimatedResponseTokens: number | undefined;
    const trackedJson = (value: unknown, status = 200): Response => {
      const serialized = JSON.stringify(value);
      responseBytes = Buffer.byteLength(serialized, "utf8");
      estimatedResponseTokens = estimateTokens(serialized);
      return new Response(serialized, {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    };
    if (sessionStartedAt === undefined) sessionStartedAt = requestStartedAt;
    maybeSnapshotSession();
    sessionRequestCount += 1;
    const telemetryProject = telemetryProjectPromise ? await telemetryProjectPromise : undefined;
    let message: JsonRpcRequest | undefined;
    let mcpSuccess = false;
    let runtime: import("./telemetry/types.js").TelemetryRuntimeContext | undefined;
    let telemetryRequestErrorCategory: string | undefined;
    const recordMcpRequest = (method = message?.method ?? "unknown") => {
      telemetryRecorder.record(
        {
          event: "mcp_request",
          method,
          success: mcpSuccess,
          durationMs: performance.now() - requestStartedAt,
          ...(responseBytes === undefined ? {} : { responseBytes }),
          ...(estimatedResponseTokens === undefined ? {} : { estimatedResponseTokens }),
          ...(telemetryRequestErrorCategory
            ? { errorCategory: telemetryRequestErrorCategory }
            : {}),
        },
        runtime,
        telemetryProject,
      );
    };
    try {
      const parsed = await request.json();
      if (!isRecord(parsed)) {
        telemetryRequestErrorCategory = "invalid_input";
        recordMcpRequest("unknown");
        return jsonRpcError(null, -32600, "Invalid Request", 400);
      }
      message = parsed as unknown as JsonRpcRequest;
    } catch {
      telemetryRequestErrorCategory = "invalid_input";
      recordMcpRequest("unknown");
      return jsonRpcError(null, -32700, "Parse error", 400);
    }
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      telemetryRequestErrorCategory = "invalid_input";
      recordMcpRequest(typeof message?.method === "string" ? message.method : "unknown");
      return jsonRpcError(message.id ?? null, -32600, "Invalid Request", 400);
    }
    const hasId = Object.hasOwn(message, "id");
    if (hasId && !isValidRequestId(message.id)) {
      telemetryRequestErrorCategory = "invalid_input";
      recordMcpRequest(message.method);
      return jsonRpcError(null, -32600, "Invalid Request", 400);
    }
    if (!hasId) {
      mcpSuccess = message.method.startsWith("notifications/");
      if (!mcpSuccess) telemetryRequestErrorCategory = "invalid_input";
      recordMcpRequest();
      return new Response(null, { status: 202 });
    }
    if (message.params !== undefined && !isRecord(message.params)) {
      telemetryRequestErrorCategory = "invalid_input";
      recordMcpRequest();
      return jsonRpcError(message.id as string | number, -32602, "Invalid params.", 400);
    }
    const params = message.params ?? {};
    runtime = telemetryRuntime(
      params,
      telemetry.level,
      request.headers.get("mcp-protocol-version"),
    );
    const meta = isRecord(params._meta) ? params._meta : undefined;
    if (message.method === "initialize") {
      const requestedVersion = params.protocolVersion;
      if (
        typeof requestedVersion !== "string" ||
        !isRecord(params.capabilities) ||
        !isRecord(params.clientInfo)
      ) {
        telemetryRequestErrorCategory = "invalid_input";
        recordMcpRequest();
        return jsonRpcError(message.id ?? null, -32602, "Invalid initialize params.", 400);
      }
      const supportedVersions = SUPPORTED_PROTOCOL_VERSIONS;
      // Lifecycle negotiation: answer with a version we support instead of failing,
      // so older clients can decide whether to continue.
      const negotiatedVersion = supportedVersions.includes(requestedVersion)
        ? requestedVersion
        : LEGACY_PROTOCOL_VERSION;
      mcpSuccess = true;
      const initializeResponse = trackedJson({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: negotiatedVersion,
          // Only capabilities that are implemented for the legacy handshake.
          capabilities: { tools: {}, resources: {} },
          serverInfo: SERVER_INFO,
          instructions: buildAgentInstructions(
            allowedScripts,
            allowedCommands,
            blacklistedCommands,
            await codeGraph.capability(),
            analyticsEnabled,
          ),
        },
      });
      recordMcpRequest();
      return initializeResponse;
    }
    if (meta) {
      const clientCapabilities = meta["io.modelcontextprotocol/clientCapabilities"];
      if (clientCapabilities !== undefined && !isRecord(clientCapabilities)) {
        telemetryRequestErrorCategory = "invalid_input";
        recordMcpRequest();
        return jsonRpcError(
          message.id ?? null,
          -32602,
          "Invalid client capabilities metadata.",
          400,
        );
      }
      const version = meta[PROTOCOL_META];
      if (version !== undefined && typeof version !== "string") {
        telemetryRequestErrorCategory = "invalid_input";
        recordMcpRequest();
        return jsonRpcError(message.id ?? null, -32602, "Invalid protocol version metadata.", 400);
      }
      if (typeof version === "string" && version !== PROTOCOL_VERSION && version !== "2025-11-25") {
        telemetryRequestErrorCategory = "invalid_input";
        recordMcpRequest();
        return jsonRpcError(message.id ?? null, -32022, "Unsupported protocol version.", 400, {
          supported: ["2025-11-25", PROTOCOL_VERSION],
          requested: version,
        });
      }
    }
    try {
      switch (message.method) {
        case "ping":
          mcpSuccess = true;
          return trackedJson({ jsonrpc: "2.0", id: message.id, result: {} });
        case "server/discover":
          mcpSuccess = true;
          return trackedJson({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              resultType: "complete",
              supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
              capabilities: capabilities(),
              _meta: SERVER_INFO_META,
              instructions: buildDiscoveryInstructions(
                allowedScripts,
                allowedCommands,
                await codeGraph.capability(),
              ),
              codeGraph: await codeGraph.capability(),
              ttlMs: DISCOVERY_CACHE_TTL_MS,
              cacheScope: "private",
            },
          });
        case "tools/list": {
          const page = paginate(await getAvailableTools(), params.cursor);
          mcpSuccess = true;
          return trackedJson({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              resultType: "complete",
              tools: page.items,
              ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
              ttlMs: DISCOVERY_CACHE_TTL_MS,
              cacheScope: "private",
              _meta: SERVER_INFO_META,
            },
          });
        }
        case "tools/call": {
          if (typeof params.name !== "string" || params.name.length === 0) {
            telemetryRequestErrorCategory = "invalid_input";
            return jsonRpcError(
              message.id ?? null,
              -32602,
              "tools/call name must be a non-empty string.",
              400,
            );
          }
          const toolName = params.name;
          const recordRejectedToolCall = (
            tool: string,
            category: string,
            rejected?: unknown,
          ): void => {
            const serialized = JSON.stringify(rejected ?? {});
            telemetryRecorder.record(
              {
                event: "tool_call",
                tool,
                requestIdHash: telemetryHash(String(message.id)),
                success: false,
                outcome: "error",
                durationMs: 0,
                inputBytes: Buffer.byteLength(serialized, "utf8"),
                estimatedInputTokens: estimateTokens(serialized),
                errorCategory: category,
              },
              telemetryRuntime(
                params,
                telemetry.level,
                request.headers.get("mcp-protocol-version"),
              ),
              telemetryProject,
            );
          };
          const toolDefinition = (await getAvailableTools()).find((item) => item.name === toolName);
          if (!toolDefinition) {
            recordRejectedToolCall("unknown", "unknown_tool", params.arguments);
            throw new Error(`Unknown tool: ${toolName}`);
          }
          if (params.arguments !== undefined && !isRecord(params.arguments)) {
            telemetryRequestErrorCategory = "invalid_input";
            recordRejectedToolCall(toolName, "invalid_input", params.arguments);
            return jsonRpcError(
              message.id ?? null,
              -32602,
              "tools/call arguments must be an object.",
              400,
            );
          }
          const argumentsValue = params.arguments ?? {};
          const headerError = validateMcpParamHeaders(
            toolDefinition.inputSchema,
            argumentsValue,
            request.headers,
          );
          if (headerError) {
            telemetryRequestErrorCategory = "invalid_input";
            recordRejectedToolCall(toolName, "invalid_input", argumentsValue);
            return jsonRpcError(message.id ?? null, -32020, headerError, 400);
          }
          sessionToolCallCount += 1;
          const startedAt = performance.now();
          try {
            const result = await callTool(
              toolName,
              argumentsValue,
              root,
              allowedScripts,
              packageManager,
              allowedCommands,
              blacklistedCommands,
              commandPolicy,
              pathProtection,
              notify,
              request.signal,
              codeGraph,
              serena,
              analyticsEnabled,
            );
            const durationMs = performance.now() - startedAt;
            const count = resultCount(result);
            const serializedResult = JSON.stringify(result);
            const outputBytes = Buffer.byteLength(serializedResult, "utf8");
            const estimatedOutputTokens = estimateTokens(serializedResult);
            sessionOutputBytes += outputBytes;
            sessionEstimatedOutputTokens += estimatedOutputTokens;
            const runtime = telemetryRuntime(
              params,
              telemetry.level,
              request.headers.get("mcp-protocol-version"),
            );
            const metrics = toolTelemetryMetrics(toolName, result, seenOutputFingerprints);
            const outcome = toolOutcome(result, count, metrics.truncated === true);
            telemetryRecorder.record(
              {
                event: "tool_call",
                tool: toolName,
                requestIdHash: telemetryHash(String(message.id)),
                success: result.isError !== true,
                outcome,
                durationMs,
                inputBytes: Buffer.byteLength(JSON.stringify(argumentsValue), "utf8"),
                outputBytes,
                estimatedInputTokens: estimateTokens(JSON.stringify(argumentsValue)),
                estimatedOutputTokens,
                cumulativeOutputBytes: sessionOutputBytes,
                cumulativeEstimatedOutputTokens: sessionEstimatedOutputTokens,
                inputFingerprint: telemetryHash(fingerprintInput(toolName, argumentsValue)),
                ...(count === undefined ? {} : { resultCount: count }),
                ...metrics,
              },
              runtime,
              telemetryProject,
            );
            const command = commandTelemetryDescriptor(toolName);
            if (command) {
              sessionCommandCallCount += 1;
              telemetryRecorder.record(
                {
                  event: "command_call",
                  commandFamily: command.family,
                  operation: command.operation,
                  ...commandExecutables(toolName, argumentsValue),
                  success: true,
                  durationMs,
                  outputBytes,
                },
                runtime,
                telemetryProject,
              );
            }
            mcpSuccess = true;
            return trackedJson({
              jsonrpc: "2.0",
              id: message.id,
              result,
            });
          } catch (error) {
            const durationMs = performance.now() - startedAt;
            const runtime = telemetryRuntime(
              params,
              telemetry.level,
              request.headers.get("mcp-protocol-version"),
            );
            const errorCategory = classifyTelemetryError(error);
            telemetryRecorder.record(
              {
                event: "tool_call",
                tool: toolName,
                requestIdHash: telemetryHash(String(message.id)),
                success: false,
                outcome: "error",
                durationMs,
                inputBytes: Buffer.byteLength(JSON.stringify(argumentsValue), "utf8"),
                estimatedInputTokens: estimateTokens(JSON.stringify(argumentsValue)),
                inputFingerprint: telemetryHash(fingerprintInput(toolName, argumentsValue)),
                errorCategory,
              },
              runtime,
              telemetryProject,
            );
            const command = commandTelemetryDescriptor(toolName);
            if (command) {
              sessionCommandCallCount += 1;
              telemetryRecorder.record(
                {
                  event: "command_call",
                  commandFamily: command.family,
                  operation: command.operation,
                  ...commandExecutables(toolName, argumentsValue),
                  success: false,
                  durationMs,
                  errorCategory,
                },
                runtime,
                telemetryProject,
              );
            }
            throw error;
          }
        }
        case "resources/list": {
          const resources = [
            {
              uri: INSTRUCTIONS_URI,
              name: "Agent Dir usage instructions",
              description:
                "Dynamically generated, efficiency-focused instructions for using this Agent Dir server.",
              mimeType: "text/markdown",
            },
            {
              uri: CAPABILITIES_URI,
              name: "Agent Dir capabilities",
              description:
                "Machine-readable current tools and execution policy for this Agent Dir server.",
              mimeType: "application/json",
            },
            ...(await listSkillResources(root)).map((item) => ({
              ...item,
              description: "Agent Skill resource",
            })),
          ];
          const page = paginate(resources, params.cursor);
          mcpSuccess = true;
          return trackedJson({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              resultType: "complete",
              resources: page.items,
              ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
              ttlMs: DISCOVERY_CACHE_TTL_MS,
              cacheScope: "private",
              _meta: SERVER_INFO_META,
            },
          });
        }
        case "resources/read": {
          if (typeof params.uri !== "string" || params.uri.length === 0)
            return jsonRpcError(
              message.id ?? null,
              -32602,
              "resources/read uri must be a non-empty string.",
              400,
            );
          if (params.uri === INSTRUCTIONS_URI) {
            mcpSuccess = true;
            return trackedJson({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                resultType: "complete",
                contents: [
                  {
                    uri: INSTRUCTIONS_URI,
                    mimeType: "text/markdown",
                    text: buildAgentInstructions(
                      allowedScripts,
                      allowedCommands,
                      blacklistedCommands,
                      await codeGraph.capability(),
                      analyticsEnabled,
                    ),
                  },
                ],
                ttlMs: 0,
                cacheScope: "private",
                _meta: SERVER_INFO_META,
              },
            });
          }
          if (params.uri === CAPABILITIES_URI) {
            mcpSuccess = true;
            return trackedJson({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                resultType: "complete",
                contents: [
                  {
                    uri: CAPABILITIES_URI,
                    mimeType: "application/json",
                    text: JSON.stringify(
                      buildAgentCapabilities(
                        allowedScripts,
                        allowedCommands,
                        blacklistedCommands,
                        await codeGraph.capability(),
                        analyticsEnabled,
                      ),
                      null,
                      2,
                    ),
                  },
                ],
                ttlMs: 0,
                cacheScope: "private",
                _meta: SERVER_INFO_META,
              },
            });
          }
          const value = await readSkillResource(root, params.uri);
          mcpSuccess = true;
          return trackedJson({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              resultType: "complete",
              contents: [value],
              ttlMs: 0,
              cacheScope: "private",
              _meta: SERVER_INFO_META,
            },
          });
        }
        case "resources/directory/read": {
          if (typeof params.uri !== "string" || params.uri.length === 0)
            return jsonRpcError(
              message.id ?? null,
              -32602,
              "resources/directory/read uri must be a non-empty string.",
              400,
            );
          const resources = await readSkillDirectory(root, params.uri);
          const page = paginate(resources, params.cursor);
          mcpSuccess = true;
          return trackedJson({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              resultType: "complete",
              resources: page.items,
              ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
              ttlMs: 0,
              cacheScope: "private",
              _meta: SERVER_INFO_META,
            },
          });
        }
        case "skills/list": {
          const page = paginate(await listSkills(root), params.cursor);
          mcpSuccess = true;
          return trackedJson({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              resultType: "complete",
              skills: page.items,
              ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
              ttlMs: 0,
              cacheScope: "private",
              _meta: SERVER_INFO_META,
            },
          });
        }
        case "subscriptions/listen": {
          const notifications = subscriptionNotifications(params.notifications);
          mcpSuccess = true;
          return subscriptionResponse(message.id, notifications, subscriptions);
        }
        case "skills/get":
          if (typeof params.uri !== "string" || params.uri.length === 0)
            return jsonRpcError(
              message.id ?? null,
              -32602,
              "skills/get uri must be a non-empty string.",
              400,
            );
          mcpSuccess = true;
          return trackedJson({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              resultType: "complete",
              skill: await getSkill(root, params.uri),
              ttlMs: 0,
              cacheScope: "private",
              _meta: SERVER_INFO_META,
            },
          });
        default:
          telemetryRequestErrorCategory = "not_found";
          return jsonRpcError(
            message.id ?? null,
            -32601,
            `Method not found: ${message.method}`,
            404,
          );
      }
    } catch (error) {
      telemetryRequestErrorCategory = classifyTelemetryError(error);
      if (message.method === "tools/call")
        return trackedJson(
          {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              resultType: "complete",
              isError: true,
              content: [
                { type: "text", text: error instanceof Error ? error.message : String(error) },
              ],
              structuredContent: { error: error instanceof Error ? error.message : String(error) },
              _meta: SERVER_INFO_META,
            },
          },
          200,
        );
      const code =
        message.method === "skills/get" ||
        message.method === "resources/read" ||
        message.method === "resources/directory/read" ||
        message.method === "subscriptions/listen" ||
        message.method === "skills/list"
          ? -32602
          : -32603;
      return jsonRpcError(
        message.id ?? null,
        code,
        error instanceof Error ? error.message : String(error),
        code === -32602 ? 400 : 500,
      );
    } finally {
      const requestDurationMs = performance.now() - requestStartedAt;
      sessionActiveRequestDurationMs += requestDurationMs;
      sessionLastActivityAt = performance.now();
      recordMcpRequest();
    }
  };

  handler.telemetrySnapshot = () => telemetryRecorder.snapshot();

  handler.closeSubscriptions = () => {
    recordSessionSummary();
    for (const subscription of subscriptions) {
      writeSse(subscription.controller, {
        jsonrpc: "2.0",
        id: null,
        result: {
          resultType: "complete",
          _meta: {
            ...SERVER_INFO_META,
            [SUBSCRIPTION_ID_META]: subscription.id,
          },
        },
      });
      subscription.controller.close();
    }
    subscriptions.clear();
    void codeGraph.close();
    void serena.close();
  };

  return handler;
}

async function availableTools(
  codeGraph: CodeGraphIntegration,
  serena: SerenaIntegration,
  analyticsEnabled = false,
): Promise<ToolDefinition[]> {
  const capability = await codeGraph.capability();
  const codeGraphTools =
    capability.status === "available" ||
    capability.status === "startup_failed" ||
    capability.status === "runtime_failed"
      ? [codeGraphTool]
      : [];
  const serenaTools = await serena.prepare();
  return [
    ...baseTools,
    ...(isAstGrepAvailable() ? [astGrepTool] : []),
    ...codeGraphTools,
    ...serenaTools.map(serenaToolDefinition),
    ...(analyticsEnabled ? [telemetryAnalyticsTool] : []),
  ];
}

const telemetryAnalyticsTool: ToolDefinition = tool(
  "telemetry_analytics",
  "Analyze locally persisted Agent Dir telemetry across all profiles and sessions. Summary mode is aggregate-only; event mode returns bounded sanitized event records. Available only when Agent Dir is started with --analytics.",
  {
    mode: { type: "string", enum: ["summary", "sessions", "events"], default: "summary" },
    profile: { type: "string", maxLength: 100 },
    session: { type: "string", maxLength: 100 },
    since: { type: "string", description: "Optional ISO timestamp lower bound." },
    until: { type: "string", description: "Optional ISO timestamp upper bound." },
    limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
    maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
  },
  { type: "object", additionalProperties: true },
);

function serenaToolDefinition(item: SerenaTool): ToolDefinition {
  return {
    name: `serena_${item.name}`,
    title: `Serena: ${item.title}`,
    description: item.description,
    inputSchema: item.inputSchema,
    outputSchema: item.outputSchema ?? { type: "object", additionalProperties: true },
  };
}

function buildDiscoveryInstructions(
  allowedScripts: string[],
  allowedCommands: string[],
  codeGraph: CodeGraphCapability,
): string {
  const scripts = allowedScripts.length ? allowedScripts.join(", ") : "none";
  const commands = allowedCommands.length ? allowedCommands.join(", ") : "none";
  const graph =
    codeGraph.status === "available"
      ? " For non-trivial code understanding, call codegraph_explore first for behavior, call/data flow, symbol relationships, or change impact; avoid duplicating results with grep/read loops."
      : "";
  const structuralSearch = isAstGrepAvailable()
    ? " Use ast_grep_search for syntax-aware structural pattern matching; use search_code for exact text and codegraph_explore for call/data flow."
    : "";
  return `Use Agent Dir as the primary project interface. Minimize calls and output. Start with project_context; use find_files/search_code/find_symbol/find_references for targeted discovery, read_range for bounded context, and apply_changes for atomic edits. Use validate for diagnostics and allowed package scripts; use run_command_batch for allowlisted commands, including Git when allowed.${graph}${structuralSearch} Batch related operations. Avoid recursive listings, whole-file reads, full diffs, and repeated discovery. Allowed package scripts: ${scripts}. Allowed commands: ${commands}.`;
}

function buildAgentInstructions(
  allowedScripts: string[],
  allowedCommands: string[],
  blacklistedCommands: string[],
  codeGraph: CodeGraphCapability,
  analyticsEnabled = false,
): string {
  const scripts = allowedScripts.length
    ? allowedScripts.map((item) => `- ${item}`).join("\n")
    : "- none";
  const commands = allowedCommands.length
    ? allowedCommands.map((item) => `- ${item}`).join("\n")
    : "- none";
  const blacklist = blacklistedCommands.length
    ? blacklistedCommands.map((item) => `- ${item}`).join("\n")
    : "- none";
  const codeGraphSection =
    codeGraph.status === "available" ||
    codeGraph.status === "startup_failed" ||
    codeGraph.status === "runtime_failed"
      ? "\n\n## CodeGraph\n- CodeGraph is an optional code-intelligence backend for this project.\n- REQUIRED FIRST STEP for non-trivial code understanding: call `codegraph_explore` before grep/search/read loops to explain behavior, trace call/data flow, map symbol relationships, or assess change impact. - Treat returned source as already read; do not re-run searches without a concrete gap.\n- Agent Dir pins CodeGraph to this project root; do not attempt to select another project.\n- Current status: " +
        codeGraph.status +
        (codeGraph.detail ? ` — ${codeGraph.detail}` : "") +
        "."
      : "";
  return `# Agent Dir operating instructions\n\nUse Agent Dir as the primary project interface. Optimize for correctness with the minimum necessary tool calls, filesystem reads, command output, and context.\n\n## Efficiency rules\n- Start with the narrowest operation that can answer the question. Do not dump the repository, large files, or full command output when a targeted operation is sufficient.\n- Prefer project_context for initial orientation; it combines project structure, package metadata, and execution policy in one call. \n- Prefer find_files for known filename patterns\n- Prefer search_code before reading files. Search first, then read only the relevant ranges.\n- For semantic navigation, use Serena tools first when available: serena_find_symbol for definitions and serena_find_referencing_symbols for callers/references; use supported Serena symbol-edit tools for targeted edits. If Serena returns no match or errors, verify the path/name and fall back to find_symbol/search_code.\n- Use ast_grep_search when syntax shape matters, not for literal text. Specify lang and narrow globs whenever possible; start with a small maxResults and expand only if needed.\n- Use CodeGraph first for non-trivial behavior, call/data flow, relationships, and impact analysis when available. If unavailable or failing, continue with Serena and native search tools.\n- Prefer read_range for a bounded section.\n- Prefer apply_changes for atomic writes, patches, and deletions. Do not rewrite an entire file when a small exact replacement is sufficient.\n- Batch related reads, writes, patches, searches, and commands into one tool call when practical.\n- Keep maxResults small unless the initial result is insufficient.\n- Prefer dedicated Agent Dir tools over run_command_batch because dedicated tools return structured, bounded results.\n- Prefer validate for lightweight diagnostics and explicitly requested package scripts.\n- Run the narrowest relevant validation after a change; escalate only when required by the task or release workflow.\n- Never repeat a successful discovery/read just because another tool can provide the same information.\n\n## Preferred workflow\n1. Orient: project_context.\n2. Locate: find_files/search_code/find_symbol as appropriate.\n3. Read: read_range.\n4. Modify: apply_changes for atomic writes, patches, and deletes.\n5. Validate: use validate for diagnostics or explicitly allowed package scripts for executable checks.\n6. Review: use allowlisted Git commands through run_command_batch when \`git\` is enabled.\n\n## Execution policy\nAllowed package scripts:\n${scripts}\n\nAllowed executables:\n${commands}\n\nBlacklisted command prefixes:\n${blacklist}\n\nOnly use commands from the execution policy. A blacklisted command prefix overrides an allowed executable. Do not attempt to bypass it with shells or alternate executables.\n\n## Git operations\nUse \`run_command_batch\` for Git commands only when \`git\` is in the allowed executable list. The command allowlist and blacklist still apply; avoid destructive operations unless explicitly requested.\n\n## Tool selection\n- Behavior/call-flow/impact: codegraph_explore first when available.\n- Semantic symbol navigation and callers: Serena tools first when available; fall back to find_symbol/find_references/search_code on empty or failed results.\n- Structural syntax matching: ast_grep_search with explicit language and narrow globs.\n- Literal text and regex: search_code.\n- File discovery: project_context > find_files.\n- File reading: read_range.\n- Editing: apply_changes for atomic multi-file edits.\n- Validation: validate > targeted package script > full check/test.\n- Git operations: run_command_batch with the allowed \`git\` executable, respecting the configured blacklist.\n\n${analyticsEnabled ? "\n\n## Telemetry analytics\n- telemetry_analytics is enabled for this connector. Use mode=summary for cross-session metrics, mode=sessions for per-session tool counts and failures, and mode=events for bounded event sequences. Filter by profile/time/session before requesting event detail." : ""}\n\nThe execution policy and this guidance are generated from the running Agent Dir configuration; do not maintain a separate client-specific copy.${codeGraphSection}`;
}

function buildAgentCapabilities(
  allowedScripts: string[],
  allowedCommands: string[],
  blacklistedCommands: string[],
  codeGraph: CodeGraphCapability,
  analyticsEnabled = false,
): Record<string, unknown> {
  return {
    version: packageVersion,
    tools: [
      ...baseTools.map((item) => item.name),
      ...(isAstGrepAvailable() ? ["ast_grep_search"] : []),
      ...(codeGraph.status === "available" ? ["codegraph_explore"] : []),
      ...(analyticsEnabled ? ["telemetry_analytics"] : []),
    ],
    resources: [INSTRUCTIONS_URI, CAPABILITIES_URI],
    execution: {
      allowedScripts: [...allowedScripts],
      commands: [...allowedCommands],
      blacklistedCommands: [...blacklistedCommands],
    },
    efficiency: {
      preferred: {
        orientation: "project_context",
        ...(codeGraph.status === "available" ? { structuralAnalysis: "codegraph_explore" } : {}),
        ...(isAstGrepAvailable() ? { structuralSearch: "ast_grep_search" } : {}),
        focusedReading: "read_range",
        discovery: ["find_files", "search_code"],
        symbolNavigation: ["find_symbol", "find_references"],
        reading: ["read_range"],
        editing: ["apply_changes"],
        validation: ["validate", "targeted package script"],
        ...(analyticsEnabled ? { telemetryAnalytics: "telemetry_analytics" } : {}),
      },
      avoid: [
        "recursive discovery when targeted search is enough",
        "whole-file reads when a line range is enough",
        "full-repository diffs when a path-scoped diff is enough",
        "expensive validation when a targeted check answers the question",
        "generic command execution when a dedicated Agent Dir tool exists, except allowlisted Git operations",
        ...(codeGraph.status === "available"
          ? ["repeated grep/read loops for structural questions already answered by CodeGraph"]
          : []),
      ],
    },
  };
}

function capabilities(): Record<string, unknown> {
  return {
    tools: {},
    resources: { listChanged: true, subscribe: true },
    extensions: { "io.modelcontextprotocol/skills": { directoryRead: true } },
  };
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  root: string,
  allowedScripts: string[],
  packageManager: "npm" | "pnpm" | "yarn" | "bun",
  allowedCommands: string[],
  blacklistedCommands: string[],
  commandPolicy: CommandPolicyConfig | undefined,
  pathProtection: PathProtectionConfig | undefined,
  notify: (event: { type: "tools" | "prompts" | "resources"; uri?: string }) => void,
  signal?: AbortSignal,
  codeGraph?: CodeGraphIntegration,
  serena?: SerenaIntegration,
  analyticsEnabled = false,
): Promise<Record<string, unknown>> {
  let structuredContent: unknown;
  if (name.startsWith("serena_")) {
    if (!serena) throw new Error("Serena integration is unavailable.");
    const result = await serena.call(name.slice("serena_".length), args);
    return boundCodeGraphResult(result, outputBytesArg(args.maxBytes));
  }
  if (name === "codegraph_explore") {
    if (!codeGraph) throw new Error("CodeGraph integration is unavailable.");
    if (typeof args.query !== "string" || args.query.trim().length === 0)
      throw new Error("query must be a non-empty string.");
    if (
      args.maxFiles !== undefined &&
      (!Number.isInteger(args.maxFiles) || Number(args.maxFiles) < 1 || Number(args.maxFiles) > 100)
    )
      throw new Error("maxFiles must be an integer between 1 and 100.");
    const maxBytes = outputBytesArg(args.maxBytes);
    const result = await codeGraph.explore(
      args.query,
      args.maxFiles === undefined ? 10 : Number(args.maxFiles),
    );
    return boundCodeGraphResult(result, maxBytes);
  }
  if (name === "telemetry_analytics") {
    if (!analyticsEnabled)
      throw new Error("Telemetry analytics is disabled; start Agent Dir with --analytics.");
    const mode = typeof args.mode === "string" ? args.mode : "summary";
    if (!["summary", "sessions", "events"].includes(mode))
      throw new Error("mode must be summary, sessions, or events.");
    const limit = Math.max(
      1,
      Math.min(500, Number.isInteger(args.limit) ? Number(args.limit) : 100),
    );
    const since =
      typeof args.since === "string" ? Date.parse(args.since) : Number.NEGATIVE_INFINITY;
    const until =
      typeof args.until === "string" ? Date.parse(args.until) : Number.POSITIVE_INFINITY;
    if (Number.isNaN(since) || Number.isNaN(until))
      throw new Error("since and until must be valid ISO timestamps.");
    const all = readTelemetryEvents({
      ...(typeof args.profile === "string" && args.profile ? { profile: args.profile } : {}),
      ...(typeof args.session === "string" && args.session ? { session: args.session } : {}),
      ...(Number.isFinite(since) ? { sinceMs: since } : {}),
    }).filter(
      (event) =>
        (!args.profile || event.configId === args.profile) &&
        (!args.session || event.sessionId === args.session) &&
        Date.parse(event.timestamp) >= since &&
        Date.parse(event.timestamp) <= until,
    );
    let result: Record<string, unknown>;
    if (mode === "summary") {
      const summary = summarizeTelemetry(all);
      result = {
        mode,
        matchedEvents: all.length,
        configCount: summary.configCount,
        totalEvents: summary.totalEvents,
        configs: Object.fromEntries(
          Object.entries(summary.configs).map(([configId, config]) => [
            configId,
            {
              eventCount: config.eventCount,
              httpRequests: config.httpRequests,
              httpAuthFailures: config.httpAuthFailures,
              httpErrors: config.httpErrors,
              mcpRequests: config.mcpRequests,
              toolCalls: config.toolCalls,
              commandCalls: config.commandCalls,
              tunnelEvents: config.tunnelEvents,
              tunnelDisconnects: config.tunnelDisconnects,
              tunnelReconnects: config.tunnelReconnects,
              tunnelFailures: config.tunnelFailures,
              mcpSuccessRate: config.mcpSuccessRate,
              toolSuccessRate: config.toolSuccessRate,
              commandSuccessRate: config.commandSuccessRate,
              failuresByCategory: config.failuresByCategory,
              tools: config.tools,
              commands: config.commands,
              sessionCount: Object.keys(config.sessions).length,
              legacySessionEvents: config.legacySessionEvents,
            },
          ]),
        ),
      };
    } else if (mode === "sessions") {
      const groups = new Map<string, typeof all>();
      for (const event of all) {
        const key = `${event.configId}/${event.sessionId}`;
        const group = groups.get(key) ?? [];
        group.push(event);
        groups.set(key, group);
      }
      result = {
        mode,
        matchedEvents: all.length,
        sessions: [...groups.entries()].slice(-limit).map(([key, events]) => ({
          key,
          eventCount: events.length,
          start: events[0]?.timestamp,
          end: events.at(-1)?.timestamp,
          tools: events
            .filter((event) => event.event.event === "tool_call")
            .reduce<Record<string, number>>((counts, event) => {
              if (event.event.event === "tool_call")
                counts[event.event.tool] = (counts[event.event.tool] ?? 0) + 1;
              return counts;
            }, {}),
          failures: events
            .filter((event) => "success" in event.event && !event.event.success)
            .map((event) => ({
              timestamp: event.timestamp,
              event: event.event.event,
              ...("tool" in event.event ? { tool: event.event.tool } : {}),
              ...("errorCategory" in event.event && event.event.errorCategory
                ? { category: event.event.errorCategory }
                : {}),
            })),
        })),
      };
    } else {
      result = {
        mode,
        matchedEvents: all.length,
        events: all.slice(-limit).map((item) => ({
          timestamp: item.timestamp,
          configId: item.configId,
          sessionId: item.sessionId,
          level: item.level,
          event:
            item.event.event === "tool_call"
              ? Object.fromEntries(
                  Object.entries(item.event).filter(([key]) => key !== "diagnosticDetails"),
                )
              : item.event,
          runtime: item.runtime
            ? {
                agentDirVersion: item.runtime.agentDirVersion,
                nodeMajor: item.runtime.nodeMajor,
                os: item.runtime.os,
                arch: item.runtime.arch,
                mcpClientName: item.runtime.mcpClientName,
                mcpClientVersion: item.runtime.mcpClientVersion,
                mcpProtocolVersion: item.runtime.mcpProtocolVersion,
              }
            : undefined,
          project: item.project
            ? {
                language: item.project.language,
                framework: item.project.framework,
                packageManager: item.project.packageManager,
                hasGit: item.project.hasGit,
                hasCodegraph: item.project.hasCodegraph,
                projectSize: item.project.projectSize,
              }
            : undefined,
        })),
      };
    }
    return completeToolResult(fitAnalyticsResult(result, outputBytesArg(args.maxBytes)));
  }
  switch (name) {
    case "ast_grep_search": {
      if (typeof args.pattern !== "string") throw new Error("pattern must be a string.");
      structuredContent = await runAstGrep(
        root,
        {
          pattern: args.pattern,
          ...(typeof args.lang === "string" ? { lang: args.lang } : {}),
          ...(Array.isArray(args.globs) ? { globs: args.globs as string[] } : {}),
          ...(args.context === undefined ? {} : { context: Number(args.context) }),
          ...(args.maxResults === undefined ? {} : { maxResults: Number(args.maxResults) }),
          ...(args.maxBytes === undefined ? {} : { maxBytes: Number(args.maxBytes) }),
        },
        signal,
      );
      break;
    }
    case "read_range": {
      const maxBytes = outputBytesArg(args.maxBytes);
      const result = await readRange(
        root,
        String(args.path),
        Number(args.startLine),
        Number(args.endLine),
        Math.max(1, maxBytes - 256),
      );
      const bounded = truncateText(result.content, Math.max(1, maxBytes - 256));
      structuredContent = {
        ...result,
        content: bounded.text,
        truncated: result.truncated || bounded.truncated,
      };
      break;
    }
    case "apply_changes": {
      const changes = objectArray(args.changes, "changes").map((change) => {
        const kind = String(change.kind);
        if (kind !== "write" && kind !== "patch" && kind !== "delete")
          throw new Error("Change kind must be write, patch, or delete.");
        if (kind === "write" && typeof change.content !== "string")
          throw new Error("write changes require content.");
        if (kind === "patch" && !Array.isArray(change.patches))
          throw new Error("patch changes require patches.");
        return {
          kind,
          path: String(change.path),
          ...(kind === "write" ? { content: String(change.content) } : {}),
          ...(kind === "patch"
            ? {
                patches: objectArray(change.patches, "patches").map((patch) => ({
                  search: String(patch.search),
                  replace: String(patch.replace),
                  ...(patch.count === undefined ? {} : { count: Number(patch.count) }),
                })),
              }
            : {}),
        } as
          | { kind: "write"; path: string; content: string }
          | {
              kind: "patch";
              path: string;
              patches: Array<{ search: string; replace: string; count?: number }>;
            }
          | { kind: "delete"; path: string };
      });
      const dryRun = args.dryRun === true;
      const affected = [...new Set(changes.map((change) => change.path))];
      const before = new Map<string, string[]>();
      for (const p of affected) before.set(p, await skillResourceUrisForPath(root, p));
      const applied = await applyFileChanges(root, changes, dryRun, pathProtection);
      structuredContent = applied.map((item) => {
        if (!isRecord(item)) return item;
        const { content: _content, previousContent: _previousContent, ...summary } = item;
        return summary;
      });
      if (!dryRun) {
        invalidateSkillDiscoveryCache(root);
        for (const p of affected) await notifyResourceChange(notify, root, p, before.get(p) ?? []);
      }
      break;
    }
    case "find_files": {
      const maxResults = numberArg(args.maxResults, 200, 1000);
      const results = await findFiles(root, String(args.pattern), maxResults);
      const bounded = boundedItems(results, outputBytesArg(args.maxBytes));
      structuredContent = {
        items: bounded.items,
        truncated: bounded.truncated || results.length >= maxResults,
      };
      break;
    }
    case "search_code":
      structuredContent = await searchCode(
        root,
        String(args.query),
        Boolean(args.regex),
        numberArg(args.maxResults, 200, 1000),
        outputBytesArg(args.maxBytes),
      );
      break;
    case "find_symbol":
      structuredContent = await findSymbol(
        root,
        String(args.symbol),
        numberArg(args.maxResults, 100, 500),
        outputBytesArg(args.maxBytes),
      );
      break;
    case "find_references":
      structuredContent = await findReferences(
        root,
        String(args.symbol),
        numberArg(args.maxResults, 200, 1000),
        outputBytesArg(args.maxBytes),
      );
      break;
    case "project_context": {
      const overview = await projectOverview(root);
      let pkg: Record<string, unknown> = { path: "package.json", exists: false };
      try {
        const packageJson = JSON.parse(await readFile(root, "package.json")) as Record<
          string,
          unknown
        >;
        pkg = {
          path: "package.json",
          name: packageJson.name ?? null,
          version: packageJson.version ?? null,
          description: packageJson.description ?? null,
          packageManager: packageJson.packageManager ?? null,
          scripts: packageJson.scripts ?? {},
        };
      } catch {
        // Package metadata is optional; project context remains useful without it.
      }
      const maxBytes = outputBytesArg(args.maxBytes);
      const bounded = truncateText(
        JSON.stringify({
          ...overview,
          package: pkg,
          execution: {
            allowedScripts: [...allowedScripts],
            commands: [...allowedCommands],
          },
        }),
        Math.max(1, maxBytes - 128),
      );
      structuredContent = bounded.truncated
        ? { result: bounded.text, truncated: true }
        : JSON.parse(bounded.text);
      break;
    }
    case "validate": {
      const level = typeof args.level === "string" ? args.level : "diagnostics";
      const maxResults = numberArg(args.maxResults, 200, 1000);
      const maxBytes = outputBytesArg(args.maxBytes);
      const diagnosticItems = await diagnostics(root, maxResults);
      const scripts =
        level === "diagnostics"
          ? []
          : args.scripts !== undefined
            ? stringArray(args.scripts, "scripts")
            : level === "full"
              ? ["check", "test"].filter((script) => allowedScripts.includes(script))
              : [];
      if (scripts.length > 10) throw new Error("validate accepts at most 10 scripts per call.");
      const checks: Array<Record<string, unknown>> = [
        {
          kind: "diagnostics",
          ok: !diagnosticItems.some((item) => item.severity === "error"),
          count: diagnosticItems.length,
          issues: boundedItems(diagnosticItems, maxBytes).items,
        },
      ];
      for (const script of scripts) {
        const result = await runPackageScript(
          root,
          script,
          120000,
          allowedScripts,
          signal,
          packageManager,
        );
        checks.push({
          kind: "package-script",
          script,
          ok: result.exitCode === 0,
          result,
        });
        if (result.exitCode !== 0) break;
      }
      const validation = {
        level,
        ok: checks.every((check) => check.ok === true),
        checks,
        scriptsRequested: scripts,
      };
      const serialized = JSON.stringify(validation);
      if (Buffer.byteLength(serialized, "utf8") <= maxBytes) {
        structuredContent = validation;
      } else {
        const perCheckBudget = Math.max(256, Math.floor((maxBytes - 256) / checks.length));
        const compactChecks = checks.map((check) => {
          if (check.kind === "package-script" && isRecord(check.result))
            return { ...check, result: boundCommandResult(check.result, perCheckBudget) };
          if (check.kind === "diagnostics" && Array.isArray(check.issues))
            return { ...check, issues: boundedItems(check.issues, perCheckBudget).items };
          return check;
        });
        const compact = { ...validation, checks: compactChecks, truncated: true };
        const compactJson = JSON.stringify(compact);
        if (Buffer.byteLength(compactJson, "utf8") <= maxBytes) {
          structuredContent = compact;
        } else {
          structuredContent = {
            level,
            ok: validation.ok,
            truncated: true,
            checks: checks.map((check) => ({
              kind: check.kind,
              ...(typeof check.script === "string" ? { script: check.script } : {}),
              ok: check.ok,
              ...(typeof check.count === "number" ? { count: check.count } : {}),
            })),
          };
        }
      }
      break;
    }
    case "file_info":
      structuredContent = await fileInfo(root, String(args.path));
      break;
    case "run_package_scripts_batch": {
      const scripts = stringArray(args.scripts, "scripts");
      const timeoutMs = timeoutMsArg(args.timeoutMs);
      if (scripts.length > 10)
        throw new Error("run_package_scripts_batch accepts at most 10 scripts per call.");
      structuredContent = await runBatch(
        scripts.map((script) => ({
          label: packageScriptLabel(packageManager, script),
          preflight: () => packageScriptProblem(root, script, allowedScripts),
          execute: () =>
            packageScriptCapture(root, script, {
              timeoutMs,
              packageManager,
              ...(signal ? { signal } : {}),
            }),
        })),
        { onError: batchOnError(args.onError, "stop"), maxBytes: outputBytesArg(args.maxBytes) },
      );
      break;
    }
    case "run_command_batch": {
      const commands = objectArray(args.commands, "commands");
      const timeoutMs = timeoutMsArg(args.timeoutMs);
      if (commands.length > 10)
        throw new Error("run_command_batch accepts at most 10 commands per call.");
      structuredContent = await runBatch(
        commands.map((item) => {
          const command = typeof item.command === "string" ? item.command : "";
          const commandArgs = Array.isArray(item.args) ? (item.args as string[]) : [];
          const okExitCodes = okExitCodesArg(item.okExitCodes);
          return {
            label: [command, ...commandArgs.map(String)].join(" "),
            ...(okExitCodes ? { okExitCodes } : {}),
            preflight: () =>
              typeof item.command !== "string"
                ? "command must be a string."
                : checkCommand(root, command, commandArgs, {
                    allowedCommands,
                    blacklistedCommands,
                    allowedScripts,
                    ...(commandPolicy ? { policy: commandPolicy } : {}),
                  }),
            execute: () =>
              spawnCapture(root, command, commandArgs, {
                timeoutMs,
                ...(signal ? { signal } : {}),
              }),
          };
        }),
        {
          onError: batchOnError(args.onError, "continue"),
          maxBytes: outputBytesArg(args.maxBytes),
        },
      );
      break;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
  return completeToolResult(structuredContent);
}

const MCP_PARAM_PREFIX = "Mcp-Param-";
const X_MCP_HEADER = "x-mcp-header";

export function validateMcpParamHeaders(
  inputSchema: Record<string, unknown>,
  args: Record<string, unknown>,
  headers: Headers,
): string | undefined {
  const annotations = collectMcpHeaderAnnotations(inputSchema);
  for (const annotation of annotations) {
    const value = valueAtPath(args, annotation.path);
    const headerName = `${MCP_PARAM_PREFIX}${annotation.headerName}`;
    const headerValue = headers.get(headerName);

    if (value === undefined || value === null) {
      if (headerValue !== null)
        return `${headerName} must be absent when the annotated argument is absent.`;
      continue;
    }

    const rendered = renderMcpHeaderValue(value);
    if (rendered === undefined)
      return `${headerName} can only mirror string, integer, or boolean arguments.`;
    if (headerValue === null) return `${headerName} is required for the annotated argument.`;

    const decoded = decodeMcpHeaderValue(headerValue);
    if (decoded === undefined || !mcpHeaderValuesEqual(annotation.type, rendered, decoded))
      return `${headerName} does not match the annotated argument.`;
  }
  return undefined;
}

interface McpHeaderAnnotation {
  path: string[];
  headerName: string;
  type: "string" | "integer" | "boolean";
}

function collectMcpHeaderAnnotations(schema: Record<string, unknown>): McpHeaderAnnotation[] {
  const result: McpHeaderAnnotation[] = [];
  const visit = (node: unknown, path: string[]) => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return;
    const record = node as Record<string, unknown>;
    const properties = record.properties;
    if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return;

    for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
      if (typeof child !== "object" || child === null || Array.isArray(child)) continue;
      const property = child as Record<string, unknown>;
      if (property[X_MCP_HEADER] !== undefined) {
        const headerName = property[X_MCP_HEADER];
        if (
          typeof headerName !== "string" ||
          !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName) ||
          !headerName
        ) {
          throw new Error(
            `Invalid x-mcp-header annotation for property ${[...path, name].join(".")}.`,
          );
        }
        if (
          property.type !== "string" &&
          property.type !== "integer" &&
          property.type !== "boolean"
        )
          throw new Error(`Invalid x-mcp-header type for property ${[...path, name].join(".")}.`);
        if (result.some((item) => item.headerName.toLowerCase() === headerName.toLowerCase()))
          throw new Error(`Duplicate x-mcp-header annotation: ${headerName}.`);
        result.push({
          path: [...path, name],
          headerName,
          type: property.type as "string" | "integer" | "boolean",
        });
      }
      visit(property, [...path, name]);
    }
  };
  visit(schema, []);
  return result;
}

function valueAtPath(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function renderMcpHeaderValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  return undefined;
}

function decodeMcpHeaderValue(value: string): string | undefined {
  const prefix = "=?base64?";
  const suffix = "?=";
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return value;
  try {
    const encoded = value.slice(prefix.length, -suffix.length);
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64") !== encoded) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

function mcpHeaderValuesEqual(
  type: McpHeaderAnnotation["type"],
  bodyValue: string,
  headerValue: string,
): boolean {
  if (type === "integer")
    return Number.isSafeInteger(Number(headerValue)) && Number(headerValue) === Number(bodyValue);
  return bodyValue === headerValue;
}

const ANALYTICS_TRUNCATION_NOTE =
  "Result exceeded maxBytes; narrow by profile/session/time range or lower limit.";

/** Keeps analytics output valid structured data: trims arrays or detail keys, never cuts JSON text. */
function fitAnalyticsResult(
  result: Record<string, unknown>,
  maxBytes: number,
): Record<string, unknown> {
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
  if (size(result) <= maxBytes) return { ...result, truncated: false };
  for (const key of ["events", "sessions"] as const) {
    const items = result[key];
    if (!Array.isArray(items)) continue;
    let kept: unknown[] = items;
    const build = () => ({
      ...result,
      [key]: kept,
      truncated: true,
      returned: kept.length,
      note: ANALYTICS_TRUNCATION_NOTE,
    });
    while (kept.length > 0 && size(build()) > maxBytes)
      kept = kept.slice(Math.ceil(kept.length / 4));
    return build();
  }
  const configs = isRecord(result.configs) ? result.configs : {};
  const slim = Object.fromEntries(
    Object.entries(configs).map(([configId, config]) => [
      configId,
      isRecord(config)
        ? Object.fromEntries(
            Object.entries(config).filter(
              ([key]) => key !== "tools" && key !== "commands" && key !== "failuresByCategory",
            ),
          )
        : config,
    ]),
  );
  const reduced = { ...result, configs: slim, truncated: true, note: ANALYTICS_TRUNCATION_NOTE };
  if (size(reduced) <= maxBytes) return reduced;
  return {
    mode: result.mode,
    matchedEvents: result.matchedEvents,
    configs: Object.keys(configs),
    truncated: true,
    note: ANALYTICS_TRUNCATION_NOTE,
  };
}

function completeToolResult(structuredContent: unknown): Record<string, unknown> {
  return {
    resultType: "complete",
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    _meta: SERVER_INFO_META,
  };
}
type TelemetryRuntime = import("./telemetry/types.js").TelemetryRuntimeContext;
let cachedStaticRuntime: TelemetryRuntime | undefined;

/** Fields that never change during the process lifetime are collected once. */
function staticTelemetryRuntime(): TelemetryRuntime {
  cachedStaticRuntime ??= {
    agentDirVersion: packageVersion,
    nodeMajor: Number(process.versions.node.split(".")[0]),
    os:
      process.platform === "darwin"
        ? "macos"
        : process.platform === "linux"
          ? "linux"
          : process.platform === "win32"
            ? "windows"
            : "other",
    arch: process.arch,
    nodeVersion: process.versions.node,
    ...linuxDistribution(),
    kernelVersion: release(),
    hostname: hostname(),
    username: userInfo().username,
  };
  return cachedStaticRuntime;
}

function telemetryRuntime(
  params: Record<string, unknown>,
  level: TelemetryLevel,
  headerProtocolVersion?: string | null,
): TelemetryRuntime {
  const meta = isRecord(params._meta) ? params._meta : undefined;
  const metaClient = meta?.["io.modelcontextprotocol/clientInfo"];
  const clientInfo = isRecord(params.clientInfo)
    ? params.clientInfo
    : isRecord(metaClient)
      ? metaClient
      : undefined;
  const metaVersion = meta?.["io.modelcontextprotocol/protocolVersion"];
  const protocolVersion =
    typeof params.protocolVersion === "string"
      ? params.protocolVersion
      : typeof metaVersion === "string"
        ? metaVersion
        : (headerProtocolVersion ?? undefined);
  return {
    ...staticTelemetryRuntime(),
    ...(typeof clientInfo?.name === "string" ? { mcpClientName: clientInfo.name } : {}),
    ...(typeof clientInfo?.version === "string" ? { mcpClientVersion: clientInfo.version } : {}),
    ...(protocolVersion ? { mcpProtocolVersion: protocolVersion } : {}),
    ...(level === "none"
      ? {}
      : {
          processId: process.pid,
          parentProcessId: process.ppid,
          processUptimeMs: Math.round(process.uptime() * 1000),
          memoryRssBytes: process.memoryUsage().rss,
        }),
  };
}

function linuxDistribution(): { distroId?: string; distroName?: string; distroVersion?: string } {
  if (process.platform !== "linux") return {};
  try {
    const values = Object.fromEntries(
      readFileSync("/etc/os-release", "utf8")
        .split("\n")
        .map((line) => line.match(/^([A-Z_]+)=(.*)$/))
        .filter((match): match is RegExpMatchArray => match !== null)
        .map((match) => [match[1], match[2]?.replace(/^"|"$/g, "")]),
    );
    return {
      ...(values.ID ? { distroId: values.ID } : {}),
      ...(values.PRETTY_NAME ? { distroName: values.PRETTY_NAME } : {}),
      ...(values.VERSION_ID ? { distroVersion: values.VERSION_ID } : {}),
    };
  } catch {
    return {};
  }
}

function telemetryHash(value: string): string {
  return telemetryHmac(value);
}

// A rough byte-based proxy, not a model-tokenizer count or Claude billing measurement.
function estimateTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, "utf8") / 4);
}

function toolTelemetryMetrics(
  toolName: string,
  result: Record<string, unknown>,
  seenOutputFingerprints: Set<string>,
): {
  affectedFiles?: number;
  truncated?: boolean;
  paginated?: boolean;
  outputFingerprint?: string;
  duplicateOutputBytes?: number;
  textOutputBytes?: number;
  uniqueFileCount?: number;
  files?: Array<{ pathHash: string; contentHash?: string; bytes: number }>;
} {
  const structured = result.structuredContent;
  if (!Array.isArray(structured) && !isRecord(structured)) {
    // Integration results (CodeGraph, Serena) carry no structured content; still measure them.
    const json = JSON.stringify(result);
    const fingerprint = telemetryHash(json);
    const bytes = Buffer.byteLength(json, "utf8");
    const duplicate = seenOutputFingerprints.has(fingerprint) ? bytes : 0;
    seenOutputFingerprints.add(fingerprint);
    return {
      outputFingerprint: fingerprint,
      duplicateOutputBytes: duplicate,
      ...(result.truncated === true ? { truncated: true } : {}),
    };
  }
  const paths = new Set<string>();
  const files = new Map<string, { pathHash: string; contentHash?: string; bytes: number }>();
  let truncated = false;
  let paginated = false;
  let textOutputBytes = 0;
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      textOutputBytes += Buffer.byteLength(value, "utf8");
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!isRecord(value)) return;
    if (typeof value.path === "string") {
      paths.add(value.path);
      const content = typeof value.content === "string" ? value.content : undefined;
      files.set(value.path, {
        pathHash: telemetryHash(value.path),
        ...(content === undefined ? {} : { contentHash: telemetryHash(content) }),
        bytes: content === undefined ? 0 : Buffer.byteLength(content, "utf8"),
      });
    }
    if (value.truncated === true) truncated = true;
    if (value.nextCursor !== undefined) paginated = true;
    for (const child of Object.values(value)) visit(child);
  };
  visit(structured);
  if (result.truncated === true) truncated = true;
  const outputJson = JSON.stringify(result);
  const outputFingerprint = telemetryHash(outputJson);
  const outputBytes = Buffer.byteLength(outputJson, "utf8");
  const duplicateOutputBytes = seenOutputFingerprints.has(outputFingerprint) ? outputBytes : 0;
  seenOutputFingerprints.add(outputFingerprint);
  return {
    ...(paths.size > 0 && /^(write|patch|delete|read|file)/.test(toolName)
      ? { affectedFiles: paths.size }
      : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(paginated ? { paginated: true } : {}),
    outputFingerprint,
    duplicateOutputBytes,
    textOutputBytes,
    uniqueFileCount: files.size,
    ...(files.size ? { files: [...files.values()].slice(0, 100) } : {}),
  };
}

function toolOutcome(
  result: Record<string, unknown>,
  count: number | undefined,
  truncated: boolean,
): "ok" | "empty" | "truncated" | "error" {
  if (result.isError === true) return "error";
  if (truncated) return "truncated";
  if (count === 0) return "empty";
  return "ok";
}

function commandExecutables(toolName: string, argumentsValue: unknown): { executables?: string[] } {
  if (toolName !== "run_command_batch" || !isRecord(argumentsValue)) return {};
  if (!Array.isArray(argumentsValue.commands)) return {};
  const names = argumentsValue.commands.flatMap((item) =>
    isRecord(item) && typeof item.command === "string" ? [item.command] : [],
  );
  return names.length > 0 ? { executables: names.slice(0, 10) } : {};
}

function commandTelemetryDescriptor(
  toolName: string,
): { family: string; operation: string } | undefined {
  if (toolName === "run_package_scripts_batch")
    return { family: "package-scripts", operation: "batch" };
  if (toolName === "run_command_batch") return { family: "command", operation: "batch" };
  if (toolName === "validate") return { family: "package-scripts", operation: "validate" };
  return undefined;
}

async function buildTelemetryProjectContext(
  root: string,
  codeGraph: CodeGraphIntegration,
): Promise<import("./telemetry/types.js").TelemetryProjectContext> {
  const overview = await projectOverview(root);
  const extension = overview.languages[0]?.extension;
  const language =
    extension === ".ts" || extension === ".tsx"
      ? "typescript"
      : extension === ".js" || extension === ".jsx"
        ? "javascript"
        : extension === ".py"
          ? "python"
          : extension === ".go"
            ? "go"
            : extension === ".rs"
              ? "rust"
              : extension === ".java"
                ? "java"
                : undefined;
  const packageManager = overview.packageManagers[0];
  const projectSize = overview.files < 100 ? "small" : overview.files < 1000 ? "medium" : "large";
  const capability = await codeGraph.capability();
  return {
    projectRoot: root,
    workingDirectory: process.cwd(),
    ...(language ? { language } : {}),
    ...(packageManager && ["npm", "pnpm", "yarn", "bun"].includes(packageManager)
      ? { packageManager: packageManager as "npm" | "pnpm" | "yarn" | "bun" }
      : {}),
    hasGit: overview.git.available,
    hasCodegraph: capability.installed && capability.indexed,
    projectSize,
  };
}

function timeoutMsArg(value: unknown): number {
  if (value === undefined) return 120000;
  if (!Number.isInteger(value) || (value as number) < 1000 || (value as number) > 600000)
    throw new Error("timeoutMs must be an integer between 1000 and 600000.");
  return value as number;
}

function batchOnError(value: unknown, fallback: BatchOnError): BatchOnError {
  if (value === undefined) return fallback;
  if (value === "continue" || value === "stop") return value;
  throw new Error("onError must be 'continue' or 'stop'.");
}

function okExitCodesArg(value: unknown): number[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 8 ||
    value.some((code) => !Number.isInteger(code) || code < 0 || code > 255)
  )
    throw new Error("okExitCodes must be 1 to 8 integers between 0 and 255.");
  return value as number[];
}

function resultCount(result: Record<string, unknown>): number | undefined {
  const structured = result.structuredContent;
  if (isRecord(structured) && Array.isArray(structured.items)) return structured.items.length;
  return Array.isArray(structured) ? structured.length : undefined;
}

function classifyTelemetryError(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.startsWith("unknown tool")) return "unknown_tool";
  if (
    message.includes("integration is unavailable") ||
    message.includes("is not installed") ||
    message.includes("process is not running") ||
    message.includes("analytics is disabled") ||
    message.includes("not indexed")
  )
    return "unavailable_integration";
  if (
    message.includes("not found") ||
    message.includes("enoent") ||
    message.includes("no such file") ||
    message.includes("does not exist")
  )
    return "not_found";
  if (message.includes("invalid") || message.includes("must be")) return "invalid_input";
  if (message.includes("blocked") || message.includes("not allowed")) return "authorization";
  if (message.includes("timeout") || message.includes("timed out")) return "timeout";
  if (message.includes("authentication") || message.includes("unauthorized"))
    return "authentication";
  return "execution";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isValidRequestId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}
function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`${name} must be an array of strings.`);
  return value;
}
function objectArray(value: unknown, name: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "object" || item === null))
    throw new Error(`${name} must be an array of objects.`);
  return value as Record<string, unknown>[];
}
function outputBytesArg(value: unknown): number {
  const result = value === undefined ? DEFAULT_OUTPUT_BYTES : Number(value);
  if (!Number.isInteger(result) || result < 1024 || result > 64_000)
    throw new Error("maxBytes must be an integer between 1024 and 64000.");
  return result;
}

function truncateText(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
  if (maxBytes <= 32) return { text: "", truncated: true };
  const buffer = Buffer.from(value, "utf8");
  return {
    text: `${buffer.subarray(0, Math.max(0, maxBytes - 32)).toString("utf8")}\n…[truncated]`,
    truncated: true,
  };
}

function boundCodeGraphResult(
  value: Record<string, unknown>,
  maxBytes: number,
): Record<string, unknown> {
  const originalBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (originalBytes <= maxBytes) return value;

  const trim = (item: unknown, budget: number): unknown => {
    if (typeof item === "string") return truncateText(item, Math.max(0, budget - 24)).text;
    if (Array.isArray(item)) {
      const output: unknown[] = [];
      for (const entry of item) {
        const candidate = [
          ...output,
          trim(entry, Math.max(128, Math.floor(budget / Math.max(1, item.length)))),
        ];
        if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > budget) break;
        output.push(candidate[candidate.length - 1]);
      }
      return output;
    }
    if (isRecord(item)) {
      const output: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(item)) {
        const remaining =
          budget - Buffer.byteLength(JSON.stringify(output), "utf8") - key.length - 8;
        if (remaining < 64) break;
        output[key] = trim(
          entry,
          Math.min(
            remaining,
            Math.max(128, Math.floor(budget / Math.max(1, Object.keys(item).length))),
          ),
        );
        if (Buffer.byteLength(JSON.stringify(output), "utf8") > budget) {
          delete output[key];
          break;
        }
      }
      return output;
    }
    return item;
  };

  const result = trim(value, Math.max(256, maxBytes - 256)) as Record<string, unknown>;
  const bounded: Record<string, unknown> = {
    ...result,
    truncated: true,
    originalBytes,
    budgetBytes: maxBytes,
    message:
      "CodeGraph output was trimmed to fit maxBytes. Narrow the query or lower maxFiles for more complete results.",
  };
  if (Buffer.byteLength(JSON.stringify(bounded), "utf8") <= maxBytes) return bounded;
  return {
    truncated: true,
    originalBytes,
    budgetBytes: maxBytes,
    message: "CodeGraph output exceeded maxBytes. Narrow the query or lower maxFiles.",
  };
}

function boundCommandResult(value: unknown, maxBytes: number): unknown {
  if (!isRecord(value)) return value;
  const command = typeof value.command === "string" ? value.command : "";
  const stdout = typeof value.stdout === "string" ? value.stdout : "";
  const stderr = typeof value.stderr === "string" ? value.stderr : "";
  let commandBudget = Buffer.byteLength(command, "utf8");
  let stdoutBudget = Buffer.byteLength(stdout, "utf8");
  let stderrBudget = Buffer.byteLength(stderr, "utf8");
  const candidate = () => ({
    ...value,
    command: truncateText(command, commandBudget).text,
    stdout: truncateText(stdout, stdoutBudget).text,
    stderr: truncateText(stderr, stderrBudget).text,
  });
  let result = candidate();
  while (
    Buffer.byteLength(JSON.stringify(result), "utf8") > maxBytes &&
    (commandBudget > 0 || stdoutBudget > 0 || stderrBudget > 0)
  ) {
    const excess = Buffer.byteLength(JSON.stringify(result), "utf8") - maxBytes;
    if (stdoutBudget >= stderrBudget && stdoutBudget > 0)
      stdoutBudget = Math.max(0, stdoutBudget - excess);
    else if (stderrBudget > 0) stderrBudget = Math.max(0, stderrBudget - excess);
    else commandBudget = Math.max(0, commandBudget - excess);
    result = candidate();
  }
  if (Buffer.byteLength(JSON.stringify(result), "utf8") <= maxBytes) return result;
  return { ...value, command: truncateText(command, commandBudget).text, stdout: "", stderr: "" };
}

function boundedItems<T>(items: T[], maxBytes: number): { items: T[]; truncated: boolean } {
  const selected: T[] = [];
  let bytes = 2;
  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    const separatorBytes = selected.length ? 1 : 0;
    if (selected.length && bytes + separatorBytes + itemBytes > maxBytes) break;
    if (!selected.length && bytes + itemBytes > maxBytes) break;
    selected.push(item);
    bytes += separatorBytes + itemBytes;
  }
  return { items: selected, truncated: selected.length < items.length };
}

function numberArg(value: unknown, fallback: number, max: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < 1 || result > max)
    throw new Error(`Value must be an integer between 1 and ${max}.`);
  return result;
}
function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  status: number,
  data?: unknown,
): Response {
  return json(
    { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } },
    status,
  );
}
function paginate<T>(items: T[], cursorValue: unknown): { items: T[]; nextCursor?: string } {
  const offset = decodeCursor(cursorValue);
  const page = items.slice(offset, offset + PAGE_SIZE);
  const nextOffset = offset + page.length;
  return nextOffset < items.length
    ? { items: page, nextCursor: encodeCursor(nextOffset) }
    : { items: page };
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function decodeCursor(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "string" || value.length > 128)
    throw new Error("Invalid pagination cursor.");
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64url").toString("utf8");
  } catch {
    throw new Error("Invalid pagination cursor.");
  }
  if (!/^(?:0|[1-9]\d*)$/.test(decoded)) throw new Error("Invalid pagination cursor.");
  const offset = Number(decoded);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid pagination cursor.");
  return offset;
}

async function notifyResourceChange(
  notify: (event: { type: "tools" | "prompts" | "resources"; uri?: string }) => void,
  root: string,
  pathValue: string,
  before: string[],
): Promise<void> {
  const after = await skillResourceUrisForPath(root, pathValue);
  if (before.length === 0 && after.length === 0) return;

  if (before.length === 0 || after.length === 0) {
    notify({ type: "resources" });
    return;
  }

  for (const uri of after) notify({ type: "resources", uri });
}

function subscriptionNotifications(value: unknown): Subscription["notifications"] {
  if (!isRecord(value)) throw new Error("subscriptions/listen notifications are required.");
  for (const key of ["toolsListChanged", "promptsListChanged", "resourcesListChanged"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean")
      throw new Error(`subscriptions/listen ${key} must be a boolean.`);
  }
  if (
    value.resourceSubscriptions !== undefined &&
    (!Array.isArray(value.resourceSubscriptions) ||
      value.resourceSubscriptions.some((uri) => typeof uri !== "string" || uri.length === 0))
  )
    throw new Error(
      "subscriptions/listen resourceSubscriptions must be an array of non-empty strings.",
    );

  const resourceSubscriptions =
    value.resourceSubscriptions === undefined ? [] : (value.resourceSubscriptions as string[]);
  return {
    toolsListChanged: value.toolsListChanged === true,
    promptsListChanged: value.promptsListChanged === true,
    resourcesListChanged: value.resourcesListChanged === true,
    resourceSubscriptions: new Set(resourceSubscriptions),
  };
}

function subscriptionResponse(
  id: string | number | null | undefined,
  notifications: Subscription["notifications"],
  subscriptions: Set<Subscription>,
): Response {
  let subscription: Subscription | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const honored = {
        toolsListChanged: notifications.toolsListChanged,
        promptsListChanged: notifications.promptsListChanged,
        resourcesListChanged: notifications.resourcesListChanged,
        resourceSubscriptions: notifications.resourceSubscriptions,
      };
      subscription = { id, controller, notifications: honored };
      subscriptions.add(subscription);
      writeSse(controller, {
        jsonrpc: "2.0",
        method: "notifications/subscriptions/acknowledged",
        params: {
          notifications: {
            ...(honored.toolsListChanged ? { toolsListChanged: true } : {}),
            ...(honored.promptsListChanged ? { promptsListChanged: true } : {}),
            ...(honored.resourcesListChanged ? { resourcesListChanged: true } : {}),
            ...(honored.resourceSubscriptions.size
              ? { resourceSubscriptions: [...honored.resourceSubscriptions] }
              : {}),
          },
        },
        _meta: { ...SERVER_INFO_META, [SUBSCRIPTION_ID_META]: id },
      });
    },
    cancel() {
      if (subscription) subscriptions.delete(subscription);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function writeSse(controller: ReadableStreamDefaultController<Uint8Array>, message: unknown): void {
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(message)}\n\n`));
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
