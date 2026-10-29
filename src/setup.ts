import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { configPath, saveConfig } from "./config.js";
import { generalSearchWarning, mutatingScriptsWarning } from "./tools/policy.js";
import type { AgentConfig, PackageManager, Profile } from "./types.js";

export async function hasConfigFile(): Promise<boolean> {
  try {
    await access(configPath(), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function shouldOfferSetup(
  configExists: boolean,
  options: {
    random?: boolean | undefined;
    noTunnel?: boolean | undefined;
    tunnel?: string | undefined;
  },
): boolean {
  return !configExists && !options.random && !options.noTunnel && options.tunnel === undefined;
}

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  white: "\x1b[37m",
} as const;

const useColor = process.stdout.isTTY;
const color = (code: string, value: string): string =>
  useColor ? `${code}${value}${ANSI.reset}` : value;
const bold = (value: string): string => color(ANSI.bold, value);
const dim = (value: string): string => color(ANSI.dim, value);
const title = (value: string): string => color(ANSI.cyan, value);
const section = (value: string): string => color(ANSI.blue, value);
const success = (value: string): string => color(ANSI.green, value);
const warning = (value: string): string => color(ANSI.yellow, value);
const error = (value: string): string => color(ANSI.red, value);
const white = (value: string): string => color(ANSI.white, value);
const cyan = (value: string): string => color(ANSI.cyan, value);
const green = (value: string): string => color(ANSI.green, value);

const rule = (char = "─", width = 62): string => dim(char.repeat(width));

const ansiCodes = Object.values(ANSI);
const visibleLength = (value: string): number =>
  ansiCodes.reduce((result, code) => result.replaceAll(code, ""), value).length;

const wrapBoxLine = (line: string, maxLength: number): string[] => {
  if (visibleLength(line) <= maxLength) return [line];

  const style = ansiCodes.find((code) => line.startsWith(code)) ?? "";
  const plain = ansiCodes.reduce((result, code) => result.replaceAll(code, ""), line);
  const words = plain.split(" ").filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const word of words) {
    if (!current) current = word;
    else if (current.length + word.length + 1 <= maxLength) current += ` ${word}`;
    else {
      chunks.push(current);
      current = word;
    }
  }
  if (current) chunks.push(current);

  return chunks.map((chunk) => (style ? `${style}${chunk}${ANSI.reset}` : chunk));
};
const box = (lines: string[], width = 62): string[] => {
  const innerWidth = width - 2;
  const wrappedLines = lines.flatMap((line) => wrapBoxLine(line, innerWidth - 1));
  return [
    dim(`╭${"─".repeat(innerWidth)}╮`),
    ...wrappedLines.map((line) => {
      const length = visibleLength(line);
      return `${dim("│")} ${line}${" ".repeat(Math.max(0, innerWidth - length - 1))}${dim("│")}`;
    }),
    dim(`╰${"─".repeat(innerWidth)}╯`),
  ];
};
const printBox = (lines: string[], width = 62): void => {
  for (const line of box(lines, width)) console.log(line);
};

export async function runFirstTimeSetup(
  config: AgentConfig,
  defaultDirectory = ".",
): Promise<string | null | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const rl = createInterface({ input, output });
  try {
    console.log("");
    printBox([
      `${title(bold("AGENT-DIR"))}  ${white(bold("first-time setup"))}`,
      "",
      dim("Create a saved profile or start a temporary random Wormhole link."),
      `${dim("Config")}  ${white(configPath())}`,
    ]);
    if (!(await confirm(rl, "Set up a saved profile now?", true))) {
      console.log("");
      printBox([warning(bold("Setup skipped")), dim("Starting a temporary random Wormhole link.")]);
      return undefined;
    }

    console.log("");
    console.log(`${section("◆")} ${section(bold("Profile"))}`);
    console.log(rule());
    const name = await requiredText(rl, "Profile name", "default");
    const directory = resolve(await requiredText(rl, "Directory to expose", defaultDirectory));
    const port = await requiredPort(rl, 3002);
    const detectedPackageManager = await detectPackageManager(directory);
    console.log("");
    console.log(`${section("◆")} ${section(bold("Package manager"))}`);
    console.log(rule());
    const packageManager = await choose(
      rl,
      `Package manager${detectedPackageManager ? ` (detected ${detectedPackageManager})` : ""}`,
      ["npm", "pnpm", "yarn", "bun"] as const,
      detectedPackageManager ?? "npm",
    );
    let hostname: string | undefined;
    let cloudflaredToken: string | undefined;
    let subdomain: string | undefined;

    console.log("");
    console.log(`${section("◆")} ${section(bold("Cloudflare Tunnel"))}`);
    console.log(rule());
    const useCloudflared = await confirm(rl, "Set up Cloudflare Tunnel?", true);
    if (useCloudflared) {
      hostname = await requiredHostname(rl, "Public hostname (must be routed to this tunnel)");
      cloudflaredToken = await requiredSecret(rl, "Cloudflare tunnel token");
    }

    console.log("");
    console.log(`${section("◆")} ${section(bold("Wormhole"))}`);
    console.log(rule());
    const useWormhole = await confirm(rl, "Set up Wormhole too?", false);
    if (
      useWormhole &&
      (await confirm(rl, "Use a custom Wormhole subdomain? (No uses a random URL.)", false))
    ) {
      subdomain = await requiredText(rl, "Wormhole subdomain");
    }
    const tunnel = useCloudflared ? "cloudflared" : useWormhole ? "wormhole" : "none";
    const allowedScripts = await optionalList(
      rl,
      `Allowed ${packageManager} scripts (comma-separated, blank for none)`,
    );
    const commands = await optionalList(rl, "Allowed commands (comma-separated, blank for none)");
    const searchWarning = generalSearchWarning(commands);
    if (searchWarning) console.log(dim(`  \u2139 ${searchWarning}`));
    const scriptWarning = mutatingScriptsWarning(allowedScripts);
    if (scriptWarning) console.log(dim(`  \u26a0 ${scriptWarning}`));
    const protectedPaths = await optionalList(
      rl,
      "Extra protected paths agents may not edit (globs, comma-separated, blank for none; .git, .env* and .npmrc are always protected)",
    );

    console.log("");
    console.log(`${section("◆")} ${section(bold("Telemetry"))}`);
    console.log(rule());
    printBox([
      bold("Privacy first"),
      dim("Telemetry is optional and stays local on this machine."),
      dim("It helps us understand usage, failures, and reliability improvements."),
      dim("Standard levels avoid file contents, command arguments, tokens, and project paths."),
      dim("Diagnostic mode is for debugging only: it records host/user names and project paths,"),
      dim(
        "which can be sensitive; it stays local. Raw tool inputs and outputs are never recorded.",
      ),
    ]);

    console.log("");
    console.log(`  ${green("●")} ${white("none")}       ${dim("disabled")}`);
    console.log(
      `  ${cyan("●")} ${white("anonymous")}  ${dim("usage/tool metrics, success, duration, sizes, safe errors")}`,
    );
    console.log(
      `  ${cyan("●")} ${white("basic")}      ${dim("anonymous + Agent Dir, Node, platform, MCP client version")}`,
    );
    console.log(
      `  ${cyan("●")} ${white("detailed")}   ${dim("basic + coarse language, package manager, Git, CodeGraph, project size")}`,
    );
    console.log(
      `  ${cyan("●")} ${white("diagnostic")} ${dim("detailed + local paths, host/user, PID, Node version, memory/uptime")}`,
    );
    console.log("");
    const telemetry = await choose(
      rl,
      "Telemetry level",
      ["none", "anonymous", "basic", "detailed", "diagnostic"] as const,
      "none",
    );

    const profile: Profile = {
      directory,
      port,
      tunnel,
      defaultTunnel: tunnel,
      token: randomBytes(24).toString("hex"),
    };
    profile.packageManager = packageManager;
    if (subdomain) profile.subdomain = subdomain;
    if (hostname) profile.hostname = hostname;
    if (useCloudflared || useWormhole) {
      profile.tunnels = {
        ...(useWormhole ? { wormhole: { ...(subdomain ? { subdomain } : { random: true }) } } : {}),
        ...(useCloudflared && hostname
          ? { cloudflared: { hostname, ...(cloudflaredToken ? { token: cloudflaredToken } : {}) } }
          : {}),
      };
    }
    if (allowedScripts.length) profile.scripts = { allowedScripts };
    if (commands.length) profile.commands = commands;
    if (protectedPaths.length) profile.protectedPaths = { extra: protectedPaths };
    config.profiles[name] = profile;
    config.telemetry = { level: telemetry };
    await saveConfig(config);
    console.log("");
    printBox([
      success(bold("✓  Setup complete")),
      "",
      `${dim("Profile")}   ${bold(name)}`,
      `${dim("Directory")} ${directory}`,
      `${dim("Tunnel")}    ${tunnel}`,
      `${dim("Package manager")} ${packageManager}`,
      `${dim("Telemetry")} ${telemetry}`,
    ]);
    console.log("");
    console.log(`  ${dim("Config")}  ${white(configPath())}`);
    console.log(`  ${dim("Next")}    ${cyan(`agent-dir ${name}`)}`);
    return name;
  } finally {
    rl.close();
  }
}

