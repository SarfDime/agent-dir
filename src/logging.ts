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
  list_dirs: "🗂️",
  read_range: "📐",
  read_files: "📚",
  write_files: "📝",
  patch_files: "🧩",
  delete_files: "🗑️",
  run_npm_batch: "🔧",
  run_command_batch: "🛠️",
  search_files: "🔎",
  find_files: "🧭",
  search_code: "🧠",
  find_symbol: "🔹",
  find_definition: "🎯",
  find_references: "🔗",
  find_imports: "↪",
  find_exports: "↗",
  git_status: "🌿",
  git_stage: "➕",
  git_unstage: "➖",
  git_commit: "●",
  git_restore: "↩",
  git_push: "⬆",
  git_diff: "📝",
  git_log: "📜",
  project_overview: "🗺️",
  package_info: "📦",
  allowed_commands: "🔐",
  file_info: "ℹ️",
  diagnostics: "🩺",
};

const MCP_METHOD_ICONS: Record<string, string> = {
  initialize: "🚀",
  "notifications/initialized": "✓",
  "notifications/cancelled": "✖",
  "notifications/progress": "⏳",
  "notifications/resources/list_changed": "📣",
  "notifications/tools/list_changed": "📣",
  "notifications/prompts/list_changed": "📣",
  "notifications/roots/list_changed": "📣",
  "notifications/message": "💬",
  "notifications/elicitation/complete": "✓",
  "tools/list": "🧰",
  "resources/list": "📚",
  "resources/templates/list": "🗂️",
  "resources/read": "📖",
  "prompts/list": "💬",
  "prompts/get": "💬",
  "skills/list": "🧩",
  "skills/get": "🧩",
  "server/discover": "🔍",
  ping: "⚡",
  "subscriptions/listen": "📡",
};

const TOOL_NAME_WIDTH = Math.max(...Object.keys(TOOL_ICONS).map((name) => name.length));
const MCP_METHOD_NAME_WIDTH = Math.max(...Object.keys(MCP_METHOD_ICONS).map((name) => name.length));
const TOOL_COLORS: Record<string, string> = {
  list_files: CYAN,
  list_dirs: BRIGHT_CYAN,
  read_files: BRIGHT_GREEN,
  write_files: BRIGHT_YELLOW,
  patch_files: BRIGHT_MAGENTA,
  delete_files: BRIGHT_RED,
  run_npm_batch: BRIGHT_BLUE,
  run_command_batch: BRIGHT_CYAN,
  git_stage: YELLOW,
  git_unstage: MAGENTA,
  git_commit: BRIGHT_GREEN,
  git_restore: RED,
  git_push: BRIGHT_BLUE,
};

const NARROW_TOOL_ICONS = new Set(["✎", "✖", "⚙", "⌘", "↪", "↗"]);
const TOOL_ICON_SLOT_WIDTH = 3;

function toolIcon(name: string): string {
  return TOOL_ICONS[name] ?? MCP_METHOD_ICONS[name] ?? "•";
}

function toolColor(name?: string): string | undefined {
  return name ? TOOL_COLORS[name] : undefined;
}

