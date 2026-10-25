import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isTelemetryLevel } from "./telemetry/config.js";
import { isCommandPolicy } from "./tools/policy.js";
import { isPathProtectionConfig } from "./tools/protected-paths.js";
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
    return migrateLegacyProfiles(parsed);
  } catch (error) {
    if ((error as FileSystemError).code === "ENOENT") return structuredClone(DEFAULT_CONFIG);
    throw new Error(`Unable to read config ${CONFIG_FILE}: ${(error as Error).message}`);
  }
}

/**
 * Profiles written before the package-script refactor use `npm.allowedScripts`. Without this,
 * the key would be ignored silently and every package script would become disallowed.
 */
export function migrateLegacyProfiles(
  config: AgentConfig,
  warn: (message: string) => void = (message) => console.error(message),
): AgentConfig {
  for (const [name, profile] of Object.entries(config.profiles)) {
    const legacy = (profile as { npm?: { allowedScripts?: unknown } }).npm;
    if (!legacy || profile.scripts) continue;
    if (
      Array.isArray(legacy.allowedScripts) &&
      legacy.allowedScripts.every((item) => typeof item === "string")
    ) {
      profile.scripts = { allowedScripts: legacy.allowedScripts as string[] };
      warn(
        `\u26a0 Profile '${name}' uses the old 'npm.allowedScripts' key; treating it as 'scripts.allowedScripts'. Update the profile to remove this warning.`,
      );
    }
  }
  return config;
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
    scripts: {
      ...(profile.scripts ?? { allowedScripts: [] }),
      ...(overrides.scripts ?? {}),
    },
    packageManager: overrides.packageManager ?? profile.packageManager ?? "npm",
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
  if (
    profile.tunnel !== "none" &&
    profile.tunnel !== "wormhole" &&
    profile.tunnel !== "cloudflared"
  )
    return false;
  if (profile.subdomain !== undefined && typeof profile.subdomain !== "string") return false;
  if (profile.hostname !== undefined && typeof profile.hostname !== "string") return false;
  if (profile.token !== undefined && typeof profile.token !== "string") return false;
  if (
    profile.defaultTunnel !== undefined &&
    !["none", "wormhole", "cloudflared"].includes(String(profile.defaultTunnel))
  )
    return false;
  if (profile.tunnels !== undefined) {
    if (!profile.tunnels || typeof profile.tunnels !== "object") return false;
    const tunnels = profile.tunnels as Record<string, unknown>;
    if (tunnels.wormhole !== undefined) {
      if (!tunnels.wormhole || typeof tunnels.wormhole !== "object") return false;
      const wormhole = tunnels.wormhole as Record<string, unknown>;
      if (wormhole.subdomain !== undefined && typeof wormhole.subdomain !== "string") return false;
      if (wormhole.random !== undefined && typeof wormhole.random !== "boolean") return false;
    }
    if (tunnels.cloudflared !== undefined) {
      if (!tunnels.cloudflared || typeof tunnels.cloudflared !== "object") return false;
      const cloudflared = tunnels.cloudflared as Record<string, unknown>;
      if (typeof cloudflared.hostname !== "string" || !cloudflared.hostname) return false;
      if (cloudflared.token !== undefined && typeof cloudflared.token !== "string") return false;
    }
  }
  if (
    profile.packageManager !== undefined &&
    !["npm", "pnpm", "yarn", "bun"].includes(String(profile.packageManager))
  )
    return false;
  if (profile.scripts !== undefined) {
    if (!profile.scripts || typeof profile.scripts !== "object") return false;
    const scripts = profile.scripts as Record<string, unknown>;
    if (
      !Array.isArray(scripts.allowedScripts) ||
      scripts.allowedScripts.some((item) => typeof item !== "string")
    )
      return false;
    if (
      scripts.argumentScripts !== undefined &&
      (!Array.isArray(scripts.argumentScripts) ||
        scripts.argumentScripts.some((item) => typeof item !== "string"))
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
  if (profile.commandPolicy !== undefined && !isCommandPolicy(profile.commandPolicy)) return false;
  if (profile.protectedPaths !== undefined && !isPathProtectionConfig(profile.protectedPaths))
    return false;
  return true;
}
