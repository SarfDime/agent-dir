import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isTelemetryLevel } from "./telemetry/config.js";
import type { AgentConfig, CommandConfig, Profile } from "./types.js";

const CONFIG_DIR = join(homedir(), ".config", "agent-dir");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const DEFAULT_CONFIG: AgentConfig = { version: 1, profiles: {} };

interface FileSystemError extends Error {
  code?: string;
}

export async function loadConfig(): Promise<AgentConfig> {
  try {
    const parsed: unknown = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
    if (!isAgentConfig(parsed)) throw new Error("Invalid configuration format.");
    return parsed;
  } catch (error) {
    if ((error as FileSystemError).code === "ENOENT") return structuredClone(DEFAULT_CONFIG);
    throw new Error(`Unable to read config ${CONFIG_FILE}: ${(error as Error).message}`);
  }
}

export async function saveConfig(config: AgentConfig): Promise<void> {
  await mkdir(dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(CONFIG_FILE, 0o600);
}

export function configPath(): string {
  return CONFIG_FILE;
}

export function mergeProfile(profile: Profile, overrides: CommandConfig = {}): CommandConfig {
  return {
    ...profile,
    ...overrides,
    npm: { ...(profile.npm ?? { allowedScripts: [] }), ...(overrides.npm ?? {}) },
  };
}

function isAgentConfig(value: unknown): value is AgentConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  if (config.version !== 1 || !config.profiles || typeof config.profiles !== "object") return false;
  if (config.telemetry !== undefined) {
    if (!config.telemetry || typeof config.telemetry !== "object") return false;
    if (!isTelemetryLevel((config.telemetry as Record<string, unknown>).level)) return false;
  }

  for (const [name, profile] of Object.entries(config.profiles)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || !isProfile(profile)) return false;
  }
  return true;
}

function isProfile(value: unknown): value is Profile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Record<string, unknown>;
  const port = profile.port;
  if (typeof profile.directory !== "string" || typeof port !== "number" || !Number.isInteger(port))
    return false;
  if (port < 1 || port > 65_535) return false;
  if (profile.tunnel !== "none" && profile.tunnel !== "wormhole") return false;
  if (profile.subdomain !== undefined && typeof profile.subdomain !== "string") return false;
  if (profile.token !== undefined && typeof profile.token !== "string") return false;
  if (profile.npm !== undefined) {
    if (!profile.npm || typeof profile.npm !== "object") return false;
    const npm = profile.npm as Record<string, unknown>;
    if (
      !Array.isArray(npm.allowedScripts) ||
      npm.allowedScripts.some((item) => typeof item !== "string")
    )
      return false;
  }
  if (profile.commands !== undefined) {
    if (
      !Array.isArray(profile.commands) ||
      profile.commands.some((item) => typeof item !== "string")
    )
      return false;
  }
  if (profile.blacklistedCommands !== undefined) {
    if (
      !Array.isArray(profile.blacklistedCommands) ||
      profile.blacklistedCommands.some((item) => typeof item !== "string")
    )
      return false;
  }
  if (profile.git !== undefined && typeof profile.git !== "boolean") return false;
  if (profile.github !== undefined && typeof profile.github !== "boolean") return false;
  return true;
}
