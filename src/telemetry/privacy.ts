import type {
  AnonymousTelemetryEvent,
  TelemetryEnvelope,
  TelemetryLevel,
  TelemetryProjectContext,
  TelemetryRuntimeContext,
} from "./types.js";

const SAFE_ERROR_CATEGORIES = new Set([
  "authentication",
  "authorization",
  "invalid_input",
  "not_found",
  "conflict",
  "timeout",
  "execution",
  "internal",
  "startup",
  "unknown",
]);

const SAFE_TOOL_NAME = /^[a-z][a-z0-9_]*$/;
const SAFE_COMMAND_FAMILY = /^[a-z][a-z0-9_-]*$/;
const SAFE_OPERATION = /^[a-z][a-z0-9_.-]*$/;

export function sanitizeAnonymousEvent(event: AnonymousTelemetryEvent): AnonymousTelemetryEvent {
  if (event.event === "http_request") {
    return {
      event: "http_request",
      method: sanitizeMcpMethod(event.method),
      route: event.route,
      status: boundedInteger(event.status),
      success: event.success === true,
      durationMs: boundedNumber(event.durationMs),
      authenticated: event.authenticated === true,
    };
  }

  if (event.event === "mcp_request") {
    return {
      event: "mcp_request",
      method: sanitizeMcpMethod(event.method),
      success: event.success === true,
      durationMs: boundedNumber(event.durationMs),
      ...(event.errorCategory === undefined
        ? {}
        : { errorCategory: sanitizeErrorCategory(event.errorCategory) }),
    };
  }

  if (event.event === "tool_call") {
    return {
      event: "tool_call",
      tool: sanitizeIdentifier(event.tool, SAFE_TOOL_NAME),
      success: event.success === true,
      durationMs: boundedNumber(event.durationMs),
      ...optionalNumber("inputBytes", event.inputBytes),
      ...optionalNumber("outputBytes", event.outputBytes),
      ...optionalNumber("resultCount", event.resultCount),
      ...optionalNumber("affectedFiles", event.affectedFiles),
      ...(event.truncated === undefined ? {} : { truncated: event.truncated === true }),
      ...(event.paginated === undefined ? {} : { paginated: event.paginated === true }),
      ...(event.errorCategory === undefined
        ? {}
        : { errorCategory: sanitizeErrorCategory(event.errorCategory) }),
    };
  }

  if (event.event === "tunnel") {
    return {
      event: "tunnel",
      state: event.state,
      ...(event.healthState === undefined ? {} : { healthState: event.healthState }),
      ...(event.attempt === undefined ? {} : { attempt: boundedInteger(event.attempt) }),
      ...(event.attempts === undefined ? {} : { attempts: boundedInteger(event.attempts) }),
      ...(event.durationMs === undefined ? {} : { durationMs: boundedNumber(event.durationMs) }),
      ...(event.reasonCategory === undefined
        ? {}
        : { reasonCategory: sanitizeErrorCategory(event.reasonCategory) }),
    };
  }

  if (event.event === "command_call") {
    return {
      event: "command_call",
      commandFamily: sanitizeIdentifier(event.commandFamily, SAFE_COMMAND_FAMILY),
      ...(event.operation === undefined
        ? {}
        : { operation: sanitizeIdentifier(event.operation, SAFE_OPERATION) }),
      success: event.success === true,
      durationMs: boundedNumber(event.durationMs),
      ...optionalNumber("outputBytes", event.outputBytes),
      ...(event.errorCategory === undefined
        ? {}
        : { errorCategory: sanitizeErrorCategory(event.errorCategory) }),
    };
  }

  return {
    event: "session",
    wallClockDurationMs: boundedNumber(event.wallClockDurationMs),
    activeRequestDurationMs: boundedNumber(event.activeRequestDurationMs),
    idleGapDurationMs: boundedNumber(event.idleGapDurationMs),
    requestCount: boundedInteger(event.requestCount),
    toolCallCount: boundedInteger(event.toolCallCount),
    commandCallCount: boundedInteger(event.commandCallCount),
  };
}

export function createTelemetryEnvelope(
  level: Exclude<TelemetryLevel, "none">,
  event: AnonymousTelemetryEvent,
  runtime?: TelemetryRuntimeContext,
  project?: TelemetryProjectContext,
  configId = "default",
  sessionId = "default",
): TelemetryEnvelope {
  const envelope: TelemetryEnvelope = {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    configId,
    sessionId,
    level,
    event: sanitizeAnonymousEvent(event),
  };

  if (level === "basic" || level === "detailed" || level === "diagnostic") {
    if (runtime) envelope.runtime = sanitizeRuntimeContext(runtime);
  }

  if ((level === "detailed" || level === "diagnostic") && project) {
    envelope.project = sanitizeProjectContext(project);
  }

  if (level === "diagnostic" && runtime) {
    envelope.runtime = sanitizeDiagnosticRuntimeContext(runtime);
  }

  if (level === "diagnostic" && project) {
    envelope.project = sanitizeDiagnosticProjectContext(project);
  }

  return envelope;
}

