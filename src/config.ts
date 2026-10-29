import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isTelemetryLevel } from "./telemetry/config.js";
import { isCommandPolicy } from "./tools/policy.js";
import { isPathProtectionConfig } from "./tools/protected-paths.js";
import type { AgentConfig, CommandConfig, Profile } from "./types.js";
import { LEGACY_TOOL_SETS } from "./types.js";

const CONFIG_DIR = join(homedir(), ".config", "agent-dir");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const DEFAULT_CONFIG: AgentConfig = { version: 1, profiles: {} };

interface FileSystemError extends Error {
  code?: string;
}

export async function loadConfig(): Promise<AgentConfig> {
  let raw: string;
  try {
    raw = await readFile(CONFIG_FILE, "utf8");
  } catch (error) {
    if ((error as FileSystemError).code === "ENOENT") return structuredClone(DEFAULT_CONFIG);
    throw new Error(`Unable to read config ${CONFIG_FILE}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid configuration in ${CONFIG_FILE}: the file is not valid JSON (${(error as Error).message}).`,
    );
  }
  const problem = configProblem(parsed);
  if (problem) throw new Error(`Invalid configuration in ${CONFIG_FILE}: ${problem}.`);
  return migrateLegacyProfiles(parsed as AgentConfig);
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
  for (const [name, profile] of Object.entries(config.profiles)) {
    const tools = profile.tools;
    if (!tools) continue;
    const legacySets = LEGACY_TOOL_SETS as readonly string[];
    const removedSets = (tools.disabledSets ?? []).filter((item) => legacySets.includes(item));
    const removedTools = (tools.disabled ?? []).filter(
      (item) => item.startsWith("serena_") || item === "ast_grep_search",
    );
    if (removedSets.length === 0 && removedTools.length === 0) continue;
    if (tools.disabledSets)
      tools.disabledSets = tools.disabledSets.filter((item) => !legacySets.includes(item));
    if (tools.disabled)
      tools.disabled = tools.disabled.filter(
        (item) => !item.startsWith("serena_") && item !== "ast_grep_search",
      );
    warn(
      `\u26a0 Profile '${name}' references removed tool sets or tools (${[...removedSets, ...removedTools].join(", ")}); Serena and ast-grep are no longer available. Removing these entries.`,
    );
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

/** First problem in the file, as `where: what`; undefined when the whole config is valid. */
function configProblem(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "the file must contain a JSON object";
  const config = value as Record<string, unknown>;
  if (config.version !== 1) return "version must be 1";
  if (!config.profiles || typeof config.profiles !== "object" || Array.isArray(config.profiles))
    return "profiles must be an object keyed by profile name";
  if (config.telemetry !== undefined) {
    if (!config.telemetry || typeof config.telemetry !== "object")
      return "telemetry must be an object";
    if (!isTelemetryLevel((config.telemetry as Record<string, unknown>).level))
      return "telemetry.level must be none, anonymous, basic, detailed or diagnostic";
  }
  for (const [name, profile] of Object.entries(config.profiles as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
      return `profiles: '${name}' may only use letters, digits, dot, dash and underscore`;
    const problem = profileProblem(profile);
    if (problem) return `profiles.${name}: ${problem}`;
  }
  return undefined;
}

const ORIGIN_SCHEMES = new Set([
  "http",
  "https",
  "chrome-extension",
  "moz-extension",
  "safari-extension",
  "safari-web-extension",
]);
const ORIGIN_PATTERN = /^([a-z][a-z0-9+.-]*):\/\/([^/?#\s]+)$/i;
const DEFAULT_PORTS: Record<string, string> = { http: "80", https: "443" };

/**
 * Normalizes an origin for comparison: `scheme://host[:port]`, lowercase, no trailing slash, no
 * default port. Accepts the schemes browsers actually send, including extension origins such as
 * `moz-extension://<uuid>`, which WHATWG `URL.origin` reports as "null".
 */
export function normalizeBrowserOrigin(value: string): string | undefined {
  const match = ORIGIN_PATTERN.exec(value.trim().replace(/\/+$/, ""));
  if (!match) return undefined;
  const scheme = (match[1] ?? "").toLowerCase();
  if (!ORIGIN_SCHEMES.has(scheme)) return undefined;
  let host = (match[2] ?? "").toLowerCase();
  if (host.includes("*")) return undefined;
  const defaultPort = DEFAULT_PORTS[scheme];
  if (defaultPort && host.endsWith(`:${defaultPort}`))
    host = host.slice(0, -defaultPort.length - 1);
  return host ? `${scheme}://${host}` : undefined;
}

export function isBrowserOrigin(value: string): boolean {
  return normalizeBrowserOrigin(value) !== undefined;
}

/** First problem in one profile, named by field; undefined when the profile is valid. */
function profileProblem(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return "must be an object";
  const profile = value as Record<string, unknown>;
  const port = profile.port;
  if (typeof profile.directory !== "string" || !profile.directory)
    return "directory must be a non-empty string";
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535)
    return "port must be an integer between 1 and 65535";
  if (
    profile.tunnel !== "none" &&
    profile.tunnel !== "wormhole" &&
    profile.tunnel !== "cloudflared"
  )
    return "tunnel must be none, wormhole or cloudflared";
  if (profile.subdomain !== undefined && typeof profile.subdomain !== "string")
    return "subdomain must be a string";
  if (profile.hostname !== undefined && typeof profile.hostname !== "string")
    return "hostname must be a string";
  if (profile.token !== undefined && typeof profile.token !== "string")
    return "token must be a string";
  if (
    profile.defaultTunnel !== undefined &&
    !["none", "wormhole", "cloudflared"].includes(String(profile.defaultTunnel))
  )
    return "defaultTunnel must be none, wormhole or cloudflared";
  if (profile.tunnels !== undefined) {
    if (!profile.tunnels || typeof profile.tunnels !== "object") return "tunnels must be an object";
    const tunnels = profile.tunnels as Record<string, unknown>;
    if (tunnels.wormhole !== undefined) {
      if (!tunnels.wormhole || typeof tunnels.wormhole !== "object")
        return "tunnels.wormhole must be an object";
      const wormhole = tunnels.wormhole as Record<string, unknown>;
      if (wormhole.subdomain !== undefined && typeof wormhole.subdomain !== "string")
        return "tunnels.wormhole.subdomain must be a string";
      if (wormhole.random !== undefined && typeof wormhole.random !== "boolean")
        return "tunnels.wormhole.random must be a boolean";
    }
    if (tunnels.cloudflared !== undefined) {
      if (!tunnels.cloudflared || typeof tunnels.cloudflared !== "object")
        return "tunnels.cloudflared must be an object";
      const cloudflared = tunnels.cloudflared as Record<string, unknown>;
      if (typeof cloudflared.hostname !== "string" || !cloudflared.hostname)
        return "tunnels.cloudflared.hostname must be a non-empty string";
      if (cloudflared.token !== undefined && typeof cloudflared.token !== "string")
        return "tunnels.cloudflared.token must be a string";
    }
  }
  if (
    profile.packageManager !== undefined &&
    !["npm", "pnpm", "yarn", "bun"].includes(String(profile.packageManager))
  )
    return "packageManager must be npm, pnpm, yarn or bun";
  if (profile.scripts !== undefined) {
    if (!profile.scripts || typeof profile.scripts !== "object") return "scripts must be an object";
    const scripts = profile.scripts as Record<string, unknown>;
    if (
      !Array.isArray(scripts.allowedScripts) ||
      scripts.allowedScripts.some((item) => typeof item !== "string")
    )
      return "scripts.allowedScripts must be an array of strings";
    if (
      scripts.argumentScripts !== undefined &&
      (!Array.isArray(scripts.argumentScripts) ||
        scripts.argumentScripts.some((item) => typeof item !== "string"))
    )
      return "scripts.argumentScripts must be an array of strings";
  }
  if (
    profile.commands !== undefined &&
    (!Array.isArray(profile.commands) || profile.commands.some((item) => typeof item !== "string"))
  )
    return "commands must be an array of strings";
  if (
    profile.blacklistedCommands !== undefined &&
    (!Array.isArray(profile.blacklistedCommands) ||
      profile.blacklistedCommands.some((item) => typeof item !== "string"))
  )
    return "blacklistedCommands must be an array of strings";
  if (profile.allowedOrigins !== undefined) {
    if (!Array.isArray(profile.allowedOrigins)) return "allowedOrigins must be an array";
    for (const [index, origin] of profile.allowedOrigins.entries()) {
      if (typeof origin !== "string" || !isBrowserOrigin(origin))
        return `allowedOrigins[${index}] ${JSON.stringify(origin)} is not an origin; expected scheme://host such as https://app.example or moz-extension://<id>, with no path and no wildcard`;
    }
  }
  if (profile.commandPolicy !== undefined && !isCommandPolicy(profile.commandPolicy))
    return "commandPolicy must contain rules with allowSubcommands, denySubcommands or denyOptions arrays";
  if (profile.protectedPaths !== undefined && !isPathProtectionConfig(profile.protectedPaths))
    return "protectedPaths must contain extra and allow arrays of globs";
  if (profile.tools !== undefined) {
    if (!profile.tools || typeof profile.tools !== "object") return "tools must be an object";
    const tools = profile.tools as Record<string, unknown>;
    if (
      tools.disabled !== undefined &&
      (!Array.isArray(tools.disabled) ||
        tools.disabled.some((item) => typeof item !== "string" || !item.trim()))
    )
      return "tools.disabled must be an array of tool names";
    const validSets = [
      ...["codegraph", "analytics", "filesystem", "search", "commands"],
      ...LEGACY_TOOL_SETS,
    ];
    if (
      tools.disabledSets !== undefined &&
      (!Array.isArray(tools.disabledSets) ||
        tools.disabledSets.some((item) => typeof item !== "string" || !validSets.includes(item)))
    )
      return `tools.disabledSets may only contain ${validSets.join(", ")}`;
  }
  return undefined;
}
