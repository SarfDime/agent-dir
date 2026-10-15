#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { configPath, loadConfig, mergeProfile, saveConfig } from "../src/config.js";
import { printBanner, printHelp, printRequestHeader } from "../src/logging.js";
import { startServer } from "../src/server.js";
import { hasConfigFile, runFirstTimeSetup, shouldOfferSetup } from "../src/setup.js";
import { summarizeTelemetry } from "../src/telemetry/aggregate.js";
import { isTelemetryLevel } from "../src/telemetry/config.js";
import { formatTelemetrySummary } from "../src/telemetry/format.js";
import {
  ensureTelemetryDirectory,
  migrateLegacyTelemetry,
  readAllTelemetryEvents,
  resetTelemetry,
  TELEMETRY_DIRECTORY,
} from "../src/telemetry/storage.js";
import { startTunnel } from "../src/tunnel.js";
import type { CommandConfig, Profile, TunnelResult } from "../src/types.js";

const require = createRequire(import.meta.url);
const packageVersion = (require("../../package.json") as { version: string }).version;

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function parseList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePort(value: string | undefined, fallback: number): number {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    fail("port must be an integer between 1 and 65535.");
  }
  return port;
}

const { values, positionals } = parseArgs({
  options: {
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    directory: { type: "string", short: "d" },
    port: { type: "string", short: "p" },
    tunnel: { type: "string", short: "t" },
    wormhole: { type: "boolean", short: "w" },
    cloudflared: { type: "boolean", short: "c" },
    subdomain: { type: "string", short: "s" },
    hostname: { type: "string" },
    "cloudflared-token": { type: "string" },
    npm: { type: "string" },
    command: { type: "string" },
    blacklist: { type: "string" },
    token: { type: "string" },
    rotate: { type: "boolean" },
    "no-tunnel": { type: "boolean" },
    random: { type: "boolean" },
    follow: { type: "boolean" },
    all: { type: "boolean" },
    yes: { type: "boolean", short: "y" },
  },
  allowPositionals: true,
  allowNegative: true,
  strict: true,
});

if (values.help) {
  printHelp();
  process.exit(0);
}

if (values.version) {
  console.log(packageVersion);
  process.exit(0);
}

const config = await loadConfig();
let command = positionals[0];

if (command === "setup") {
  await runFirstTimeSetup(config, positionals[1] ?? ".");
  process.exit(0);
}

if (
  shouldOfferSetup(await hasConfigFile(), {
    random: values.random,
    noTunnel: values["no-tunnel"],
    tunnel:
      values.tunnel ??
      (values.wormhole ? "wormhole" : values.cloudflared ? "cloudflared" : undefined),
  }) &&
  command !== "config" &&
  command !== "telemetry"
) {
  const profileName = await runFirstTimeSetup(config, positionals[0] ?? ".");
  if (profileName) command = profileName;
  else if (profileName === undefined) {
    values.random = true;
    values.tunnel = "wormhole";
  }
}

