import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { hostname, release, userInfo } from "node:os";
import { classifyTelemetryError, classifyTelemetryReason } from "./classify-errors.js";
import type { CodeGraphCapability } from "./codegraph.js";
import { CodeGraphIntegration } from "./codegraph.js";
import { type GuidanceVariant, guidanceVariant } from "./guidance.js";
import {
  fingerprintInput,
  telemetryHmac,
  usePersistentTelemetryKey,
} from "./telemetry/fingerprint.js";
import { TelemetryRecorder } from "./telemetry/recorder.js";
import type {
  TelemetryConfig,
  TelemetryErrorCategory,
  TelemetryErrorReason,
  TelemetryJsonType,
  TelemetryLevel,
} from "./telemetry/types.js";
import { createToolHandlerTable } from "./tools/handlers/index.js";
import type { ToolCallOutput, ToolHandler, ToolRequestContext } from "./tools/handlers/types.js";
import { projectOverview } from "./tools/metadata.js";
import { ReadRangeHistory } from "./tools/read.js";
import {
  getSkill,
  listSkillResources,
  listSkills,
  readSkillDirectory,
  readSkillResource,
} from "./tools/skills.js";
import type { CommandConfig } from "./types.js";
import { describeJsonType, isRecord, validateToolArguments } from "./validation.js";

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
/** Reads are the largest token cost and are usually followed by more reads; allow bigger windows. */
const READ_RANGE_DEFAULT_BYTES = 16_000;
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
// Tool definitions are paid for on every model request, so a definition carries only what an
// agent needs to choose and call the tool: no human-facing `title`, no output schema. Results are
// returned as one text block (see `toolResult`), so an output schema would describe nothing the
// model can see.
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

const stringSchema = { type: "string" };
const stringArrayOrSingle = (maxItems: number) => ({
  anyOf: [{ type: "array", items: stringSchema, maxItems }, stringSchema],
});
const pathSchema = { type: "string", description: "Project-relative path." };
const objectOutput = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
});
const timeoutMsSchema = {
  type: "integer",
  minimum: 1000,
  maximum: 600000,
  default: 120000,
  description: "Per-item timeout.",
};
const okExitCodesSchema = {
  type: "array",
  items: { type: "integer", minimum: 0, maximum: 255 },
  minItems: 1,
  maxItems: 8,
};
const onErrorSchema = {
  type: "string",
  enum: ["continue", "stop"],
  description: "Stop or continue after failure.",
};

const codeGraphTool: ToolDefinition = tool(
  "codegraph_explore",
  "Use first for structure: explain behavior, trace call flow, map symbols or assess impact. Prefer over repeated grep/read loops. Use search_code/find_symbol/read_range for exact-text follow-up; treat returned source as read.",
  {
    query: { type: "string", minLength: 1 },
    maxFiles: { type: "integer", minimum: 1, maximum: 100, default: 10 },
    maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
  },
  ["query"],
);