async function detectPackageManager(directory: string): Promise<PackageManager | undefined> {
  try {
    const packageJson = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8")) as {
      packageManager?: unknown;
    };
    if (typeof packageJson.packageManager === "string") {
      const declared = packageJson.packageManager.split("@", 1)[0];
      if (declared && ["npm", "pnpm", "yarn", "bun"].includes(declared))
        return declared as PackageManager;
    }
  } catch {
    // Fall back to lockfile detection when package metadata is absent or invalid.
  }

  try {
    const files = new Set(await readdir(directory));
    if (files.has("pnpm-lock.yaml")) return "pnpm";
    if (files.has("yarn.lock")) return "yarn";
    if (files.has("bun.lock") || files.has("bun.lockb")) return "bun";
    if (files.has("package-lock.json")) return "npm";
  } catch {
    // A missing or unreadable directory simply leaves npm as the default.
  }
  return undefined;
}

async function requiredText(
  rl: ReturnType<typeof createInterface>,
  label: string,
  defaultValue?: string,
): Promise<string> {
  while (true) {
    const suffix = defaultValue ? ` ${dim(`[${defaultValue}]`)}` : "";
    const value = (await rl.question(`  ${bold(label)}${suffix}: `)).trim() || defaultValue;
    if (value) return value;
    console.log(`  ${error("✕")} ${dim("A value is required.")}`);
  }
}

