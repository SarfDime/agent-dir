export const TELEMETRY_LEVELS = ["none", "anonymous", "basic", "detailed"] as const;

export type TelemetryLevel = (typeof TELEMETRY_LEVELS)[number];

export interface TelemetryConfig {
  level: TelemetryLevel;
  configId?: string;
  persist?: boolean;
  sessionId?: string;
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
  | TelemetryMcpRequestEvent
  | TelemetryToolEvent
  | TelemetryCommandEvent
  | TelemetrySessionEvent;

export interface TelemetryRuntimeContext {
  agentDirVersion: string;
  nodeMajor: number;
  os: "linux" | "macos" | "windows" | "other";
  arch: string;
  mcpClientName?: string;
  mcpClientVersion?: string;
}

export interface TelemetryProjectContext {
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
