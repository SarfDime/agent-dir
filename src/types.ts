import type { ChildProcess } from "node:child_process";

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
}

export interface AgentConfig {
  version: 1;
  profiles: Record<string, Profile>;
}

export interface CommandConfig {
  npm?: NpmConfig;
  commands?: string[];
}

export interface ServerOptions {
  root: string;
  port: number;
  token: string;
  commandConfig?: CommandConfig;
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
  subdomain: string;
}

export interface TunnelResult {
  child: ChildProcess;
  url: string;
}
