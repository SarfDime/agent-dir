export const TELEMETRY_LEVELS = ["none", "anonymous", "basic", "detailed", "diagnostic"] as const;

export type TelemetryLevel = (typeof TELEMETRY_LEVELS)[number];

export interface TelemetryConfig {
  level: TelemetryLevel;
  configId?: string;
  persist?: boolean;
  sessionId?: string;
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
  errorCategory?: string;
}

export interface TelemetryToolEvent {
  event: "tool_call";
  tool: string;
  success: boolean;
  durationMs: number;
  inputBytes?: number;
  outputBytes?: number;
  resultCount?: number;
  affectedFiles?: number;
  truncated?: boolean;
  paginated?: boolean;
  errorCategory?: string;
}

export interface TelemetryCommandEvent {
  event: "command_call";
  commandFamily: string;
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
  nodeVersion?: string;
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
