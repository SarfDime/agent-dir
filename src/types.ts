import type { ChildProcess } from "node:child_process";
import type { TelemetryConfig } from "./telemetry/types.js";

export interface NpmConfig {
  allowedScripts: string[];
}

export interface Profile {
  directory: string;
  port: number;
  tunnel: "none" | "wormhole";
  subdomain?: string;
  token?: string;
  npm?: NpmConfig;
  commands?: string[];
  blacklistedCommands?: string[];
  git?: boolean;
}

export interface AgentConfig {
  version: 1;
  profiles: Record<string, Profile>;
  telemetry?: TelemetryConfig;
}

export interface CommandConfig {
  npm?: NpmConfig;
  commands?: string[];
  blacklistedCommands?: string[];
  git?: boolean;
}

export interface ServerOptions {
  root: string;
  port: number;
  token: string;
  commandConfig?: CommandConfig;
  telemetry?: TelemetryConfig;
}

export interface RequestLog {
  method: string;
  path: string;
  status: number;
  detail?: string;
  tool?: string;
}

export interface TunnelOptions {
  provider: "wormhole";
  port: number;
  subdomain?: string;
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
  | { type: "failed"; reason: string; attempts: number };