function sanitizeDiagnosticRuntimeContext(
  context: TelemetryRuntimeContext,
): TelemetryRuntimeContext {
  return {
    ...sanitizeRuntimeContext(context),
    ...(context.nodeVersion === undefined
      ? {}
      : { nodeVersion: sanitizeVersion(context.nodeVersion) }),
    ...(context.hostname === undefined
      ? {}
      : { hostname: sanitizeSensitiveIdentifier(context.hostname) }),
    ...(context.username === undefined
      ? {}
      : { username: sanitizeSensitiveIdentifier(context.username) }),
    ...(context.processId === undefined ? {} : { processId: boundedInteger(context.processId) }),
    ...(context.parentProcessId === undefined
      ? {}
      : { parentProcessId: boundedInteger(context.parentProcessId) }),
    ...(context.processUptimeMs === undefined
      ? {}
      : { processUptimeMs: boundedNumber(context.processUptimeMs) }),
    ...(context.memoryRssBytes === undefined
      ? {}
      : { memoryRssBytes: boundedNumber(context.memoryRssBytes) }),
  };
}

function sanitizeRuntimeContext(context: TelemetryRuntimeContext): TelemetryRuntimeContext {
  return {
    agentDirVersion: sanitizeVersion(context.agentDirVersion),
    nodeMajor: boundedInteger(context.nodeMajor),
    os: ["linux", "macos", "windows", "other"].includes(context.os) ? context.os : "other",
    arch: sanitizeIdentifier(context.arch, /^[a-z0-9_]+$/),
    ...(context.mcpClientName === undefined
      ? {}
      : { mcpClientName: sanitizeFreeIdentifier(context.mcpClientName) }),
    ...(context.mcpClientVersion === undefined
      ? {}
      : { mcpClientVersion: sanitizeVersion(context.mcpClientVersion) }),
  };
}

function sanitizeDiagnosticProjectContext(
  context: TelemetryProjectContext,
): TelemetryProjectContext {
  return {
    ...sanitizeProjectContext(context),
    ...(context.projectRoot === undefined
      ? {}
      : { projectRoot: sanitizeLocalPath(context.projectRoot) }),
    ...(context.workingDirectory === undefined
      ? {}
      : { workingDirectory: sanitizeLocalPath(context.workingDirectory) }),
  };
}

function sanitizeProjectContext(context: TelemetryProjectContext): TelemetryProjectContext {
  return {
    ...(context.language ? { language: context.language } : {}),
    ...(context.framework ? { framework: context.framework } : {}),
    ...(context.packageManager ? { packageManager: context.packageManager } : {}),
    ...(context.hasGit === undefined ? {} : { hasGit: context.hasGit === true }),
    ...(context.hasCodegraph === undefined ? {} : { hasCodegraph: context.hasCodegraph === true }),
    ...(context.projectSize ? { projectSize: context.projectSize } : {}),
  };
}

function sanitizeMcpMethod(value: string): string {
  const normalized = value.trim().toLowerCase();
  return /^[a-z][a-z0-9_./-]*$/.test(normalized) ? normalized : "unknown";
}

function sanitizeIdentifier(value: string, pattern: RegExp): string {
  const normalized = value.trim().toLowerCase();
  return pattern.test(normalized) ? normalized : "unknown";
}

function sanitizeSensitiveIdentifier(value: string): string {
  const normalized = value.trim().slice(0, 128);
  return /^[a-z0-9][a-z0-9 ._@-]*$/i.test(normalized) ? normalized : "unknown";
}

function sanitizeLocalPath(value: string): string {
  const normalized = value.trim().slice(0, 2048);
  return normalized.startsWith("/") || /^[A-Za-z]:[\\\\/]/.test(normalized)
    ? normalized
    : "unknown";
}

function sanitizeFreeIdentifier(value: string): string {
  const normalized = value.trim().slice(0, 64);
  return /^[a-z0-9][a-z0-9 ._-]*$/i.test(normalized) ? normalized : "unknown";
}

function sanitizeVersion(value: string): string {
  const normalized = value.trim().slice(0, 32);
  return /^v?[0-9]+(?:\.[0-9]+){0,3}(?:[-+][a-z0-9.-]+)?$/i.test(normalized)
    ? normalized
    : "unknown";
}

function sanitizeErrorCategory(value: string): string {
  const normalized = value.trim().toLowerCase();
  return SAFE_ERROR_CATEGORIES.has(normalized) ? normalized : "unknown";
}

function boundedNumber(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.round(value), 2_147_483_647));
}

function boundedInteger(value: number): number {
  return Math.max(0, Math.min(Math.round(Number.isFinite(value) ? value : 0), 1_000_000_000));
}

function optionalNumber<K extends string>(
  key: K,
  value: number | undefined,
): Partial<Record<K, number>> {
  return value === undefined ? {} : ({ [key]: boundedNumber(value) } as Partial<Record<K, number>>);
}
