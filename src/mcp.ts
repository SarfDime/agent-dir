import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { hostname, release, userInfo } from "node:os";
import type { CodeGraphCapability } from "./codegraph.js";
import { CodeGraphIntegration } from "./codegraph.js";
import { summarizeTelemetry } from "./telemetry/aggregate.js";
import {
  fingerprintInput,
  telemetryHmac,
  usePersistentTelemetryKey,
} from "./telemetry/fingerprint.js";
import { TelemetryRecorder } from "./telemetry/recorder.js";
import { readTelemetryEvents } from "./telemetry/storage.js";
import type { TelemetryConfig, TelemetryLevel } from "./telemetry/types.js";
import { type BatchOnError, runBatch } from "./tools/batch.js";
import { findFiles, findReferences, findSymbol, searchCode } from "./tools/code.js";
import { checkCommand, spawnCapture } from "./tools/commands.js";
import { diagnostics } from "./tools/diagnostics.js";
import { applyFileChanges, readFile } from "./tools/files.js";
import { fileInfo, projectOverview } from "./tools/metadata.js";
import {
  packageScriptArgsProblem,
  packageScriptCapture,
  packageScriptLabel,
  packageScriptProblem,
} from "./tools/package-scripts.js";
import type { CommandPolicyConfig } from "./tools/policy.js";
import type { PathProtectionConfig } from "./tools/protected-paths.js";
import { formatRangeText, type ReadRangeResult, readRange } from "./tools/read.js";
import { detectSearchBackend } from "./tools/search.js";
import {
  getSkill,
  invalidateSkillDiscoveryCache,
  listSkillResources,
  listSkills,
  readSkillDirectory,
  readSkillResource,
  skillResourceUrisForPath,
} from "./tools/skills.js";
import { invalidateProjectFiles } from "./tools/walk.js";
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
const pathSchema = { type: "string", description: "Path relative to the exposed project root." };
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
  ["query"],
);