async function requiredSecret(
  rl: ReturnType<typeof createInterface>,
  label: string,
): Promise<string> {
  while (true) {
    output.write(`  ${bold(label)}: `);
    const writableRl = rl as unknown as { _writeToOutput: (value: string) => void };
    const writeToOutput = writableRl._writeToOutput;
    writableRl._writeToOutput = () => {};
    let value: string;
    try {
      value = (await rl.question("")).trim();
    } finally {
      writableRl._writeToOutput = writeToOutput;
      output.write("\n");
    }
    if (value) return value;
    console.log(`  ${error("✕")} ${dim("A value is required.")}`);
  }
}

async function requiredHostname(
  rl: ReturnType<typeof createInterface>,
  label: string,
): Promise<string> {
  while (true) {
    const value = (await rl.question(`  ${bold(label)}: `)).trim().toLowerCase();
    const labels = value.split(".");
    const valid =
      value.length <= 253 &&
      labels.length >= 2 &&
      labels.every(
        (part) =>
          part.length >= 1 && part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part),
      );
    if (valid) return value;
    console.log(
      `  ${error("✕")} ${dim("Enter a hostname only, such as agent-dir-mcp.scriptr.uk (no spaces, https://, or path).")}`,
    );
  }
}

async function requiredPort(
  rl: ReturnType<typeof createInterface>,
  defaultValue: number,
): Promise<number> {
  while (true) {
    const value =
      (await rl.question(`  ${bold("Port")} ${dim(`[${defaultValue}]`)}: `)).trim() ||
      String(defaultValue);
    const port = Number(value);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
    console.log(`  ${error("✕")} ${dim("Port must be an integer between 1 and 65535.")}`);
  }
}

async function optionalList(
  rl: ReturnType<typeof createInterface>,
  label: string,
): Promise<string[]> {
  return (await rl.question(`  ${bold(label)}: `))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function confirm(
  rl: ReturnType<typeof createInterface>,
  label: string,
  defaultValue: boolean,
): Promise<boolean> {
  while (true) {
    const value = (
      await rl.question(`  ${bold(label)} ${dim(`[${defaultValue ? "Y/n" : "y/N"}]`)}: `)
    )
      .trim()
      .toLowerCase();
    if (!value) return defaultValue;
    if (value === "y" || value === "yes") return true;
    if (value === "n" || value === "no") return false;
    console.log(`  ${error("✕")} ${dim("Please answer yes or no.")}`);
  }
}

async function choose<T extends string>(
  rl: ReturnType<typeof createInterface>,
  label: string,
  choices: readonly T[],
  defaultValue: T,
): Promise<T> {
  console.log(`  ${bold(label)}:`);
  choices.forEach((choice, index) => {
    const marker = choice === defaultValue ? green("  • default") : "";
    console.log(`    ${color(ANSI.cyan, `${index + 1})`)} ${choice}${marker}`);
  });
  while (true) {
    const value = (
      await rl.question(`  ${bold("Choose")} ${dim(`[${choices.indexOf(defaultValue) + 1}]`)}: `)
    ).trim();
    if (!value) return defaultValue;
    const selected = choices[Number(value) - 1];
    if (selected) return selected;
    console.log(`  ${error("✕")} ${dim(`Choose a number from 1 to ${choices.length}.`)}`);
  }
}