if (command === "telemetry") {
  const action = positionals[1];
  const currentLevel = config.telemetry?.level ?? "none";
  const telemetryProfile = positionals[2];
  const telemetrySession = positionals[3];
  if (action === "status") {
    console.log(`Telemetry: ${currentLevel === "none" ? "disabled" : "enabled"}`);
    console.log(`Level: ${currentLevel}`);
    console.log(`Config: ${configPath()}`);
    process.exit(0);
  }
  if (action === "enable") {
    const level = positionals[2];
    if (!level || !isTelemetryLevel(level) || level === "none")
      fail("Usage: agent-dir telemetry enable <anonymous|basic|detailed|diagnostic>");
    config.telemetry = { level };
    await saveConfig(config);
    console.log(`✓ Telemetry enabled at ${level} level.`);
    process.exit(0);
  }
  if (action === "disable") {
    config.telemetry = { level: "none" };
    await saveConfig(config);
    console.log("✓ Telemetry disabled.");
    process.exit(0);
  }
  if (action === "schema") {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          session: [
            "event",
            "wallClockDurationMs",
            "activeRequestDurationMs",
            "idleGapDurationMs",
            "requestCount",
            "toolCallCount",
            "commandCallCount",
          ],
          envelope: ["configId", "sessionId", "timestamp", "level", "event"],
          events: ["mcp_request", "tool_call", "command_call", "tunnel", "session"],
          levels: ["none", "anonymous", "basic", "detailed", "diagnostic"],
          successMetrics: {
            mcp: "successful mcp_request events / mcp_request events",
            tool: "successful tool_call events / tool_call events",
            command: "successful command_call events / command_call events",
            overall: "not defined; MCP and tool events are related and must not be combined",
          },
          aggregation: "agent-dir telemetry summary",
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }
  if (action === "summary") {
    console.log(
      formatTelemetrySummary(
        summarizeTelemetry(
          readAllTelemetryEvents().filter(
            (event) => !telemetryProfile || event.configId === telemetryProfile,
          ),
        ),
        currentLevel,
      ),
    );
    process.exit(0);
  }
  if (action === "show") {
    const printEvents = (): void => {
      const events = readAllTelemetryEvents().filter(
        (event) =>
          (!telemetryProfile || event.configId === telemetryProfile) &&
          (!telemetrySession || event.sessionId === telemetrySession),
      );
      const grouped = new Map<string, Map<string, unknown[]>>();
      for (const event of events) {
        const configId =
          isRecord(event) && typeof event.configId === "string" ? event.configId : "unknown";
        const sessions = grouped.get(configId) ?? new Map<string, unknown[]>();
        const sessionId =
          isRecord(event) && typeof event.sessionId === "string" ? event.sessionId : "unknown";
        sessions.set(sessionId, [...(sessions.get(sessionId) ?? []), event]);
        grouped.set(configId, sessions);
      }
      console.log(
        JSON.stringify(
          {
            enabled: currentLevel !== "none",
            level: currentLevel,
            configCount: grouped.size,
            configs: Object.fromEntries(
              [...grouped.entries()].map(([configId, sessions]) => [
                configId,
                {
                  sessionCount: sessions.size,
                  sessions: Object.fromEntries(
                    [...sessions.entries()].map(([sessionId, sessionEvents]) => [
                      sessionId,
                      { count: sessionEvents.length, events: sessionEvents },
                    ]),
                  ),
                },
              ]),
            ),
          },
          null,
          2,
        ),
      );
    };
    printEvents();
    if (values.follow) {
      ensureTelemetryDirectory();
      const watcher = watch(TELEMETRY_DIRECTORY, { recursive: true }, () => {
        process.stdout.write("\x1b[2J\x1b[H");
        printEvents();
      });
      const close = (): void => {
        watcher.close();
        process.exit(0);
      };
      process.on("SIGINT", close);
      process.on("SIGTERM", close);
      await new Promise<void>(() => {});
    }
    process.exit(0);
  }
  if (action === "reset") {
    if (values.all && telemetryProfile) fail("Use either a profile name or --all, not both.");
    if (!values.all && !telemetryProfile)
      fail("Usage: agent-dir telemetry reset <profile> | --all");
    if (values.all) {
      delete config.telemetry;
      await saveConfig(config);
      resetTelemetry(undefined, true);
      console.log("✓ Telemetry settings reset and all recorded data was cleared.");
    } else {
      migrateLegacyTelemetry();
      resetTelemetry(telemetryProfile);
      console.log(`✓ Telemetry data cleared for profile: ${telemetryProfile}`);
    }
    process.exit(0);
  }
  fail("Usage: agent-dir telemetry {status|enable|disable|schema|show|summary|reset}");
}

