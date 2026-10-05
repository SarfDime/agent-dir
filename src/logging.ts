import type { RequestLog } from "./types.js";

const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const BLUE = "\x1b[34m";
const BRIGHT_BLUE = "\x1b[94m";
const BRIGHT_CYAN = "\x1b[96m";
const BRIGHT_MAGENTA = "\x1b[95m";
const BRIGHT_YELLOW = "\x1b[93m";
const BRIGHT_RED = "\x1b[91m";
const BRIGHT_GREEN = "\x1b[92m";

const writeLine = (line = ""): void => {
  process.stdout.write(`${line}\r\n`);
};

const color = (value: string, code: string): string => `${code}${value}${RESET}`;

const TOOL_ICONS: Record<string, string> = {
  list_files: "📂",
  list_dir: "📁",
  list_dirs: "🗂️",
  read_file: "📖",
  read_files: "📚",
  write_file: "✎",
  write_files: "📝",
  patch_file: "🩹",
  patch_files: "🧩",
  delete_file: "✖",
  delete_files: "🗑️",
  run_npm: "⚙",
  run_npm_batch: "🔧",
  run_command: "⌘",
  run_command_batch: "🛠️",
};

const TOOL_NAME_WIDTH = Math.max(...Object.keys(TOOL_ICONS).map((name) => name.length));
const TOOL_COLORS: Record<string, string> = {
  list_files: CYAN,
  list_dir: CYAN,
  list_dirs: BRIGHT_CYAN,
  read_file: GREEN,
  read_files: BRIGHT_GREEN,
  write_file: YELLOW,
  write_files: BRIGHT_YELLOW,
  patch_file: MAGENTA,
  patch_files: BRIGHT_MAGENTA,
  delete_file: RED,
  delete_files: BRIGHT_RED,
  run_npm: BLUE,
  run_npm_batch: BRIGHT_BLUE,
  run_command: CYAN,
  run_command_batch: BRIGHT_CYAN,
};

function toolIcon(name: string): string {
  return TOOL_ICONS[name] ?? "•";
}

function toolColor(name?: string): string | undefined {
  return name ? TOOL_COLORS[name] : undefined;
}

const NARROW_TOOL_ICONS = new Set(["✎", "✖", "⚙", "⌘"]);

function toolLabel(name: string): string {
  const icon = toolIcon(name);
  const iconSlot = NARROW_TOOL_ICONS.has(icon) ? ` ${icon} ` : `${icon} `;
  return `${iconSlot}${name.padEnd(TOOL_NAME_WIDTH)}`;
}

export function printHelp(): void {
  writeLine("agent-dir <directory|profile> [options]");
  writeLine("");
  writeLine("Expose a local project to an AI agent through authenticated MCP.");
  writeLine("");
  writeLine("Options:");
  writeLine("  -p, --port <port>          Local server port");
  writeLine("  -t, --tunnel <provider>    Tunnel provider (none, wormhole)");
  writeLine("  -s, --subdomain <name>     Wormhole subdomain");
  writeLine("      --directory <path>     Directory to expose");
  writeLine("      --npm <scripts>        Comma-separated allowed npm scripts");
  writeLine("      --command <commands>   Comma-separated allowed commands");
  writeLine("      --token <token>        Explicit Bearer token");
  writeLine("      --no-tunnel            Disable tunneling");
  writeLine("  -h, --help                 Show this help");
  writeLine("");
  writeLine("Config:");
  writeLine("  agent-dir config add <name> ...");
  writeLine("  agent-dir config list");
  writeLine("  agent-dir config show <name>");
  writeLine("  agent-dir config remove <name>");
  writeLine("  agent-dir config token <name>");
}

export function printBanner(options: {
  root: string;
  port: number;
  tunnel: string;
  profileName?: string;
  subdomain?: string;
  token?: string;
  npmScripts?: string[];
  commands?: string[];
}): void {
  writeLine("");
  writeLine("╭──────────────────────────────────────────────────────────────╮");
  writeLine("│                         AGENT-DIR                            │");
  writeLine("╰──────────────────────────────────────────────────────────────╯");
  writeLine("");
  writeLine(`  Directory    ${options.root}`);
  writeLine(`  Port         ${options.port}`);
  writeLine(`  Config       ${options.profileName ?? "CLI options"}`);
  writeLine(`  Tunnel       ${options.tunnel}`);
  if (options.subdomain) writeLine(`  Domain       https://${options.subdomain}.wormhole.bar`);
  writeLine("");
  writeLine("  MCP");
  writeLine(`    ${color("⚡ /mcp", CYAN)}`);
  writeLine("");
  writeLine("  TOOLS");
  writeLine(`    ${color(toolLabel("list_files"), CYAN)}`);
  writeLine(`    ${color(toolLabel("list_dir"), CYAN)}`);
  writeLine(`    ${color(toolLabel("list_dirs"), BRIGHT_CYAN)}`);
  writeLine(`    ${color(toolLabel("read_file"), GREEN)}`);
  writeLine(`    ${color(toolLabel("read_files"), BRIGHT_GREEN)}`);
  writeLine(`    ${color(toolLabel("write_file"), YELLOW)}`);
  writeLine(`    ${color(toolLabel("write_files"), BRIGHT_YELLOW)}`);
  writeLine(`    ${color(toolLabel("patch_file"), MAGENTA)}`);
  writeLine(`    ${color(toolLabel("patch_files"), BRIGHT_MAGENTA)}`);
  writeLine(`    ${color(toolLabel("delete_file"), RED)}`);
  writeLine(`    ${color(toolLabel("delete_files"), BRIGHT_RED)}`);
  writeLine(`    ${color(toolLabel("run_npm"), BLUE)}`);
  writeLine(`    ${color(toolLabel("run_npm_batch"), BRIGHT_BLUE)}`);
  writeLine(`    ${color(toolLabel("run_command"), CYAN)}`);
  writeLine(`    ${color(toolLabel("run_command_batch"), BRIGHT_CYAN)}`);
  writeLine("");
  if (options.npmScripts?.length) {
    writeLine("  NPM COMMANDS");
    for (const script of options.npmScripts) writeLine(`    ${color("•", BLUE)} npm run ${script}`);
    writeLine("");
  }
  if (options.commands?.length) {
    writeLine("  ALLOWED COMMANDS");
    for (const command of options.commands) writeLine(`    ${color("•", CYAN)} ${command}`);
    writeLine("");
  }
}

export function printRequestLog(entry: RequestLog): void {
  const method = entry.method;
  const path = entry.path.padEnd(8);
  const status = String(entry.status);
  const statusCode = entry.status >= 500 ? RED : entry.status >= 400 ? YELLOW : GREEN;
  const methodCode =
    toolColor(entry.tool) ??
    (entry.method === "GET"
      ? CYAN
      : entry.method === "POST"
        ? MAGENTA
        : entry.method === "PUT"
          ? YELLOW
          : RED);

  const detail = entry.tool
    ? [toolLabel(entry.tool), entry.detail].filter(Boolean).join("  │  ")
    : entry.detail;
  writeLine(
    `  ├─ [${color(method, methodCode)}]  ${color(path, methodCode)}  [${color(status, statusCode)}]${detail ? `  ${color("•", methodCode)} ${detail}` : ""}`,
  );
}

export function logRequest(entry: RequestLog): void {
  printRequestLog(entry);
}

export function printRequestHeader(): void {
  writeLine("");
  writeLine("  ──────────────────────────────────────────────────────────────");
  writeLine("  [Request logs]");
  writeLine("  ──────────────────────────────────────────────────────────────");
}