function toolLabel(name: string): string {
  const icon = toolIcon(name);
  const iconWidth = NARROW_TOOL_ICONS.has(icon) ? 1 : 2;
  const iconSlot = `${icon}${" ".repeat(TOOL_ICON_SLOT_WIDTH - iconWidth)}`;
  const nameWidth = Object.hasOwn(TOOL_ICONS, name) ? TOOL_NAME_WIDTH : MCP_METHOD_NAME_WIDTH;
  return `${iconSlot}${name.padEnd(nameWidth)}`;
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
  writeLine("      --random               Use a random Wormhole URL (no subdomain)");
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
  const banner = [
    "╭──────────────────────────────────────────────────────────────╮",
    "│                         AGENT-DIR                            │",
    "╰──────────────────────────────────────────────────────────────╯",
  ];
  const gradient = [BRIGHT_CYAN, BRIGHT_BLUE, BRIGHT_MAGENTA];

  for (let i = 0; i < banner.length; i++) {
    writeLine(color(banner[i] ?? "", gradient[i] ?? BRIGHT_CYAN));
  }
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
  writeLine(`    ${color(toolLabel("list_dirs"), BRIGHT_CYAN)}`);
  writeLine(`    ${color(toolLabel("read_range"), GREEN)}`);
  writeLine(`    ${color(toolLabel("read_files"), BRIGHT_GREEN)}`);
  writeLine(`    ${color(toolLabel("write_files"), BRIGHT_YELLOW)}`);
  writeLine(`    ${color(toolLabel("patch_files"), BRIGHT_MAGENTA)}`);
  writeLine(`    ${color(toolLabel("delete_files"), BRIGHT_RED)}`);
  writeLine(`    ${color(toolLabel("run_npm_batch"), BRIGHT_BLUE)}`);
  writeLine(`    ${color(toolLabel("run_command_batch"), BRIGHT_CYAN)}`);
  writeLine(`    ${color(toolLabel("search_files"), CYAN)}`);
  writeLine(`    ${color(toolLabel("find_files"), CYAN)}`);
  writeLine(`    ${color(toolLabel("search_code"), BRIGHT_CYAN)}`);
  writeLine(`    ${color(toolLabel("find_symbol"), GREEN)}`);
  writeLine(`    ${color(toolLabel("find_definition"), GREEN)}`);
  writeLine(`    ${color(toolLabel("find_references"), GREEN)}`);
  writeLine(`    ${color(toolLabel("find_imports"), BRIGHT_GREEN)}`);
  writeLine(`    ${color(toolLabel("find_exports"), BRIGHT_GREEN)}`);
  writeLine(`    ${color(toolLabel("git_status"), CYAN)}`);
  writeLine(`    ${color(toolLabel("git_stage"), YELLOW)}`);
  writeLine(`    ${color(toolLabel("git_unstage"), MAGENTA)}`);
  writeLine(`    ${color(toolLabel("git_commit"), BRIGHT_GREEN)}`);
  writeLine(`    ${color(toolLabel("git_restore"), RED)}`);
  writeLine(`    ${color(toolLabel("git_push"), BRIGHT_BLUE)}`);
  writeLine(`    ${color(toolLabel("git_diff"), CYAN)}`);
  writeLine(`    ${color(toolLabel("git_log"), CYAN)}`);
  writeLine(`    ${color(toolLabel("project_overview"), BRIGHT_CYAN)}`);
  writeLine(`    ${color(toolLabel("package_info"), YELLOW)}`);
  writeLine(`    ${color(toolLabel("allowed_commands"), YELLOW)}`);
  writeLine(`    ${color(toolLabel("file_info"), YELLOW)}`);
  writeLine(`    ${color(toolLabel("diagnostics"), BRIGHT_YELLOW)}`);
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

const LOG_METHOD_WIDTH = 6;
const LOG_PATH_WIDTH = 16;
const LOG_STATUS_WIDTH = 5;

export function printRequestLog(entry: RequestLog): void {
  const method = `[${entry.method}]`.padEnd(LOG_METHOD_WIDTH);
  const path = entry.path.padEnd(LOG_PATH_WIDTH);
  const status = `[${entry.status}]`.padEnd(LOG_STATUS_WIDTH);
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

  const rawDetail = entry.tool
    ? entry.detail
      ? `${toolLabel(entry.tool)}  │  ${entry.detail}`
      : toolLabel(entry.tool).trimEnd()
    : entry.detail;
  const detail = entry.tool ? wrapToolDetail(rawDetail ?? "") : rawDetail;

  const detailLines = detail ? detail.split("\n") : [];
  writeLine(
    `  ├─ ${color(method, methodCode)}  ${color(path, methodCode)}  ${color(status, statusCode)}  ${color("•", methodCode)}${detailLines[0] ? ` ${detailLines[0]}` : ""}`,
  );
  for (const line of detailLines.slice(1)) writeLine(`  │      ${line}`);
}

function wrapToolDetail(detail: string): string {
  if (detail.length <= 100) return detail;

  const separator = detail.includes("  •  ") ? "  •  " : ", ";
  if (!detail.includes(separator)) return detail;

  const parts = detail.split(separator);
  if (parts.length < 2) return detail;

  return parts.join("\n");
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