if (command === "config") {
  const action = positionals[1];

  if (action === "list") {
    const names = Object.keys(config.profiles);
    console.log(names.length ? names.join("\n") : "No profiles configured.");
    process.exit(0);
  }

  if (action === "show") {
    const name = positionals[2];
    if (!name || !config.profiles[name]) fail(`Profile not found: ${name}`);
    const profile = structuredClone(config.profiles[name]);
    if (profile.token) profile.token = "<configured>";
    if (profile.tunnels?.cloudflared?.token) profile.tunnels.cloudflared.token = "<configured>";
    console.log(JSON.stringify(profile, null, 2));
    process.exit(0);
  }

  if (action === "delete" || action === "remove") {
    const name = positionals[2];
    const deleteAll = values.all === true;

    if (deleteAll && name) fail("Do not combine --all with a profile name.");
    if (!deleteAll && !name) fail("Usage: agent-dir config delete <profile> | --all");

    const names = Object.keys(config.profiles);
    if (deleteAll) {
      if (names.length === 0) {
        console.log("No profiles configured.");
        process.exit(0);
      }
      const confirmed = await confirmConfigDelete(
        `Delete all ${names.length} configured profile${names.length === 1 ? "" : "s"}?`,
        values.yes === true,
      );
      if (!confirmed) {
        console.log("Deletion cancelled.");
        process.exit(0);
      }
      for (const profileName of names) delete config.profiles[profileName];
      await saveConfig(config);
      console.log(`✓ Deleted ${names.length} profile${names.length === 1 ? "" : "s"}.`);
      process.exit(0);
    }

    if (!name || !config.profiles[name]) fail(`Profile not found: ${name}`);
    const confirmed = await confirmConfigDelete(`Delete profile '${name}'?`, values.yes === true);
    if (!confirmed) {
      console.log("Deletion cancelled.");
      process.exit(0);
    }
    delete config.profiles[name];
    await saveConfig(config);
    console.log(`✓ Deleted profile '${name}'.`);
    process.exit(0);
  }

  if (action === "token") {
    const name = positionals[2];
    if (!name || !config.profiles[name]) fail(`Profile not found: ${name}`);
    if (values.rotate === true) {
      config.profiles[name].token = randomBytes(24).toString("hex");
      await saveConfig(config);
      console.log(`✓ Rotated token for '${name}'.`);
    }
    if (!config.profiles[name].token) {
      fail(`Profile '${name}' does not have an authentication token.`);
    }
    console.log(config.profiles[name].token);
    process.exit(0);
  }

  if (action === "add") {
    const name = positionals[2];
    if (!name) fail("Usage: agent-dir config add <name> [options]");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
      fail("Profile names may contain letters, numbers, dots, underscores, and hyphens.");

    if (values.wormhole && values.cloudflared) fail("Choose only one of -w or -c.");
    if ((values.wormhole || values.cloudflared) && values.tunnel)
      fail("Use either -w/-c or --tunnel, not both.");
    const tunnel = values.wormhole
      ? "wormhole"
      : values.cloudflared
        ? "cloudflared"
        : (values.tunnel ??
          (values.hostname
            ? "cloudflared"
            : values.subdomain || values.random
              ? "wormhole"
              : "none"));
    if (tunnel !== "none" && tunnel !== "wormhole" && tunnel !== "cloudflared")
      fail(`Unsupported tunnel provider: ${tunnel}`);

    const profile: Profile = {
      directory: resolve(values.directory ?? "."),
      port: parsePort(values.port, 3002),
      tunnel,
      token: values.token ?? randomBytes(24).toString("hex"),
    };

    if (values.subdomain) profile.subdomain = values.subdomain;
    if (values.hostname) profile.hostname = values.hostname;
    if (values.subdomain || values.hostname || values.random) {
      profile.tunnels = {
        ...(values.subdomain || values.random
          ? {
              wormhole: {
                ...(values.subdomain ? { subdomain: values.subdomain } : { random: true }),
              },
            }
          : {}),
        ...(values.hostname
          ? {
              cloudflared: {
                hostname: values.hostname,
                ...(values["cloudflared-token"] ? { token: values["cloudflared-token"] } : {}),
              },
            }
          : {}),
      };
      profile.defaultTunnel = tunnel;
    }
    const npm = parseList(values.npm);
    if (npm !== undefined) profile.npm = { allowedScripts: npm };
    const commands = parseList(values.command);
    if (commands !== undefined) profile.commands = commands;
    const blacklist = parseList(values.blacklist);
    if (blacklist !== undefined) profile.blacklistedCommands = blacklist;

    if (profile.tunnel === "wormhole" && !profile.subdomain && !values.random) {
      fail("Wormhole profiles require --subdomain <name>, or use --random.");
    }
    if (profile.tunnel === "cloudflared" && !profile.hostname) {
      fail(
        "Cloudflared profiles require --hostname <host> (a hostname already routed to your named Cloudflare Tunnel).",
      );
    }

    config.profiles[name] = profile;
    await saveConfig(config);
    console.log(`✓ Saved profile '${name}'.`);
    console.log(`  Config: ${configPath()}`);
    process.exit(0);
  }

  fail("Usage: agent-dir config {add|list|show|delete|token}");
}

const profile = command ? config.profiles[command] : undefined;
if (command && command !== "config" && !profile && command.startsWith("-")) {
  fail(`Unknown command: ${command}`);
}

const positionalDirectory = profile ? positionals[1] : positionals[0];
const directory = resolve(values.directory ?? profile?.directory ?? positionalDirectory ?? ".");
const port = parsePort(values.port, profile?.port ?? 3002);
if (values.wormhole && values.cloudflared) fail("Choose only one of -w or -c.");
if ((values.wormhole || values.cloudflared) && values.tunnel)
  fail("Use either -w/-c or --tunnel, not both.");
const configuredDefault =
  profile?.defaultTunnel ??
  (profile?.tunnels?.cloudflared ? "cloudflared" : (profile?.tunnel ?? "none"));
const tunnelValue = values["no-tunnel"]
  ? "none"
  : values.wormhole
    ? "wormhole"
    : values.cloudflared
      ? "cloudflared"
      : (values.tunnel ?? configuredDefault);
if (tunnelValue !== "none" && tunnelValue !== "wormhole" && tunnelValue !== "cloudflared") {
  fail(`Unsupported tunnel provider: ${tunnelValue}`);
}