const baseTools: ToolDefinition[] = [
  tool(
    "read_range",
    "Read a line range from one UTF-8 project file. Returns the text with a header, plus {path, startLine, endLine, content, truncated, eof, totalLines, nextStartLine}. When truncated or not at the end, continue with nextStartLine. Pass ranges to read several ranges of the same file in one call. Prefer search_code with context when you only need lines around a match.",
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
        description: "Several ranges of the same file; replaces startLine/endLine.",
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
    "Find project paths by a glob pattern (`*`, `**`, `?`). A pattern without `/` matches file names at any depth (`mcp.ts` finds `src/mcp.ts`). Honors .gitignore inside git repositories. Returns {items, truncated}.",
    {
      pattern: stringSchema,
      maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
    },
    ["pattern"],
  ),
  tool(
    "search_code",
    "Search project text files (source, docs and configuration) by literal text or regex. Use paths/globs to scope the search and context to include surrounding lines so a follow-up read is rarely needed. Returns {items, returned, truncated, truncationReason, backend}; always check truncated. Honors .gitignore inside git repositories; lockfiles and minified files are skipped unless includeGenerated is true; binary files and files over 1 MB are skipped. Uses ripgrep when installed.",
    {
      query: stringSchema,
      regex: { type: "boolean", default: false },
      caseSensitive: { type: "boolean", default: false },
      paths: {
        type: "array",
        items: stringSchema,
        maxItems: 20,
        description: "Project-relative files or directories to search.",
      },
      globs: {
        type: "array",
        items: stringSchema,
        maxItems: 20,
        description:
          "Include globs such as *.ts, or exclude globs prefixed with ! such as !**/*.test.ts.",
      },
      context: { type: "integer", minimum: 0, maximum: 5, default: 0 },
      multiline: {
        type: "boolean",
        default: false,
        description:
          "Let the pattern span lines; with regex, '.' then also matches newlines. Works with both backends.",
      },
      includeGenerated: { type: "boolean", default: false },
      maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
    },
    ["query"],
  ),
  tool(
    "find_symbol",
    "Find likely definitions of a symbol by pattern (JS/TS, Python, Rust, Go, Java, C#, Kotlin, Swift, Ruby, PHP). Heuristic and case-sensitive. Returns {items, returned, truncated, backend}. Use read_range for context and find_references to trace usage.",
    {
      symbol: stringSchema,
      maxResults: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
    },
    ["symbol"],
  ),
  tool(
    "find_references",
    "Find whole-identifier occurrences of a symbol (case-sensitive text matching). This is lexical: it includes comments, strings and unrelated same-named identifiers. Returns {items, returned, truncated, backend}.",
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
  tool(
    "validate",
    "Validate the project. Diagnostics cover broken symlinks, invalid JSON and merge-conflict markers only; they do NOT include type checking or linting, so ok from level=diagnostics is not proof the code compiles. Use level=scripts or full to also run allowed package scripts (default: check, or typecheck and lint; full runs check and test). Scripts stop at the first failure and report status success, failure or skipped like run_package_scripts_batch.",
    {
      level: { type: "string", enum: ["diagnostics", "scripts", "full"], default: "diagnostics" },
      timeoutMs: timeoutMsSchema,
      scripts: { type: "array", items: stringSchema, minItems: 1, maxItems: 10 },
      maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
    },
  ),
  tool("file_info", "Return filesystem metadata for a project path.", { path: pathSchema }, [
    "path",
  ]),
  tool(
    "run_package_scripts_batch",
    "Run one or more explicitly allowed package scripts sequentially. Prefer the narrowest relevant script and avoid running full check/test when a targeted check answers the question. Default onError is stop: later scripts are reported as skipped after a failure. The whole batch is validated before anything runs.",
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
        description:
          "Script names, or { script, args } to pass extra arguments (for example a test path). Arguments are only accepted for scripts listed in the profile as argumentScripts.",
      },
      onError: onErrorSchema,
      timeoutMs: timeoutMsSchema,
      maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
    },
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
    ["commands"],
  ),
];

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
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
            const available = (await getAvailableTools()).map((item) => item.name);
            const suggestions = nearestNames(String(toolName), available);
            throw new Error(
              isToolDisabled(String(toolName), commandConfig.tools)
                ? `Tool '${toolName}' is disabled by this profile.`
                : `Unknown tool: ${toolName}.${
                    suggestions.length
                      ? ` Closest tools: ${suggestions.join(", ")}.`
                      : ` Available tools: ${available.join(", ")}.`
                  }`,
            );
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
          const argumentError = validateToolArguments(toolDefinition.inputSchema, argumentsValue);
          if (argumentError) {
            // Agent-friendly rejection: the caller sees the message and can correct the call,
            // which is what `isError` is for; a protocol error would end the turn instead.
            telemetryRequestErrorCategory = "invalid_input";
            recordRejectedToolCall(toolName, "invalid_input", argumentsValue);
            mcpSuccess = true;
            return trackedJson({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                resultType: "complete",
                isError: true,
                content: [{ type: "text", text: JSON.stringify({ error: argumentError }) }],
                _meta: SERVER_INFO_META,
              },
            });
          }
          sessionToolCallCount += 1;
          const startedAt = performance.now();
          try {
            const output = await callTool(
              toolName,
              argumentsValue,
              root,
              allowedScripts,
              packageManager,
              allowedCommands,
              blacklistedCommands,
              commandPolicy,
              pathProtection,
              argumentScripts,
              notify,
              request.signal,
              codeGraph,
              analyticsEnabled,
            );
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
                ...argumentShape(argumentsValue),
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
  // validate, run_command_batch and run_package_scripts_batch run programs that may touch anything.
  return { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
}

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

type ArgumentSchema = Record<string, unknown>;

function typeMatches(type: unknown, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
    default:
      return true;
  }
}

/**
 * Validates tool arguments against the advertised `inputSchema` before dispatch, so a bad call
 * fails with a message naming the argument instead of a coercion artefact inside a tool.
 */