const baseTools: ToolDefinition[] = [
  tool(
    "read_range",
    "Read UTF-8 ranges in a project file; pass up to 10. Continue with nextStartLine; use search_code context for nearby matches or skipIfUnchanged=true to omit unchanged repeats.",
    {
      path: pathSchema,
      startLine: { type: "integer", minimum: 1 },
      endLine: { type: "integer", minimum: 1 },
      ranges: {
        type: "array",
        maxItems: 10,
        items: objectOutput(
          { startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } },
          ["startLine", "endLine"],
        ),
        description: "Same-file ranges; replaces startLine/endLine.",
      },
      skipIfUnchanged: {
        type: "boolean",
        default: false,
        description: "Omit unchanged repeats in this session.",
      },
      maxBytes: {
        type: "integer",
        minimum: 1024,
        maximum: 64000,
        default: READ_RANGE_DEFAULT_BYTES,
      },
    },
    ["path"],
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
    ["changes"],
  ),
  tool(
    "find_files",
    "Find project paths by glob (`*`, `**`, `?`); bare names match any depth. Honors .gitignore. Empty results may suggest a nearby path.",
    {
      pattern: stringSchema,
      maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
    },
    ["pattern"],
  ),
  tool(
    "search_code",
    "Search project text by literal or regex. Scope with paths/globs and use context to avoid follow-up reads. Honors .gitignore; skips binaries and files over 1 MB. Lockfiles and minified files require includeGenerated. Truncation includes per-file counts.",
    {
      query: stringSchema,
      regex: { type: "boolean", default: false },
      caseSensitive: { type: "boolean", default: false },
      paths: {
        ...stringArrayOrSingle(20),
        description: "Project-relative path(s) to search.",
      },
      globs: {
        ...stringArrayOrSingle(20),
        description: "Include or exclude glob; prefix exclusions with !.",
      },
      context: { type: "integer", minimum: 0, maximum: 5, default: 0 },
      multiline: {
        type: "boolean",
        default: false,
        description: "Allow multiline matches in either backend.",
      },
      includeGenerated: { type: "boolean", default: false },
      format: {
        type: "string",
        enum: ["text", "json"],
        default: "text",
        description: "Text or JSON output.",
      },
      queries: {
        ...stringArrayOrSingle(5),
        description: "Patterns share maxBytes across result groups.",
      },
      maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
    },
    [],
    {
      anyOf: [
        { required: ["query"], properties: { query: stringSchema } },
        {
          required: ["queries"],
          properties: { queries: stringArrayOrSingle(5) },
        },
      ],
    },
  ),
  tool(
    "find_symbol",
    "Find likely case-sensitive definitions by pattern (JS/TS, Python, Rust, Go, Java, C#, Kotlin, Swift, Ruby, PHP). Use read_range for context.",
    {
      symbol: stringSchema,
      maxResults: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
    },
    ["symbol"],
  ),
  tool(
    "find_references",
    "Find case-sensitive whole-identifier matches, including comments, strings and unrelated same-named identifiers. Use find_symbol for likely definitions.",
    {
      symbol: stringSchema,
      maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
    },
    ["symbol"],
  ),
  tool(
    "project_context",
    "Return a compact LLM-oriented project snapshot combining project overview, package metadata, and active execution policy. Prefer this over separate orientation calls.",
    {
      maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
    },
  ),
  tool("file_info", "Return filesystem metadata for a project path.", { path: pathSchema }, [
    "path",
  ]),
  tool(
    "run_package_scripts_batch",
    "Run allowed package scripts sequentially without a shell. Success output defaults to the last 20 lines; maxBytes can return more. Prefer targeted scripts. Default onError=stop; validate the full batch first.",
    {
      scripts: {
        type: "array",
        minItems: 1,
        maxItems: 10,
        items: {
          anyOf: [
            stringSchema,
            objectOutput(
              { script: stringSchema, args: { type: "array", items: stringSchema, maxItems: 16 } },
              ["script"],
            ),
          ],
        },
        description: "Names or {script,args}; extra arguments require argumentScripts.",
      },
      onError: onErrorSchema,
      timeoutMs: timeoutMsSchema,
      maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
    },
    ["scripts"],
  ),
  tool(
    "run_command_batch",
    "Run up to 10 allowlisted commands sequentially without a shell. Prefer dedicated tools; default onError=continue. Set okExitCodes for expected non-zero results; item values override the batch default.",
    {
      commands: {
        type: "array",
        items: objectOutput(
          {
            command: stringSchema,
            args: { type: "array", items: stringSchema },
            okExitCodes: {
              ...okExitCodesSchema,
              description: "Overrides the batch default.",
            },
          },
          ["command"],
        ),
        minItems: 1,
        maxItems: 10,
      },
      okExitCodes: {
        ...okExitCodesSchema,
        description: "Success codes (default [0]); item values override.",
      },
      onError: onErrorSchema,
      timeoutMs: timeoutMsSchema,
      maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
    },
    ["commands"],
  ),
];

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
  schemaExtras: Record<string, unknown> = {},
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
      ...schemaExtras,
      additionalProperties: false,
    },
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
  analyticsEnabled = false,
): McpHandler {
  const codeGraph = codeGraphIntegration ?? new CodeGraphIntegration(root);
  const clientRegistry = createClientRegistry();
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
  const readHistories = new Map<string, ReadRangeHistory>();
  const readHistoryForSession = (sessionKey: string): ReadRangeHistory => {
    let history = readHistories.get(sessionKey);
    if (!history) history = new ReadRangeHistory(telemetryHash);
    readHistories.delete(sessionKey);
    readHistories.set(sessionKey, history);
    while (readHistories.size > MAX_TRACKED_READ_SESSIONS) {
      const oldest = readHistories.keys().next().value;
      if (oldest === undefined) break;
      readHistories.delete(oldest);
    }
    return history;
  };
  const invalidateReadHistory = async (relativePath: string): Promise<void> => {
    for (const history of readHistories.values()) await history.invalidate(root, relativePath);
  };
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
    const value = await availableTools(codeGraph, analyticsEnabled, commandConfig.tools);
    cachedTools = { expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS, value };
    return value;
  };
  // When an integration appears, fails or recovers, refresh the cached tool list and tell
  // subscribed clients so they never rely on a stale list.
  const refreshTools = (): void => {
    cachedTools = undefined;
    notify({ type: "tools" });
  };
  codeGraph.onChange = refreshTools;
  const telemetryProjectPromise =
    telemetry.level === "detailed" || telemetry.level === "diagnostic"
      ? buildTelemetryProjectContext(root, codeGraph).catch(() => undefined)
      : undefined;
  const allowedScripts = commandConfig.scripts?.allowedScripts ?? [];
  const argumentScripts = commandConfig.scripts?.argumentScripts ?? [];
  const packageManager = commandConfig.packageManager ?? "npm";
  const allowedCommands = commandConfig.commands ?? [];
  const blacklistedCommands = commandConfig.blacklistedCommands ?? [];
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
  const toolHandlers = createToolHandlerTable({
    root,
    allowedScripts,
    packageManager,
    allowedCommands,
    blacklistedCommands,
    commandPolicy: commandConfig.commandPolicy,
    pathProtection: commandConfig.protectedPaths,
    argumentScripts,
    notify,
    readHistoryForSession,
    invalidateReadHistory,
    codeGraph,
    analyticsEnabled,
    efficiencyModel,
    measureEnvelope: (value) => Buffer.byteLength(JSON.stringify(toolResult(value)), "utf8"),
  });

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
    let telemetryRequestErrorCategory: TelemetryErrorCategory | undefined;
    let telemetryRequestErrorReason: TelemetryErrorReason | undefined;
    let toolListMetrics: { toolCount: number; toolSetHash: string } | undefined;
    let guidanceVariantUsed: GuidanceVariant | undefined;
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
          ...(telemetryRequestErrorReason ? { errorReason: telemetryRequestErrorReason } : {}),
          ...(toolListMetrics ?? {}),
          ...(guidanceVariantUsed ? { guidanceVariant: guidanceVariantUsed } : {}),
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
    const clientContext = {
      sessionKey: request.headers.get("mcp-session-id")?.trim() || UNIDENTIFIED_SESSION,
      registry: clientRegistry,
    };
    runtime = telemetryRuntime(
      params,
      telemetry.level,
      request.headers.get("mcp-protocol-version"),
      clientContext,
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
      // Lifecycle negotiation: answer with the requested version when we support it; otherwise
      // offer the version we prefer.
      const negotiatedVersion = supportedVersions.includes(requestedVersion)
        ? requestedVersion
        : LEGACY_PROTOCOL_VERSION;
      mcpSuccess = true;
      const initializeCapability = capabilityModel({
        tools: (await getAvailableTools()).map((item) => item.name),
        codeGraph: await codeGraph.capability(),
        analyticsEnabled,
        allowedScripts,
        allowedCommands,
        blacklistedCommands,
      });
      guidanceVariantUsed = initializeCapability.document.guidanceVariant;
      const initializeResponse = trackedJson({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: negotiatedVersion,
          // Only capabilities that are implemented for the legacy handshake.
          capabilities: { tools: {}, resources: {} },
          serverInfo: SERVER_INFO,
          instructions: initializeCapability.instructions,
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
          {
            const model = capabilityModel({
              tools: (await getAvailableTools()).map((item) => item.name),
              codeGraph: await codeGraph.capability(),
              analyticsEnabled,
              allowedScripts,
              allowedCommands,
              blacklistedCommands,
            });
            guidanceVariantUsed = model.document.guidanceVariant;
            return trackedJson({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                resultType: "complete",
                supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
                capabilities: capabilities(),
                _meta: SERVER_INFO_META,
                instructions: model.instructions,
                capabilityModel: model.document,
                codeGraph: model.document.integrations.codegraph,
                ttlMs: DISCOVERY_CACHE_TTL_MS,
                cacheScope: "private",
              },
            });
          }
        case "tools/list": {
          const available = await getAvailableTools();
          const page = paginate(available, params.cursor);
          toolListMetrics = {
            toolCount: available.length,
            toolSetHash: telemetryHash(
              available
                .map((item) => item.name)
                .sort()
                .join(","),
            ),
          };
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
            category: TelemetryErrorCategory,
            rejected?: unknown,
            details: {
              reason?: TelemetryErrorReason;
              argumentName?: string;
              receivedType?: TelemetryJsonType;
            } = {},
          ): void => {
            const serialized = JSON.stringify(rejected ?? {});
            // Key names are recorded as sent: a client-invented `_raw` or `base64Args` is the whole
            // diagnostic signal. The privacy sanitizer still drops anything that is not
            // identifier-shaped, so this cannot persist arbitrary text.
            const argumentKeys = isRecord(rejected) ? Object.keys(rejected) : undefined;
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
                inputFingerprint: telemetryHash(fingerprintInput(tool, rejected ?? {})),
                errorCategory: category,
                ...(details.reason ? { errorReason: details.reason } : {}),
                ...(details.argumentName ? { argumentName: details.argumentName } : {}),
                ...(details.receivedType ? { receivedType: details.receivedType } : {}),
                ...(argumentKeys?.length ? { argumentKeys } : {}),
              },
              telemetryRuntime(
                params,
                telemetry.level,
                request.headers.get("mcp-protocol-version"),
                clientContext,
              ),
              telemetryProject,
            );
          };
          const toolDefinition = (await getAvailableTools()).find((item) => item.name === toolName);
          if (!toolDefinition) {
            recordRejectedToolCall("unknown", "unknown_tool", params.arguments);
            const available = (await getAvailableTools()).map((item) => item.name);
            const suggestions = nearestNames(String(toolName), available);
            throw new Error(
              isToolDisabled(String(toolName), commandConfig.tools)
                ? `Tool '${toolName}' is disabled by this profile.`
                : `Unknown tool: ${toolName}.${
                    REMOVED_TOOL_HINTS.get(String(toolName)) ??
                    (suggestions.length
                      ? ` Closest tools: ${suggestions.join(", ")}.`
                      : ` Available tools: ${available.join(", ")}.`)
                  }`,
            );
          }
          if (params.arguments !== undefined && !isRecord(params.arguments)) {
            telemetryRequestErrorCategory = "invalid_input";
            telemetryRequestErrorReason = "type_mismatch";
            const receivedType = describeJsonType(params.arguments);
            recordRejectedToolCall(toolName, "invalid_input", params.arguments, {
              reason: "type_mismatch",
              argumentName: "arguments",
              ...(receivedType === undefined ? {} : { receivedType }),
            });
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
            telemetryRequestErrorReason = "other";
            recordRejectedToolCall(toolName, "invalid_input", argumentsValue, {
              reason: "other",
            });
            return jsonRpcError(message.id ?? null, -32020, headerError, 400);
          }
          const argumentError = validateToolArguments(
            toolDefinition.inputSchema,
            argumentsValue,
            "",
            toolName,
          );
          if (argumentError) {
            // Agent-friendly rejection: the caller sees the message and can correct the call,
            // which is what `isError` is for; a protocol error would end the turn instead.
            telemetryRequestErrorCategory = "invalid_input";
            telemetryRequestErrorReason = argumentError.reason;
            recordRejectedToolCall(toolName, "invalid_input", argumentsValue, {
              reason: argumentError.reason,
              ...(argumentError.argumentName ? { argumentName: argumentError.argumentName } : {}),
              ...(argumentError.receivedType ? { receivedType: argumentError.receivedType } : {}),
            });
            mcpSuccess = true;
            return trackedJson({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                resultType: "complete",
                isError: true,
                content: [{ type: "text", text: JSON.stringify({ error: argumentError.message }) }],
                _meta: SERVER_INFO_META,
              },
            });
          }
          sessionToolCallCount += 1;
          const startedAt = performance.now();
          try {
            const output = await callTool(toolName, argumentsValue, toolHandlers, {
              sessionKey: clientContext.sessionKey,
              ...(request.signal ? { signal: request.signal } : {}),
            });
            const result = toolResult(output.payload, output.text);
            const durationMs = performance.now() - startedAt;
            const count = resultCount(output.payload);
            const serializedResult = JSON.stringify(result);
            const outputBytes = Buffer.byteLength(serializedResult, "utf8");
            const estimatedOutputTokens = estimateTokens(serializedResult);
            sessionOutputBytes += outputBytes;
            sessionEstimatedOutputTokens += estimatedOutputTokens;
            const runtime = telemetryRuntime(
              params,
              telemetry.level,
              request.headers.get("mcp-protocol-version"),
              clientContext,
            );
            const metrics = toolTelemetryMetrics(toolName, output.payload, seenOutputFingerprints);
            const outcome = toolOutcome(count, metrics.truncated === true);
            telemetryRecorder.record(
              {
                event: "tool_call",
                tool: toolName,
                requestIdHash: telemetryHash(String(message.id)),
                success: true,
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
                ...argumentShape(argumentsValue),
                ...(toolName === "read_range" ? { readLines: readSpan(argumentsValue) } : {}),
                ...(toolName === "codegraph_explore"
                  ? {
                      integration: "codegraph",
                      integrationStatus: (await codeGraph.capability()).status,
                    }
                  : {}),
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
              clientContext,
            );
            const errorCategory = classifyTelemetryError(error);
            const errorReason = classifyTelemetryReason(error);
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
                ...argumentShape(argumentsValue),
                errorCategory,
                ...(errorReason ? { errorReason } : {}),
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
            const model = capabilityModel({
              tools: (await getAvailableTools()).map((item) => item.name),
              codeGraph: await codeGraph.capability(),
              analyticsEnabled,
              allowedScripts,
              allowedCommands,
              blacklistedCommands,
            });
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
                      model.document,
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
            const model = capabilityModel({
              tools: (await getAvailableTools()).map((item) => item.name),
              codeGraph: await codeGraph.capability(),
              analyticsEnabled,
              allowedScripts,
              allowedCommands,
              blacklistedCommands,
            });
            return trackedJson({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                resultType: "complete",
                contents: [
                  {
                    uri: CAPABILITIES_URI,
                    mimeType: "application/json",
                    text: JSON.stringify(model.document, null, 2),
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
                {
                  type: "text",
                  text: JSON.stringify({
                    error: error instanceof Error ? error.message : String(error),
                  }),
                },
              ],
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
  };

  return handler;
}

/** Hints for clients (never a security control): which tools only read, and which may change things. */
const READ_ONLY_TOOLS = new Set([
  "project_context",
  "file_info",
  "read_range",
  "find_files",
  "search_code",
  "find_symbol",
  "find_references",
  "codegraph_explore",
  "telemetry_analytics",
]);

export function toolAnnotations(name: string): Record<string, unknown> {
  if (READ_ONLY_TOOLS.has(name)) return { readOnlyHint: true, openWorldHint: false };
  if (name === "apply_changes")
    return {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    };
  // run_command_batch and run_package_scripts_batch run programs that may touch anything.
  return { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
}

/** Tools removed on purpose: name the replacement instead of guessing the closest tool. */
const REMOVED_TOOL_HINTS = new Map([
  [
    "validate",
    " validate was removed; run an allowed package script such as check with run_package_scripts_batch.",
  ],
]);

/** Plain Levenshtein distance, used only to suggest a tool name to a confused agent. */
function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j] ?? 0;
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      previous[j] = Math.min((previous[j] ?? 0) + 1, (previous[j - 1] ?? 0) + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return previous[right.length] ?? right.length;
}

/** Up to three advertised tool names closest to a mistyped one. */
export function nearestNames(name: string, available: string[], limit = 3): string[] {
  const needle = name.toLowerCase();
  const threshold = Math.max(2, Math.floor(needle.length / 3));
  return available
    .map((candidate) => ({
      candidate,
      distance: editDistance(needle, candidate.toLowerCase()),
    }))
    .filter((entry) => entry.distance <= threshold)
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

/** True when the profile's tool selection removes this tool. */
export function isToolDisabled(name: string, selection: CommandConfig["tools"]): boolean {
  if (selection?.disabled?.includes(name)) return true;
  const sets = new Set(selection?.disabledSets ?? []);
  if (sets.has("codegraph") && name === "codegraph_explore") return true;
  if (sets.has("analytics") && name === "telemetry_analytics") return true;
  if (sets.has("filesystem") && ["read_range", "find_files", "file_info"].includes(name))
    return true;
  if (
    sets.has("search") &&
    ["search_code", "find_symbol", "find_references", "codegraph_explore"].includes(name)
  )
    return true;
  if (sets.has("commands") && ["run_command_batch", "run_package_scripts_batch"].includes(name))
    return true;
  return false;
}

async function availableTools(
  codeGraph: CodeGraphIntegration,
  analyticsEnabled = false,
  selection: CommandConfig["tools"] = undefined,
): Promise<ToolDefinition[]> {
  const disabled = new Set(selection?.disabled ?? []);
  const disabledSets = new Set(selection?.disabledSets ?? []);
  const isDisabled = (name: string): boolean => isToolDisabled(name, selection);
  const capability =
    !disabledSets.has("codegraph") && !disabled.has("codegraph_explore")
      ? await codeGraph.capability()
      : undefined;
  const codeGraphTools = capability?.status === "available" ? [codeGraphTool] : [];
  const candidates = [
    ...baseTools,
    ...codeGraphTools,
    ...(analyticsEnabled ? [telemetryAnalyticsTool] : []),
  ];
  return candidates
    .filter((item) => !isDisabled(item.name))
    .map((item) => ({ ...item, annotations: toolAnnotations(item.name) }));
}

const telemetryAnalyticsTool: ToolDefinition = tool(
  "telemetry_analytics",
  "Analyze locally persisted Agent Dir telemetry across all profiles and sessions. Summary mode defaults to compact rates, top issues and a per-client split; set view='full' for full tables. excludeClients removes matching clients; event mode returns bounded sanitized records. Available only when Agent Dir is started with --analytics.",
  {
    mode: { type: "string", enum: ["summary", "sessions", "events"], default: "summary" },
    view: {
      type: "string",
      enum: ["compact", "full"],
      default: "compact",
      description: "Summary view only; full includes the per-tool and per-command tables.",
    },
    profile: { type: "string", maxLength: 100 },
    session: { type: "string", maxLength: 100 },
    client: {
      type: "string",
      maxLength: 100,
      description:
        "Only events from this MCP client, by name or name@version (for example better-deepseek@0.1.15).",
    },
    excludeClients: {
      type: "array",
      items: { type: "string", maxLength: 100 },
      maxItems: 20,
      description: "Exclude matching MCP clients; each selector uses the same matching as client.",
    },
    since: { type: "string", description: "Optional ISO timestamp lower bound." },
    until: { type: "string", description: "Optional ISO timestamp upper bound." },
    limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
    maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
  },
);

interface CapabilityDocument {
  version: string;
  tools: string[];
  resources: string[];
  integrations: {
    codegraph: { status: string; detail?: string; tools: string[] };
  };
  execution: {
    allowedScripts: string[];
    commands: string[];
    blacklistedCommands: string[];
  };
  efficiency: {
    preferred: Record<string, unknown>;
    avoid: string[];
  };
  guidanceVariant: GuidanceVariant;
}

interface CapabilityModel {
  document: CapabilityDocument;
  instructions: string;
}

const INLINE_LIST_LIMIT = 12;

function inlineList(items: string[]): string {
  if (items.length === 0) return "none";
  if (items.length <= INLINE_LIST_LIMIT) return items.join(", ");
  return `${items.slice(0, INLINE_LIST_LIMIT).join(", ")} and ${items.length - INLINE_LIST_LIMIT} more`;
}

function bulletList(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- none";
}

/** Preferred workflow and anti-patterns, shared by every capability surface. */
function efficiencyModel(
  codeGraphAvailable: boolean,
  analyticsEnabled: boolean,
): CapabilityDocument["efficiency"] {
  return {
    preferred: {
      orientation: "project_context",
      ...(codeGraphAvailable ? { structuralAnalysis: "codegraph_explore" } : {}),
      focusedReading: "read_range",
      discovery: ["find_files", "search_code"],
      symbolNavigation: ["find_symbol", "find_references"],
      reading: ["read_range"],
      editing: ["apply_changes"],
      validation: ["targeted package script"],
      ...(analyticsEnabled ? { telemetryAnalytics: "telemetry_analytics" } : {}),
    },
    avoid: [
      "recursive discovery when targeted search is enough",
      "whole-file reads when a line range is enough",
      "full-repository diffs when a path-scoped diff is enough",
      "expensive validation when a targeted check answers the question",
      "generic command execution when a dedicated Agent Dir tool exists, except allowlisted Git operations",
      ...(codeGraphAvailable
        ? ["repeated grep/read loops for structural questions already answered by CodeGraph"]
        : []),
    ],
  };
}

/** The short guidance every client gets; long-form details live in the instructions resource. */
function capabilityInstructions(
  document: CapabilityDocument,
  variant: GuidanceVariant = guidanceVariant(),
): string {
  const graphAvailable = document.integrations.codegraph.status === "available";
  const scripts = inlineList(document.execution.allowedScripts);
  const commands = inlineList(document.execution.commands);
  const blocked = inlineList(document.execution.blacklistedCommands);
  if (variant === "terse") {
    return `Agent Dir is the primary project interface: fewest calls, smallest output. Orient with project_context; locate with search_code or find_files; read with read_range; edit with apply_changes; verify with a targeted package script.${graphAvailable ? " Use codegraph_explore for behaviour, call flow and impact." : ""} Search before reading, read only the range you need, batch related calls, and never repeat a discovery. Scripts: ${scripts}. Commands: ${commands}. Blocked: ${blocked}.`;
  }
  return `Use Agent Dir as the primary project interface: fewest calls, smallest output.

- Orient, package, policy: project_context
- Find files: find_files. Find text or regex: search_code
- Definitions and usages: find_symbol, find_references${graphAvailable ? "\n- Behaviour, call flow, impact: codegraph_explore" : ""}
- Read: read_range. Edit: apply_changes. Check: a targeted package script
- Scripts: run_package_scripts_batch. Commands: run_command_batch

Search before reading, read only the range you need, batch related calls, and never repeat a discovery that already answered the question.

Allowed scripts: ${scripts}
Allowed commands: ${commands}
Blocked prefixes: ${blocked}`;
}

/**
 * One capability model. `initialize`, `server/discover`, the `agent-dir://capabilities` resource
 * and `project_context` all render it, so the four surfaces cannot disagree.
 */
function capabilityModel(input: {
  tools: string[];
  codeGraph: CodeGraphCapability;
  analyticsEnabled: boolean;
  allowedScripts: string[];
  allowedCommands: string[];
  blacklistedCommands: string[];
}): CapabilityModel {
  const graphAvailable = input.codeGraph.status === "available";
  const variant = guidanceVariant();
  const document: CapabilityDocument = {
    version: packageVersion,
    tools: [...input.tools],
    resources: [INSTRUCTIONS_URI, CAPABILITIES_URI],
    integrations: {
      codegraph: {
        status: input.codeGraph.status,
        ...(input.codeGraph.detail ? { detail: input.codeGraph.detail } : {}),
        tools: graphAvailable ? ["codegraph_explore"] : [],
      },
    },
    execution: {
      allowedScripts: [...input.allowedScripts],
      commands: [...input.allowedCommands],
      blacklistedCommands: [...input.blacklistedCommands],
    },
    efficiency: efficiencyModel(graphAvailable, input.analyticsEnabled),
    guidanceVariant: variant,
  };
  return { document, instructions: capabilityInstructions(document, variant) };
}

/** Long-form instructions served from the `agent-dir://instructions` resource. */
function buildAgentInstructions(
  document: CapabilityDocument,
  codeGraph: CodeGraphCapability,
  analyticsEnabled = false,
): string {
  const scripts = bulletList(document.execution.allowedScripts);
  const commands = bulletList(document.execution.commands);
  const blacklist = bulletList(document.execution.blacklistedCommands);
  const codeGraphSection =
    codeGraph.status === "available" ||
    codeGraph.status === "startup_failed" ||
    codeGraph.status === "runtime_failed"
      ? "\n\n## CodeGraph\n- CodeGraph is an optional code-intelligence backend for this project.\n- For non-trivial code understanding, call `codegraph_explore` before grep/search/read loops to explain behavior, trace call/data flow, map symbol relationships, or assess change impact. - Treat returned source as already read; do not re-run searches without a concrete gap.\n- Agent Dir pins CodeGraph to this project root; do not attempt to select another project.\n- Current status: " +
        codeGraph.status +
        (codeGraph.detail ? ` — ${codeGraph.detail}` : "") +
        "."
      : "";
  return `# Agent Dir operating instructions\n\nUse Agent Dir as the primary project interface. Optimize for correctness with the minimum necessary tool calls, filesystem reads, command output, and context.\n\n## Efficiency rules\n- Start with the narrowest operation that can answer the question. Do not dump the repository, large files, or full command output when a targeted operation is sufficient.\n- Prefer project_context for initial orientation; it combines project structure, package metadata, and execution policy in one call. \n- Prefer find_files for known filename patterns\n- Prefer search_code before reading files. Search first, then read only the relevant ranges.\n- Use CodeGraph first for non-trivial behavior, call/data flow, relationships, and impact analysis when available. If unavailable or failing, continue with native search tools.\n- Prefer read_range for a bounded section.\n- Prefer apply_changes for atomic writes, patches, and deletions. Do not rewrite an entire file when a small exact replacement is sufficient.\n- Batch related reads, writes, patches, searches, and commands into one tool call when practical.\n- Keep maxResults small unless the initial result is insufficient.\n- Prefer dedicated Agent Dir tools over run_command_batch because dedicated tools return structured, bounded results.\n- Run the narrowest relevant validation after a change; escalate only when required by the task or release workflow.\n- Never repeat a successful discovery/read just because another tool can provide the same information.\n\n## Preferred workflow\n1. Orient: project_context.\n2. Locate: find_files/search_code/find_symbol as appropriate.\n3. Read: read_range.\n4. Modify: apply_changes for atomic writes, patches, and deletes.\n5. Validate: run the narrowest allowed package script that checks the change.\n6. Review: use allowlisted Git commands through run_command_batch when \`git\` is enabled.\n\n## Execution policy\nAllowed package scripts:\n${scripts}\n\nAllowed executables:\n${commands}\n\nBlacklisted command prefixes:\n${blacklist}\n\nOnly use commands from the execution policy. A blacklisted command prefix overrides an allowed executable. Do not attempt to bypass it with shells or alternate executables.\n\n## Git operations\nUse \`run_command_batch\` for Git commands only when \`git\` is in the allowed executable list. The command allowlist and blacklist still apply; avoid destructive operations unless explicitly requested.\n\n## Tool selection\n- Behavior/call-flow/impact: codegraph_explore first when available.\n- Semantic symbol navigation and callers: find_symbol, then find_references; fall back to search_code on empty or failed results.\n- Literal text and regex: search_code.\n- File discovery: project_context > find_files.\n- File reading: read_range.\n- Editing: apply_changes for atomic multi-file edits.\n- Validation: targeted package script > full check/test.\n- Git operations: run_command_batch with the allowed \`git\` executable, respecting the configured blacklist.\n\n${analyticsEnabled ? "\n\n## Telemetry analytics\n- telemetry_analytics is enabled for this connector. Use mode=summary for cross-session metrics, mode=sessions for per-session tool counts and failures, and mode=events for bounded event sequences. Filter by profile/time/session before requesting event detail." : ""}\n\nThe execution policy and this guidance are generated from the running Agent Dir configuration; do not maintain a separate client-specific copy.${codeGraphSection}`;
}

function capabilities(): Record<string, unknown> {
  return {
    tools: { listChanged: true },
    resources: { listChanged: true, subscribe: true },
    extensions: { "io.modelcontextprotocol/skills": { directoryRead: true } },
  };
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  handlers: Record<string, ToolHandler>,
  request: ToolRequestContext,
): Promise<ToolCallOutput> {
  const handler = handlers[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  return handler(args, request);
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

/**
 * One representation per result. MCP requires a `content` block and treats `structuredContent`
 * as an optional duplicate; sending both doubled every tool response, so the payload is emitted
 * once as compact JSON (or as pre-rendered text when the tool produces a better reading form).
 */
function toolResult(payload: Record<string, unknown>, text?: string): Record<string, unknown> {
  // No `_meta`: the client already learned the server name and version from `initialize` or
  // `server/discover`, and repeating it costs 84 bytes on every tool result.
  return {
    resultType: "complete",
    content: [{ type: "text", text: text ?? JSON.stringify(payload) }],
  };
}
type TelemetryRuntime = import("./telemetry/types.js").TelemetryRuntimeContext;
let cachedStaticRuntime: TelemetryRuntime | undefined;

/** Identity a client reports about itself; carried across its own requests, never shared. */
interface ClientIdentity {
  name?: string;
  version?: string;
}

/** Key used when a request carries no `Mcp-Session-Id` header. */
const UNIDENTIFIED_SESSION = "unidentified";

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

/**
 * Client identities seen by one handler. Clients that send a `Mcp-Session-Id` are tracked
 * separately; a client that never sends one is tracked once, because a
 * request without an identity cannot be attributed to a session at all. The identity is only used
 * when the request itself carries no `clientInfo`, so a client that identifies every request is
 * always attributed to itself.
 */
interface ClientRegistry {
  bySession: Map<string, ClientIdentity>;
  withoutSession?: ClientIdentity;
}

const MAX_TRACKED_CLIENT_SESSIONS = 32;
const MAX_TRACKED_READ_SESSIONS = 32;

function createClientRegistry(): ClientRegistry {
  return { bySession: new Map() };
}

function rememberClient(
  registry: ClientRegistry,
  sessionKey: string,
  identity: ClientIdentity,
): void {
  if (sessionKey === UNIDENTIFIED_SESSION) {
    registry.withoutSession = identity;
    return;
  }
  registry.bySession.delete(sessionKey);
  registry.bySession.set(sessionKey, identity);
  while (registry.bySession.size > MAX_TRACKED_CLIENT_SESSIONS) {
    const oldest = registry.bySession.keys().next().value;
    if (oldest === undefined) break;
    registry.bySession.delete(oldest);
  }
}

function lookupClient(registry: ClientRegistry, sessionKey: string): ClientIdentity | undefined {
  return sessionKey === UNIDENTIFIED_SESSION
    ? registry.withoutSession
    : registry.bySession.get(sessionKey);
}

function telemetryRuntime(
  params: Record<string, unknown>,
  level: TelemetryLevel,
  headerProtocolVersion?: string | null,
  clientContext?: { sessionKey: string; registry: ClientRegistry },
): TelemetryRuntime {
  const meta = isRecord(params._meta) ? params._meta : undefined;
  const metaClient = meta?.["io.modelcontextprotocol/clientInfo"];
  const reportedClient = isRecord(params.clientInfo)
    ? params.clientInfo
    : isRecord(metaClient)
      ? metaClient
      : undefined;
  const reportedIdentity: ClientIdentity = {
    ...(typeof reportedClient?.name === "string" ? { name: reportedClient.name } : {}),
    ...(typeof reportedClient?.version === "string" ? { version: reportedClient.version } : {}),
  };
  if (
    clientContext &&
    (reportedIdentity.name !== undefined || reportedIdentity.version !== undefined)
  )
    rememberClient(clientContext.registry, clientContext.sessionKey, reportedIdentity);
  // Prefer what this request said; otherwise use what the same session said earlier.
  const clientInfo =
    reportedIdentity.name !== undefined || reportedIdentity.version !== undefined
      ? reportedIdentity
      : clientContext
        ? lookupClient(clientContext.registry, clientContext.sessionKey)
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
  payload: Record<string, unknown>,
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
  visit(payload);
  if (payload.truncated === true) truncated = true;
  const skipped = Array.isArray(payload.items)
    ? payload.items.filter((item) => isRecord(item) && item.status === "skipped").length
    : 0;
  const outputJson = JSON.stringify(payload);
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
    ...(skipped > 0 ? { skippedCount: skipped } : {}),
    outputFingerprint,
    duplicateOutputBytes,
    textOutputBytes,
    uniqueFileCount: files.size,
    ...(files.size ? { files: [...files.values()].slice(0, 100) } : {}),
  };
}

/**
 * Booleans describing which optional arguments were supplied. Values are never recorded, so this
 * is safe at every level and sufficient to see whether guidance changes how agents call tools.
 */
function argumentShape(argumentsValue: unknown): {
  argShape?: NonNullable<import("./telemetry/types.js").TelemetryToolEvent["argShape"]>;
} {
  if (!isRecord(argumentsValue)) return {};
  const present = (key: string): boolean =>
    argumentsValue[key] !== undefined && argumentsValue[key] !== null;
  const nonEmpty = (key: string): boolean => {
    const value = argumentsValue[key];
    return Array.isArray(value) ? value.length > 0 : present(key);
  };
  const shape: NonNullable<import("./telemetry/types.js").TelemetryToolEvent["argShape"]> = {
    ...(argumentsValue.regex === true ? { regex: true } : {}),
    ...(argumentsValue.caseSensitive === true ? { caseSensitive: true } : {}),
    ...(nonEmpty("paths") ? { paths: true } : {}),
    ...(nonEmpty("globs") ? { globs: true } : {}),
    ...(typeof argumentsValue.context === "number" && argumentsValue.context > 0
      ? { context: true }
      : {}),
    ...(argumentsValue.multiline === true ? { multiline: true } : {}),
    ...(nonEmpty("ranges") ? { ranges: true } : {}),
    ...(nonEmpty("queries") ? { queries: true } : {}),
    ...(argumentsValue.dryRun === true ? { dryRun: true } : {}),
    ...(argumentsValue.skipIfUnchanged === true ? { skipIfUnchanged: true } : {}),
    ...(present("okExitCodes") ? { okExitCodes: true } : {}),
    ...(present("maxResults") || present("limit") ? { limit: true } : {}),
  };
  return Object.keys(shape).length ? { argShape: shape } : {};
}

/**
 * Total lines a `read_range` call asked for, summed over ranges. Line counts carry no content, so
 * they are safe to record and they are the only way to tell whether reads are too big or merely
 * too frequent.
 */
function readSpan(argumentsValue: unknown): number {
  if (!isRecord(argumentsValue)) return 0;
  const span = (start: unknown, end: unknown): number => {
    const from = Number(start);
    const to = Number(end);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
    return Math.max(0, Math.min(1_000_000, Math.floor(to) - Math.floor(from) + 1));
  };
  if (Array.isArray(argumentsValue.ranges))
    return argumentsValue.ranges.reduce<number>(
      (total, range) => total + (isRecord(range) ? span(range.startLine, range.endLine) : 0),
      0,
    );
  return span(argumentsValue.startLine, argumentsValue.endLine);
}

function toolOutcome(
  count: number | undefined,
  truncated: boolean,
): "ok" | "empty" | "truncated" | "error" {
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

function resultCount(payload: Record<string, unknown>): number | undefined {
  if (Array.isArray(payload.items)) return payload.items.length;
  return undefined;
}

function isValidRequestId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
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
