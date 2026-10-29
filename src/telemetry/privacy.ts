import {
  type AnonymousTelemetryEvent,
  ARG_SHAPE_KEYS,
  type ArgShape,
  TELEMETRY_ERROR_CATEGORIES,
  type TelemetryCommandEvent,
  type TelemetryEnvelope,
  type TelemetryErrorCategory,
  type TelemetryHttpRequestEvent,
  type TelemetryLevel,
  type TelemetryMcpRequestEvent,
  type TelemetryProjectContext,
  type TelemetryRuntimeContext,
  type TelemetrySessionEvent,
  type TelemetryToolEvent,
  type TelemetryTunnelEvent,
  TOOL_OUTCOMES,
  type ToolOutcome,
} from "./types.js";

const SAFE_ERROR_CATEGORIES: ReadonlySet<string> = new Set(TELEMETRY_ERROR_CATEGORIES);
const SAFE_OUTCOMES: ReadonlySet<string> = new Set(TOOL_OUTCOMES);

const SAFE_TOOL_NAME = /^[a-z][a-z0-9_]*$/;
const SAFE_COMMAND_FAMILY = /^[a-z][a-z0-9_-]*$/;
const SAFE_OPERATION = /^[a-z][a-z0-9_.-]*$/;
const SAFE_VARIANT = /^[a-z][a-z0-9_-]*$/;

/**
 * One sanitizer per field. `-?` makes every field of the event type required here, so adding a
 * field to an event interface without a rule is a compile error instead of a field that is
 * silently dropped on the way to disk.
 *
 * Returning `undefined` drops the field; the applier skips absent input fields.
 */
type FieldRules<T> = {
  [K in keyof Omit<T, "event">]-?: (value: NonNullable<T[K]>) => T[K];
};

const HTTP_REQUEST_RULES: FieldRules<TelemetryHttpRequestEvent> = {
  method: (value) => sanitizeMcpMethod(value),
  // The route is chosen from a closed set by our own code, not supplied by a client.
  route: (value) => value,
  status: (value) => boundedInteger(value),
  success: (value) => value === true,
  durationMs: (value) => boundedNumber(value),
  authenticated: (value) => value === true,
};

const MCP_REQUEST_RULES: FieldRules<TelemetryMcpRequestEvent> = {
  method: (value) => sanitizeMcpMethod(value),
  success: (value) => value === true,
  durationMs: (value) => boundedNumber(value),
  responseBytes: (value) => boundedNumber(value),
  estimatedResponseTokens: (value) => boundedNumber(value),
  errorCategory: (value) => sanitizeErrorCategory(value),
  toolCount: (value) => boundedInteger(value),
  toolSetHash: (value) => sanitizeHash(value),
  guidanceVariant: (value) => sanitizeIdentifier(value, SAFE_VARIANT),
};

const TOOL_CALL_RULES: FieldRules<TelemetryToolEvent> = {
  tool: (value) => sanitizeIdentifier(value, SAFE_TOOL_NAME),
  requestIdHash: (value) => sanitizeHash(value),
  inputFingerprint: (value) => sanitizeHash(value),
  outputFingerprint: (value) => sanitizeHash(value),
  estimatedInputTokens: (value) => boundedNumber(value),
  estimatedOutputTokens: (value) => boundedNumber(value),
  cumulativeOutputBytes: (value) => boundedNumber(value),
  cumulativeEstimatedOutputTokens: (value) => boundedNumber(value),
  duplicateOutputBytes: (value) => boundedNumber(value),
  textOutputBytes: (value) => boundedNumber(value),
  uniqueFileCount: (value) => boundedInteger(value),
  files: (value) =>
    value.slice(0, 100).map((file) => ({
      pathHash: sanitizeHash(file.pathHash),
      ...(file.contentHash === undefined ? {} : { contentHash: sanitizeHash(file.contentHash) }),
      bytes: boundedNumber(file.bytes),
    })),
  success: (value) => value === true,
  durationMs: (value) => boundedNumber(value),
  inputBytes: (value) => boundedNumber(value),
  outputBytes: (value) => boundedNumber(value),
  resultCount: (value) => boundedInteger(value),
  affectedFiles: (value) => boundedInteger(value),
  truncated: (value) => value === true,
  paginated: (value) => value === true,
  skippedCount: (value) => boundedInteger(value),
  integration: (value) => sanitizeIdentifier(value, SAFE_VARIANT),
  integrationStatus: (value) => sanitizeIdentifier(value, SAFE_VARIANT),
  argShape: (value) => sanitizeArgShape(value),
  outcome: (value) => sanitizeOutcome(value),
  errorCategory: (value) => sanitizeErrorCategory(value),
};

const COMMAND_CALL_RULES: FieldRules<TelemetryCommandEvent> = {
  commandFamily: (value) => sanitizeIdentifier(value, SAFE_COMMAND_FAMILY),
  executables: (value) => value.slice(0, 10).map(sanitizeExecutable),
  operation: (value) => sanitizeIdentifier(value, SAFE_OPERATION),
  success: (value) => value === true,
  durationMs: (value) => boundedNumber(value),
  outputBytes: (value) => boundedNumber(value),
  errorCategory: (value) => sanitizeErrorCategory(value),
};