export function validateToolArguments(
  schema: ArgumentSchema,
  value: unknown,
  path = "",
): string | undefined {
  const label = path || "arguments";
  if (Array.isArray(schema.anyOf)) {
    const errors = schema.anyOf.map((branch) =>
      isRecord(branch) ? validateToolArguments(branch, value, path) : undefined,
    );
    if (errors.some((error) => error === undefined)) return undefined;
    return (
      errors.find((error) => error !== undefined) ?? `${label} does not match any allowed shape.`
    );
  }
  if (schema.type !== undefined && !typeMatches(schema.type, value))
    return `'${label}' must be ${schema.type === "integer" ? "an integer" : `a ${String(schema.type)}`}.`;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    return `'${label}' must be one of ${schema.enum.map(String).join(", ")}.`;

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.trim().length < schema.minLength)
      return `'${label}' must be at least ${schema.minLength} characters.`;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
      return `'${label}' must be at most ${schema.maxLength} characters.`;
    return undefined;
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      return `'${label}' must be at least ${schema.minimum}.`;
    if (typeof schema.maximum === "number" && value > schema.maximum)
      return `'${label}' must be at most ${schema.maximum}.`;
    return undefined;
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      return `'${label}' needs at least ${schema.minItems} item(s).`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      return `'${label}' accepts at most ${schema.maxItems} item(s).`;
    if (isRecord(schema.items))
      for (const [index, entry] of value.entries()) {
        const error = validateToolArguments(schema.items, entry, `${label}[${index}]`);
        if (error) return error;
      }
    return undefined;
  }

  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const names = Object.keys(properties);
    // Report a misspelled argument before a missing one: it is the more actionable signal.
    for (const [key, entry] of Object.entries(value)) {
      const property = properties[key];
      if (!isRecord(property)) {
        if (schema.additionalProperties === false)
          return names.length
            ? `Unknown argument '${key}'. Valid arguments: ${names.join(", ")}.`
            : `Unknown argument '${key}'. This tool takes no arguments.`;
        continue;
      }
      const error = validateToolArguments(property, entry, path ? `${label}.${key}` : key);
      if (error) return error;
    }
    for (const required of Array.isArray(schema.required) ? schema.required : []) {
      const name = String(required);
      if (!(name in value)) return `'${path ? `${label}.${name}` : name}' is required.`;
    }
  }
  return undefined;
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

/** Guidance variants available for the workflow experiment (task 7.01). */
export type GuidanceVariant = "table" | "terse";

/**
 * `AGENT_DIR_GUIDANCE=terse` serves the shorter paragraph form. The variant is recorded on the
 * `initialize`/`server/discover` telemetry events so call mixes can be compared per variant.
 */
