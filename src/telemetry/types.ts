export const TELEMETRY_LEVELS = ["none", "anonymous", "basic", "detailed", "diagnostic"] as const;

export type TelemetryLevel = (typeof TELEMETRY_LEVELS)[number];

export interface TelemetryConfig {
  level: TelemetryLevel;
  configId?: string;
  persist?: boolean;
  sessionId?: string;
  /** Minimum time between periodic session summaries (default 60 s); the last one wins. */
  sessionSnapshotMs?: number;
}

export interface TelemetryHttpRequestEvent {
  event: "http_request";
  method: string;
  route: "mcp" | "tree" | "root" | "file" | "other";
  status: number;
  success: boolean;
  durationMs: number;
  authenticated: boolean;
}

export interface TelemetryMcpRequestEvent {
  event: "mcp_request";
  method: string;
  success: boolean;
  durationMs: number;
  responseBytes?: number;
  estimatedResponseTokens?: number;
  errorCategory?: string;
  /**
   * `tools/list` only: how many tools were advertised and a stable hash of their names, so a size
   * change can be attributed to a code change or to a tool appearing/disappearing.
   */
  toolCount?: number;
  toolSetHash?: string;
  /** Which guidance variant `initialize`/`server/discover` returned, for A/B comparison. */
  guidanceVariant?: string;
}

export interface TelemetryFileMetric {
  pathHash: string;
  contentHash?: string;
  bytes: number;
}

export interface TelemetryToolEvent {
  event: "tool_call";
  tool: string;
  requestIdHash?: string;
  inputFingerprint?: string;
  outputFingerprint?: string;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  cumulativeOutputBytes?: number;
  cumulativeEstimatedOutputTokens?: number;
  duplicateOutputBytes?: number;
  textOutputBytes?: number;
  uniqueFileCount?: number;
  files?: TelemetryFileMetric[];
  success: boolean;
  durationMs: number;
  inputBytes?: number;
  outputBytes?: number;
  resultCount?: number;
  affectedFiles?: number;
  truncated?: boolean;
  paginated?: boolean;
  /** Batch tools only: items reported as `skipped` (never started). */
  skippedCount?: number;
  /** Integration-backed tool only, with the integration status at call time. */
  integration?: string;
  integrationStatus?: string;
  /**
   * Which optional arguments the caller actually used. Booleans only: this is for guidance and
   * workflow experiments, never for inspecting the arguments themselves.
   */
  argShape?: {
    regex?: boolean;
    caseSensitive?: boolean;
    paths?: boolean;
    globs?: boolean;
    context?: boolean;
    multiline?: boolean;
    ranges?: boolean;
    dryRun?: boolean;
    okExitCodes?: boolean;
    limit?: boolean;
  };
  /** Normalized result classification: ok, empty, truncated or error. */
  outcome?: "ok" | "empty" | "truncated" | "error";
  errorCategory?: string;
}

export interface TelemetryCommandEvent {
  event: "command_call";
  commandFamily: string;
  /** Allowlisted executable names only; never arguments. */
  executables?: string[];
  operation?: string;
  success: boolean;
  durationMs: number;
  outputBytes?: number;
  errorCategory?: string;
}

export interface TelemetryTunnelEvent {
  event: "tunnel";
  state: "online" | "disconnected" | "reconnecting" | "reconnected" | "failed" | "health";
  healthState?: "healthy" | "degraded" | "recovered";
  attempt?: number;
  attempts?: number;
  durationMs?: number;
  reasonCategory?: string;
}

export interface TelemetrySessionEvent {
  event: "session";
  wallClockDurationMs: number;
  activeRequestDurationMs: number;
  idleGapDurationMs: number;
  requestCount: number;
  toolCallCount: number;
  commandCallCount: number;
}

export type AnonymousTelemetryEvent =
  | TelemetryHttpRequestEvent
  | TelemetryMcpRequestEvent
  | TelemetryToolEvent
  | TelemetryCommandEvent
  | TelemetryTunnelEvent
  | TelemetrySessionEvent;

export interface TelemetryRuntimeContext {
  agentDirVersion: string;
  nodeMajor: number;
  os: "linux" | "macos" | "windows" | "other";
  arch: string;
  mcpClientName?: string;
  mcpClientVersion?: string;
  mcpProtocolVersion?: string;
  nodeVersion?: string;
  distroId?: string;
  distroName?: string;
  distroVersion?: string;
  kernelVersion?: string;
  hostname?: string;
  username?: string;
  processId?: number;
  parentProcessId?: number;
  processUptimeMs?: number;
  memoryRssBytes?: number;
}

export interface TelemetryProjectContext {
  projectRoot?: string;
  workingDirectory?: string;
  language?: "typescript" | "javascript" | "python" | "go" | "rust" | "java" | "other";
  framework?: "nextjs" | "react" | "hono" | "node" | "other";
  packageManager?: "npm" | "pnpm" | "yarn" | "bun" | "other";
  hasGit?: boolean;
  hasCodegraph?: boolean;
  projectSize?: "small" | "medium" | "large";
}

export interface TelemetryEnvelope {
  schemaVersion: 1;
  timestamp: string;
  configId: string;
  sessionId: string;
  level: Exclude<TelemetryLevel, "none">;
  event: AnonymousTelemetryEvent;
  runtime?: TelemetryRuntimeContext;
  project?: TelemetryProjectContext;
}