const TUNNEL_RULES: FieldRules<TelemetryTunnelEvent> = {
  // State names come from our own union, not from input.
  state: (value) => value,
  healthState: (value) => value,
  attempt: (value) => boundedInteger(value),
  attempts: (value) => boundedInteger(value),
  durationMs: (value) => boundedNumber(value),
  reasonCategory: (value) => sanitizeErrorCategory(value),
};

const SESSION_RULES: FieldRules<TelemetrySessionEvent> = {
  wallClockDurationMs: (value) => boundedNumber(value),
  activeRequestDurationMs: (value) => boundedNumber(value),
  idleGapDurationMs: (value) => boundedNumber(value),
  requestCount: (value) => boundedInteger(value),
  toolCallCount: (value) => boundedInteger(value),
  commandCallCount: (value) => boundedInteger(value),
};

/** Applies a field-rule table mechanically: one code path, no hand-written allowlist literal. */
function sanitizeFields<T extends { event: string }>(event: T, rules: FieldRules<T>): T {
  const source = event as Record<string, unknown>;
  const output: Record<string, unknown> = { event: event.event };
  for (const [key, rule] of Object.entries(rules)) {
    const value = source[key];
    if (value === undefined) continue;
    const sanitized = (rule as (value: unknown) => unknown)(value);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output as T;
}

/**
 * Sanitizes an event before it reaches disk. The generic signature preserves the concrete event
 * type, so callers keep the fields they passed instead of falling back to the union.
 */
export function sanitizeAnonymousEvent<T extends AnonymousTelemetryEvent>(event: T): T {
  return dispatchAnonymousEvent(event) as T;
}

function dispatchAnonymousEvent(event: AnonymousTelemetryEvent): AnonymousTelemetryEvent {
  if (event.event === "http_request") return sanitizeFields(event, HTTP_REQUEST_RULES);

  if (event.event === "mcp_request") return sanitizeFields(event, MCP_REQUEST_RULES);

  if (event.event === "tool_call") return sanitizeFields(event, TOOL_CALL_RULES);

  if (event.event === "tunnel") return sanitizeFields(event, TUNNEL_RULES);

  if (event.event === "command_call") return sanitizeFields(event, COMMAND_CALL_RULES);

  if (event.event === "session") return sanitizeFields(event, SESSION_RULES);

  // A new event type without a rule table must not compile.
  const unhandled: never = event;
  return unhandled;
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
    ...(context.distroId === undefined
      ? {}
      : { distroId: sanitizeSensitiveIdentifier(context.distroId) }),
    ...(context.distroName === undefined ? {} : { distroName: context.distroName.slice(0, 128) }),
    ...(context.distroVersion === undefined
      ? {}
      : { distroVersion: context.distroVersion.slice(0, 64) }),
    ...(context.kernelVersion === undefined
      ? {}
      : { kernelVersion: context.kernelVersion.slice(0, 128) }),
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
      : { mcpClientName: sanitizeClientName(context.mcpClientName) }),
    ...(context.mcpClientVersion === undefined
      ? {}
      : { mcpClientVersion: sanitizeVersion(context.mcpClientVersion) }),
    ...(context.mcpProtocolVersion === undefined
      ? {}
      : { mcpProtocolVersion: sanitizeProtocolVersion(context.mcpProtocolVersion) }),
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

/** Only known boolean keys survive: argument values are never recorded. */
function sanitizeArgShape(shape: ArgShape): ArgShape {
  const output: ArgShape = {};
  for (const key of ARG_SHAPE_KEYS) if (shape[key] === true) output[key] = true;
  return output;
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

function sanitizeOutcome(value: ToolOutcome): ToolOutcome {
  return SAFE_OUTCOMES.has(value) ? value : "ok";
}

function sanitizeExecutable(value: string): string {
  return /^[a-z0-9][a-z0-9._+-]{0,31}$/i.test(value) ? value : "other";
}

/** Client names such as `vendor/product` are not sensitive; keep a conservative character set. */
function sanitizeClientName(value: string): string {
  const normalized = value.trim().slice(0, 64);
  return /^[a-z0-9][a-z0-9 ._/@:+()-]*$/i.test(normalized) ? normalized : "unknown";
}

function sanitizeVersion(value: string): string {
  const normalized = value.trim().slice(0, 32);
  return /^v?[0-9]+(?:\.[0-9]+){0,3}(?:[-+][a-z0-9.-]+)?$/i.test(normalized)
    ? normalized
    : "unknown";
}

function sanitizeProtocolVersion(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? value.trim() : "unknown";
}

function sanitizeHash(value: string): string {
  return /^[a-f0-9]{64}$/.test(value) ? value : "unknown";
}

function sanitizeErrorCategory(value: string): TelemetryErrorCategory {
  const normalized = value.trim().toLowerCase();
  return SAFE_ERROR_CATEGORIES.has(normalized) ? (normalized as TelemetryErrorCategory) : "unknown";
}

function boundedNumber(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.round(value), 2_147_483_647));
}

function boundedInteger(value: number): number {
  return Math.max(0, Math.min(Math.round(Number.isFinite(value) ? value : 0), 1_000_000_000));
}
