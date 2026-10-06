#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { configPath, loadConfig, mergeProfile, saveConfig } from "../src/config.js";
import { printBanner, printHelp, printRequestHeader } from "../src/logging.js";
import { startServer } from "../src/server.js";
import { startTunnel } from "../src/tunnel.js";
import type { CommandConfig, Profile, TunnelResult } from "../src/types.js";

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
    directory: { type: "string", short: "d" },
    port: { type: "string", short: "p" },
    tunnel: { type: "string", short: "t" },
    subdomain: { type: "string", short: "s" },
    npm: { type: "string" },
    command: { type: "string" },
    token: { type: "string" },
    "no-tunnel": { type: "boolean" },
    random: { type: "boolean" },
  },
  allowPositionals: true,
  strict: true,
});

if (values.help) {
  printHelp();
  process.exit(0);
}

const config = await loadConfig();
const command = positionals[0];

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
    console.log(JSON.stringify(profile, null, 2));
    process.exit(0);
  }

  if (action === "remove") {
    const name = positionals[2];
    if (!name || !config.profiles[name]) fail(`Profile not found: ${name}`);
    delete config.profiles[name];
    await saveConfig(config);
    console.log(`✓ Removed profile '${name}'.`);
    process.exit(0);
  }

  if (action === "token") {
    const name = positionals[2];
    if (!name || !config.profiles[name]) fail(`Profile not found: ${name}`);
    config.profiles[name].token = randomBytes(24).toString("hex");
    await saveConfig(config);
    console.log(`✓ Rotated token for '${name}'.`);
    console.log(`  Config: ${configPath()}`);
    process.exit(0);
  }

  if (action === "add") {
    const name = positionals[2];
    if (!name) fail("Usage: agent-dir config add <name> [options]");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
      fail("Profile names may contain letters, numbers, dots, underscores, and hyphens.");

    const tunnel = values.tunnel ?? "none";
    if (tunnel !== "none" && tunnel !== "wormhole") fail(`Unsupported tunnel provider: ${tunnel}`);

    const profile: Profile = {
      directory: resolve(values.directory ?? "."),
      port: parsePort(values.port, 3002),
      tunnel,
      token: values.token ?? randomBytes(24).toString("hex"),
    };

    if (values.subdomain) profile.subdomain = values.subdomain;
    const npm = parseList(values.npm);
    if (npm !== undefined) profile.npm = { allowedScripts: npm };
    const commands = parseList(values.command);
    if (commands !== undefined) profile.commands = commands;

    if (profile.tunnel === "wormhole" && !profile.subdomain && !values.random) {
      fail("Wormhole profiles require --subdomain <name>, or use --random.");
    }

    config.profiles[name] = profile;
    await saveConfig(config);
    console.log(`✓ Saved profile '${name}'.`);
    console.log(`  Config: ${configPath()}`);
    process.exit(0);
  }

  fail("Usage: agent-dir config {add|list|show|remove|token}");
}

const profile = command ? config.profiles[command] : undefined;
if (command && command !== "config" && !profile && command.startsWith("-")) {
  fail(`Unknown command: ${command}`);
}

const positionalDirectory = profile ? positionals[1] : positionals[0];
const directory = resolve(values.directory ?? profile?.directory ?? positionalDirectory ?? ".");
const port = parsePort(values.port, profile?.port ?? 3002);
const tunnelValue = values["no-tunnel"] ? "none" : (values.tunnel ?? profile?.tunnel ?? "none");
if (tunnelValue !== "none" && tunnelValue !== "wormhole") {
  fail(`Unsupported tunnel provider: ${tunnelValue}`);
}

const tunnel: Profile["tunnel"] = tunnelValue;
const randomTunnel = values.random === true;
const subdomain = randomTunnel ? undefined : (values.subdomain ?? profile?.subdomain);
if (tunnel === "wormhole" && !subdomain && !randomTunnel) {
  fail("Wormhole requires --subdomain <name>, or use --random.");
}
if (randomTunnel && tunnel === "none") {
  fail("--random requires --tunnel wormhole.");
}

const token = values.token ?? profile?.token ?? randomBytes(24).toString("hex");
const npm = parseList(values.npm);
const commands = parseList(values.command);
const overrides: CommandConfig = {};
if (npm !== undefined) overrides.npm = { allowedScripts: npm };
if (commands !== undefined) overrides.commands = commands;
const commandConfig = mergeProfile(profile ?? { directory, port, tunnel }, overrides);

const bannerOptions: Parameters<typeof printBanner>[0] = {
  root: directory,
  port,
  tunnel,
  token,
};

const npmScripts = commandConfig.npm?.allowedScripts;
const allowedCommands = commandConfig.commands;

if (profile && command) bannerOptions.profileName = command;
if (subdomain) bannerOptions.subdomain = subdomain;
if (npmScripts) bannerOptions.npmScripts = npmScripts;
if (allowedCommands) bannerOptions.commands = allowedCommands;

printBanner(bannerOptions);

const server = await startServer({ root: directory, port, token, commandConfig });
let tunnelResult: TunnelResult | undefined;
console.log("  ✓ SERVER ONLINE");
console.log(`    Local target : http://127.0.0.1:${port}`);
console.log("    Auth         : Bearer token");
console.log(`    Token        : ${token}`);

if (tunnel !== "none") {
  try {
    tunnelResult = await startTunnel({
      provider: "wormhole",
      port,
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
  if (tunnelResult?.child && !tunnelResult.child.killed) tunnelResult.child.kill("SIGTERM");
  await server.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
