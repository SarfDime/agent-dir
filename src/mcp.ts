import { randomUUID } from "node:crypto";
import { classifyTelemetryError, classifyTelemetryReason } from "./classify-errors.js";
import { CodeGraphIntegration } from "./codegraph.js";
import type { GuidanceVariant } from "./guidance.js";
import {
  buildAgentInstructions,
  CAPABILITIES_URI,
  capabilities,
  capabilityModel,
  efficiencyModel,
  INSTRUCTIONS_URI,
} from "./mcp-capabilities.js";
import { validateMcpParamHeaders } from "./mcp-headers.js";
import type { JsonRpcRequest, Subscription } from "./mcp-protocol.js";
import {
  isValidRequestId,
  jsonRpcError,
  paginate,
  SERVER_INFO,
  SERVER_INFO_META,
  SUBSCRIPTION_ID_META,
  subscriptionNotifications,
  subscriptionResponse,
  writeSse,
} from "./mcp-protocol.js";
import type { ToolDefinition } from "./mcp-tools.js";
import { availableTools, isToolDisabled, nearestNames, REMOVED_TOOL_HINTS } from "./mcp-tools.js";
import { fingerprintInput, usePersistentTelemetryKey } from "./telemetry/fingerprint.js";
import { TelemetryRecorder } from "./telemetry/recorder.js";

export { validateMcpParamHeaders } from "./mcp-headers.js";

export { isToolDisabled, nearestNames, toolAnnotations } from "./mcp-tools.js";

import type { TelemetryRuntime } from "./mcp-telemetry.js";
import {
  argumentShape,
  buildTelemetryProjectContext,
  commandExecutables,
  commandTelemetryDescriptor,
  createClientRegistry,
  estimateTokens,
  MAX_TRACKED_READ_SESSIONS,
  readSpan,
  resultCount,
  telemetryHash,
  telemetryRuntime,
  toolOutcome,
  toolTelemetryMetrics,
  UNIDENTIFIED_SESSION,
} from "./mcp-telemetry.js";
import type {
  TelemetryConfig,
  TelemetryErrorCategory,
  TelemetryErrorReason,
  TelemetryJsonType,
} from "./telemetry/types.js";
import { createToolHandlerTable } from "./tools/handlers/index.js";
import type { ToolCallOutput, ToolHandler, ToolRequestContext } from "./tools/handlers/types.js";
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

const PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION];
const PROTOCOL_META = "io.modelcontextprotocol/protocolVersion";
const DISCOVERY_CACHE_TTL_MS = 300_000;

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
    let runtime: TelemetryRuntime | undefined;
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
                  success: output.failure === undefined,
                  durationMs,
                  outputBytes,
                  ...(output.failure
                    ? {
                        errorCategory: output.failure.category,
                        errorReason: output.failure.reason,
                      }
                    : {}),
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
