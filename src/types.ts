import type { ChildProcess } from "node:child_process";
import type { TelemetryConfig } from "./telemetry/types.js";
import type { CommandPolicyConfig } from "./tools/policy.js";
import type { PathProtectionConfig } from "./tools/protected-paths.js";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface PackageScriptsConfig {
  allowedScripts: string[];
  /** Allowed scripts that may receive extra arguments (appended after `--`). */
  argumentScripts?: string[];
}

export type ToolSet = "codegraph" | "analytics" | "filesystem" | "search" | "commands";

/**
 * Tool sets that existed before Serena and ast-grep were removed. Config validation still accepts
 * them so an old profile loads; {@link migrateLegacyProfiles} strips them with a warning.
 */
export const LEGACY_TOOL_SETS = ["serena", "ast_grep"] as const;

export interface ToolSelectionConfig {
  /** Exact MCP tool names to hide and reject. */
  disabled?: string[];
  /** Named groups of tools to hide and reject. */
  disabledSets?: ToolSet[];
}

export interface Profile {
  directory: string;
  port: number;
  tunnel: "none" | "wormhole" | "cloudflared";
  defaultTunnel?: "none" | "wormhole" | "cloudflared";
  tunnels?: {
    wormhole?: { subdomain?: string; random?: boolean };
    cloudflared?: { hostname: string; token?: string };
  };
  subdomain?: string;
  hostname?: string;
  token?: string;
  packageManager?: PackageManager;
  scripts?: PackageScriptsConfig;
  commands?: string[];
  blacklistedCommands?: string[];
  /**
   * Browser origins allowed to call `/mcp`, for web-based agents. Same-origin requests are always
   * accepted; anything else needs to be listed here. Holds origins only (`https://app.example`).
   */
  allowedOrigins?: string[];
  commandPolicy?: CommandPolicyConfig;
  protectedPaths?: PathProtectionConfig;
  tools?: ToolSelectionConfig;
}

export interface AgentConfig {
  version: 1;
  profiles: Record<string, Profile>;
  telemetry?: TelemetryConfig;
}

export interface CommandConfig {
  packageManager?: PackageManager;
  scripts?: PackageScriptsConfig;
  commands?: string[];
  blacklistedCommands?: string[];
  commandPolicy?: CommandPolicyConfig;
  protectedPaths?: PathProtectionConfig;
  tools?: ToolSelectionConfig;
}

export interface ServerOptions {
  root: string;
  port: number;
  token: string;
  commandConfig?: CommandConfig;
  telemetry?: TelemetryConfig;
  codeGraph?: import("./codegraph.js").CodeGraphIntegration;
  analytics?: boolean;
  /** Browser origins allowed to call `/mcp` in addition to same-origin requests. */
  allowedOrigins?: string[];
}

export interface RequestLog {
  method: string;
  path: string;
  status: number;
  detail?: string;
  tool?: string;
}

export interface TunnelOptions {
  provider: "wormhole" | "cloudflared";
  port: number;
  cloudflaredToken?: string;
  subdomain?: string;
  hostname?: string;
  random?: boolean;
  token?: string;
  telemetry?: TelemetryConfig;
}

export interface TunnelResult {
  child: ChildProcess;
  url: string;
  onEvent?: (event: TunnelEvent) => void;
  stop?: () => void;
}

export type TunnelEvent =
  | { type: "online"; url: string; attempt: number }
  | { type: "disconnected"; reason: string }
  | { type: "reconnecting"; attempt: number; reason: string }
  | { type: "reconnected"; url: string; attempt: number }
  | { type: "failed"; reason: string; attempts: number }
  | { type: "health"; state: "healthy" | "degraded" | "recovered" };