export function guidanceVariant(): GuidanceVariant {
  return process.env.AGENT_DIR_GUIDANCE === "terse" ? "terse" : "table";
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
      validation: ["validate", "targeted package script"],
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
    return `Agent Dir is the primary project interface: fewest calls, smallest output. Orient with project_context; locate with search_code or find_files; read with read_range; edit with apply_changes; verify with validate.${graphAvailable ? " Use codegraph_explore for behaviour, call flow and impact." : ""} Search before reading, read only the range you need, batch related calls, and never repeat a discovery. Scripts: ${scripts}. Commands: ${commands}. Blocked: ${blocked}.`;
  }
  return `Use Agent Dir as the primary project interface: fewest calls, smallest output.

- Orient, package, policy: project_context
- Find files: find_files. Find text or regex: search_code
- Definitions and usages: find_symbol, find_references${graphAvailable ? "\n- Behaviour, call flow, impact: codegraph_explore" : ""}
- Read: read_range. Edit: apply_changes. Check: validate, then a targeted script
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
  return `# Agent Dir operating instructions\n\nUse Agent Dir as the primary project interface. Optimize for correctness with the minimum necessary tool calls, filesystem reads, command output, and context.\n\n## Efficiency rules\n- Start with the narrowest operation that can answer the question. Do not dump the repository, large files, or full command output when a targeted operation is sufficient.\n- Prefer project_context for initial orientation; it combines project structure, package metadata, and execution policy in one call. \n- Prefer find_files for known filename patterns\n- Prefer search_code before reading files. Search first, then read only the relevant ranges.\n- Use CodeGraph first for non-trivial behavior, call/data flow, relationships, and impact analysis when available. If unavailable or failing, continue with native search tools.\n- Prefer read_range for a bounded section.\n- Prefer apply_changes for atomic writes, patches, and deletions. Do not rewrite an entire file when a small exact replacement is sufficient.\n- Batch related reads, writes, patches, searches, and commands into one tool call when practical.\n- Keep maxResults small unless the initial result is insufficient.\n- Prefer dedicated Agent Dir tools over run_command_batch because dedicated tools return structured, bounded results.\n- Prefer validate for lightweight diagnostics and explicitly requested package scripts.\n- Run the narrowest relevant validation after a change; escalate only when required by the task or release workflow.\n- Never repeat a successful discovery/read just because another tool can provide the same information.\n\n## Preferred workflow\n1. Orient: project_context.\n2. Locate: find_files/search_code/find_symbol as appropriate.\n3. Read: read_range.\n4. Modify: apply_changes for atomic writes, patches, and deletes.\n5. Validate: use validate for diagnostics or explicitly allowed package scripts for executable checks.\n6. Review: use allowlisted Git commands through run_command_batch when \`git\` is enabled.\n\n## Execution policy\nAllowed package scripts:\n${scripts}\n\nAllowed executables:\n${commands}\n\nBlacklisted command prefixes:\n${blacklist}\n\nOnly use commands from the execution policy. A blacklisted command prefix overrides an allowed executable. Do not attempt to bypass it with shells or alternate executables.\n\n## Git operations\nUse \`run_command_batch\` for Git commands only when \`git\` is in the allowed executable list. The command allowlist and blacklist still apply; avoid destructive operations unless explicitly requested.\n\n## Tool selection\n- Behavior/call-flow/impact: codegraph_explore first when available.\n- Semantic symbol navigation and callers: find_symbol, then find_references; fall back to search_code on empty or failed results.\n- Literal text and regex: search_code.\n- File discovery: project_context > find_files.\n- File reading: read_range.\n- Editing: apply_changes for atomic multi-file edits.\n- Validation: validate > targeted package script > full check/test.\n- Git operations: run_command_batch with the allowed \`git\` executable, respecting the configured blacklist.\n\n${analyticsEnabled ? "\n\n## Telemetry analytics\n- telemetry_analytics is enabled for this connector. Use mode=summary for cross-session metrics, mode=sessions for per-session tool counts and failures, and mode=events for bounded event sequences. Filter by profile/time/session before requesting event detail." : ""}\n\nThe execution policy and this guidance are generated from the running Agent Dir configuration; do not maintain a separate client-specific copy.${codeGraphSection}`;
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
  root: string,
  allowedScripts: string[],
  packageManager: "npm" | "pnpm" | "yarn" | "bun",
  allowedCommands: string[],
  blacklistedCommands: string[],
  commandPolicy: CommandPolicyConfig | undefined,
  pathProtection: PathProtectionConfig | undefined,
  argumentScripts: string[],
  notify: (event: { type: "tools" | "prompts" | "resources"; uri?: string }) => void,
  signal?: AbortSignal,
  codeGraph?: CodeGraphIntegration,
  analyticsEnabled = false,
): Promise<ToolCallOutput> {
  let payload: Record<string, unknown> = {};
  let contentText: string | undefined;
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
    return { payload: boundCodeGraphResult(result, maxBytes) };
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
    return { payload: fitAnalyticsResult(result, outputBytesArg(args.maxBytes)) };
  }
  switch (name) {
    case "read_range": {
      const maxBytes = outputBytesArg(args.maxBytes, READ_RANGE_DEFAULT_BYTES);
      const filePath = String(args.path);
      if (args.ranges !== undefined) {
        const ranges = objectArray(args.ranges, "ranges");
        if (ranges.length === 0 || ranges.length > 10)
          throw new Error("ranges must contain 1 to 10 items.");
        const results: ReadRangeResult[] = [];
        let remaining = maxBytes - 256;
        for (const [index, range] of ranges.entries()) {
          const share = Math.max(256, Math.floor(remaining / (ranges.length - index)));
          const result = await readRange(
            root,
            filePath,
            Number(range.startLine),
            Number(range.endLine),
            share,
          );
          results.push(result);
          remaining -= Buffer.byteLength(result.content, "utf8") + 200;
        }
        payload = { items: results, truncated: results.some((item) => item.truncated) };
        contentText = results.map(formatRangeText).join("\n\n");
      } else {
        if (args.startLine === undefined || args.endLine === undefined)
          throw new Error("startLine and endLine are required unless ranges is provided.");
        const result = await readRange(
          root,
          filePath,
          Number(args.startLine),
          Number(args.endLine),
          Math.max(1, maxBytes - 256),
        );
        payload = { ...result };
        contentText = formatRangeText(result);
      }
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
      payload = {
        items: applied.map((item) => {
          if (!isRecord(item)) return item;
          const { content: _content, previousContent: _previousContent, ...summary } = item;
          return summary;
        }),
        dryRun,
      };
      if (!dryRun) {
        invalidateProjectFiles(root);
        invalidateSkillDiscoveryCache(root);
        for (const p of affected) await notifyResourceChange(notify, root, p, before.get(p) ?? []);
      }
      break;
    }
    case "find_files": {
      const maxResults = numberArg(args.maxResults, 200, 1000);
      const found = await findFiles(root, String(args.pattern), maxResults);
      const bounded = boundedItems(found.files, outputBytesArg(args.maxBytes));
      payload = {
        items: bounded.items,
        truncated: bounded.truncated || found.truncated,
      };
      break;
    }
    case "search_code": {
      const paths = optionalStringArray(args.paths, "paths", 20);
      const globs = optionalStringArray(args.globs, "globs", 20);
      payload = {
        ...(await searchCode(root, String(args.query), {
          regex: args.regex === true,
          caseSensitive: args.caseSensitive === true,
          includeGenerated: args.includeGenerated === true,
          multiline: args.multiline === true,
          context: intArg(args.context, 0, 0, 5, "context"),
          maxResults: numberArg(args.maxResults, 200, 1000),
          maxBytes: outputBytesArg(args.maxBytes),
          ...(paths ? { paths } : {}),
          ...(globs ? { globs } : {}),
        })),
      };
      break;
    }
    case "find_symbol":
      payload = {
        ...(await findSymbol(root, String(args.symbol), {
          maxResults: numberArg(args.maxResults, 100, 500),
          maxBytes: outputBytesArg(args.maxBytes),
        })),
      };
      break;
    case "find_references":
      payload = {
        ...(await findReferences(root, String(args.symbol), {
          maxResults: numberArg(args.maxResults, 200, 1000),
          maxBytes: outputBytesArg(args.maxBytes),
        })),
      };
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
      const graphAvailable = (await codeGraph?.capability())?.status === "available";
      const bounded = truncateText(
        JSON.stringify({
          ...overview,
          package: pkg,
          execution: {
            allowedScripts: [...allowedScripts],
            commands: [...allowedCommands],
            blacklistedCommands: [...blacklistedCommands],
          },
          efficiency: efficiencyModel(graphAvailable, analyticsEnabled),
          search: detectSearchBackend(),
        }),
        Math.max(1, maxBytes - 128),
      );
      payload = bounded.truncated
        ? { result: bounded.text, truncated: true }
        : JSON.parse(bounded.text);
      break;
    }
    case "validate": {
      const level = args.level === undefined ? "diagnostics" : args.level;
      if (level !== "diagnostics" && level !== "scripts" && level !== "full")
        throw new Error("level must be 'diagnostics', 'scripts' or 'full'.");
      const maxResults = numberArg(args.maxResults, 200, 1000);
      const maxBytes = outputBytesArg(args.maxBytes);
      const timeoutMs = timeoutMsArg(args.timeoutMs);
      const diagnosticItems = await diagnostics(root, maxResults);
      let scripts: string[] = [];
      let note: string | undefined;
      if (level === "diagnostics") {
        if (args.scripts !== undefined)
          note =
            "scripts were ignored because level is diagnostics; use level scripts or full to run them.";
      } else if (args.scripts !== undefined) {
        scripts = stringArray(args.scripts, "scripts");
      } else {
        scripts = defaultValidationScripts(level, allowedScripts);
        if (scripts.length === 0)
          throw new Error(
            `level '${level}' needs scripts, and none of check, typecheck or lint is allowed. Allowed scripts: ${allowedScripts.join(", ") || "(none)"}.`,
          );
        note = `No scripts were given; ran ${scripts.join(", ")}.`;
      }
      if (scripts.length > 10) throw new Error("validate accepts at most 10 scripts per call.");
      const diagnosticsBudget = scripts.length > 0 ? Math.floor(maxBytes * 0.25) : maxBytes - 400;
      const boundedDiagnostics = boundedItems(diagnosticItems, Math.max(256, diagnosticsBudget));
      const diagnosticsOk = !diagnosticItems.some((item) => item.severity === "error");
      const batch =
        scripts.length > 0
          ? await runBatch(
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
              {
                onError: "stop",
                maxBytes: Math.max(1024, maxBytes - Math.max(256, diagnosticsBudget) - 300),
              },
            )
          : undefined;
      payload = {
        level,
        ok: diagnosticsOk && (batch?.ok ?? true),
        diagnostics: {
          ok: diagnosticsOk,
          count: diagnosticItems.length,
          issues: boundedDiagnostics.items,
          truncated: boundedDiagnostics.truncated,
        },
        ...(batch ? { scripts: batch } : {}),
        scriptsRequested: scripts,
        truncated: boundedDiagnostics.truncated || (batch?.truncated ?? false),
        ...(note ? { note } : {}),
      };
      break;
    }
    case "file_info":
      payload = await fileInfo(root, String(args.path));
      break;
    case "run_package_scripts_batch": {
      const requested = scriptRequests(args.scripts);
      const timeoutMs = timeoutMsArg(args.timeoutMs);
      if (requested.length > 10)
        throw new Error("run_package_scripts_batch accepts at most 10 scripts per call.");
      payload = {
        ...(await runBatch(
          requested.map(({ script, args: scriptArgs }) => ({
            label: packageScriptLabel(packageManager, script, scriptArgs ?? []),
            preflight: async () =>
              (await packageScriptProblem(root, script, allowedScripts)) ??
              packageScriptArgsProblem(script, scriptArgs, argumentScripts),
            execute: () =>
              packageScriptCapture(root, script, {
                timeoutMs,
                packageManager,
                ...(scriptArgs?.length ? { args: scriptArgs } : {}),
                ...(signal ? { signal } : {}),
              }),
          })),
          { onError: batchOnError(args.onError, "stop"), maxBytes: outputBytesArg(args.maxBytes) },
        )),
      };
      break;
    }
    case "run_command_batch": {
      const commands = objectArray(args.commands, "commands");
      const timeoutMs = timeoutMsArg(args.timeoutMs);
      if (commands.length > 10)
        throw new Error("run_command_batch accepts at most 10 commands per call.");
      payload = {
        ...(await runBatch(
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
        )),
      };
      break;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
  return contentText === undefined ? { payload } : { payload, text: contentText };
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

/**
 * Keeps analytics output valid structured data: trims arrays or detail keys, never cuts JSON text.
 * The budget is measured on the whole response envelope, because that is what the client pays for.
 */
function fitAnalyticsResult(
  result: Record<string, unknown>,
  maxBytes: number,
): Record<string, unknown> {
  const size = (value: Record<string, unknown>) =>
    Buffer.byteLength(JSON.stringify(toolResult(value)), "utf8");
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

/**
 * One representation per result. MCP requires a `content` block and treats `structuredContent`
 * as an optional duplicate; sending both doubled every tool response, so the payload is emitted
 * once as compact JSON (or as pre-rendered text when the tool produces a better reading form).
 */
interface ToolCallOutput {
  payload: Record<string, unknown>;
  /** Pre-rendered reading form; omitted tools fall back to compact JSON. */
  text?: string;
}

function toolResult(payload: Record<string, unknown>, text?: string): Record<string, unknown> {
  return {
    resultType: "complete",
    content: [{ type: "text", text: text ?? JSON.stringify(payload) }],
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
    ...(argumentsValue.dryRun === true ? { dryRun: true } : {}),
    ...(present("okExitCodes") ? { okExitCodes: true } : {}),
    ...(present("maxResults") || present("limit") ? { limit: true } : {}),
  };
  return Object.keys(shape).length ? { argShape: shape } : {};
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

function optionalStringArray(value: unknown, name: string, max: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`${name} must be an array of strings.`);
  if (value.length > max) throw new Error(`${name} accepts at most ${max} items.`);
  return value as string[];
}

function intArg(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return value as number;
}

/** Accepts script names or `{ script, args }` objects. */
function scriptRequests(value: unknown): Array<{ script: string; args?: string[] }> {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(
      "scripts must be a non-empty array of script names or { script, args } objects.",
    );
  return value.map((item) => {
    if (typeof item === "string") return { script: item };
    if (isRecord(item) && typeof item.script === "string")
      return {
        script: item.script,
        ...(item.args === undefined ? {} : { args: item.args as string[] }),
      };
    throw new Error(
      "Each script must be a name or an object with a script name and optional args.",
    );
  });
}

function defaultValidationScripts(level: string, allowedScripts: string[]): string[] {
  const allowed = (names: string[]) => names.filter((name) => allowedScripts.includes(name));
  if (level === "full") return allowed(["check", "test"]);
  return allowedScripts.includes("check") ? ["check"] : allowed(["typecheck", "lint"]);
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

function resultCount(payload: Record<string, unknown>): number | undefined {
  if (Array.isArray(payload.items)) return payload.items.length;
  return undefined;
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
  if (
    message.includes("guardrail") ||
    message.includes("is not allowed by this profile") ||
    message.includes("is blocked by this profile") ||
    message.includes("is protected") ||
    message.includes("protected path")
  )
    return "policy_denied";
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
function outputBytesArg(value: unknown, fallback = DEFAULT_OUTPUT_BYTES): number {
  const result = value === undefined ? fallback : Number(value);
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