const tunnel: Profile["tunnel"] = tunnelValue;
const randomTunnel =
  values.random === true ||
  (values.subdomain === undefined && profile?.tunnels?.wormhole?.random === true);
const subdomain = randomTunnel
  ? undefined
  : (values.subdomain ?? profile?.tunnels?.wormhole?.subdomain ?? profile?.subdomain);
const hostname = values.hostname ?? profile?.tunnels?.cloudflared?.hostname ?? profile?.hostname;
const cloudflaredToken = values["cloudflared-token"] ?? profile?.tunnels?.cloudflared?.token;
if (tunnel === "wormhole" && !subdomain && !randomTunnel) {
  fail("Wormhole requires --subdomain <name>, or use --random.");
}
if (tunnel === "cloudflared" && !hostname) {
  fail(
    "Cloudflared requires --hostname <host> (a hostname already routed to your named Cloudflare Tunnel).",
  );
}
if (randomTunnel && tunnel !== "wormhole") {
  fail("--random requires --tunnel wormhole.");
}

const token = values.token ?? profile?.token ?? randomBytes(24).toString("hex");
const npm = parseList(values.npm);
const commands = parseList(values.command);
const blacklist = parseList(values.blacklist);
const overrides: CommandConfig = {};
if (npm !== undefined) overrides.npm = { allowedScripts: npm };
if (commands !== undefined) overrides.commands = commands;
if (blacklist !== undefined) overrides.blacklistedCommands = blacklist;
const commandConfig = mergeProfile(profile ?? { directory, port, tunnel }, overrides);
const telemetryConfigId = profile
  ? command
  : createHash("sha256")
      .update(
        JSON.stringify({
          directory,
          port,
          tunnel,
          subdomain,
          hostname,
          randomTunnel,
          npm: commandConfig.npm?.allowedScripts ?? [],
          commands: commandConfig.commands ?? [],
          blacklistedCommands: commandConfig.blacklistedCommands ?? [],
        }),
      )
      .digest("hex")
      .slice(0, 12);

const bannerOptions: Parameters<typeof printBanner>[0] = {
  root: directory,
  port,
  tunnel,
};

const npmScripts = commandConfig.npm?.allowedScripts;
const allowedCommands = commandConfig.commands;

if (profile && command) bannerOptions.profileName = command;
if (subdomain) bannerOptions.subdomain = subdomain;
if (hostname) bannerOptions.hostname = hostname;
if (npmScripts) bannerOptions.npmScripts = npmScripts;
if (allowedCommands) bannerOptions.commands = allowedCommands;
if (commandConfig.blacklistedCommands?.length) {
  bannerOptions.blacklistedCommands = commandConfig.blacklistedCommands;
}

printBanner(bannerOptions);

const telemetrySessionId = randomUUID();
const server = await startServer({
  root: directory,
  port,
  token,
  commandConfig,
  telemetry: {
    ...(config.telemetry ?? { level: "none" }),
    ...(telemetryConfigId ? { configId: telemetryConfigId } : {}),
    sessionId: telemetrySessionId,
    persist: true,
  },
});
let tunnelResult: TunnelResult | undefined;
console.log("  ✓ SERVER ONLINE");
console.log(`    Local target : http://127.0.0.1:${port}`);
console.log("    Auth         : Bearer token");
console.log("    Token        : <configured>");

if (tunnel !== "none") {
  try {
    tunnelResult = await startTunnel({
      provider: tunnel as "wormhole" | "cloudflared",
      port,
      ...(hostname ? { hostname } : {}),
      ...(cloudflaredToken ? { cloudflaredToken } : {}),
      token,
      telemetry: {
        ...(config.telemetry ?? { level: "none" }),
        ...(telemetryConfigId ? { configId: telemetryConfigId } : {}),
        sessionId: telemetrySessionId,
        persist: true,
      },
      random: randomTunnel,
      ...(subdomain && !randomTunnel ? { subdomain } : {}),
    });
  } catch (error) {
    console.error(`  ✖ TUNNEL ERROR  ${error instanceof Error ? error.message : String(error)}`);
    await server.close();
    process.exit(1);
  }
}

printRequestHeader();

let shuttingDown = false;

const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n  Stopping agent-dir...");
  tunnelResult?.stop?.();
  if (tunnelResult?.child && !tunnelResult.stop && !tunnelResult.child.killed)
    tunnelResult.child.kill("SIGTERM");
  await server.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function confirmConfigDelete(message: string, skipPrompt: boolean): Promise<boolean> {
  if (skipPrompt) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`⚠ ${message} [y/N]: `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
