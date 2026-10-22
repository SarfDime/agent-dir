import type { RequestLog } from "./types.js";

const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const BRIGHT_BLUE = "\x1b[94m";
const BRIGHT_CYAN = "\x1b[96m";
const BRIGHT_MAGENTA = "\x1b[95m";
const BRIGHT_YELLOW = "\x1b[93m";
const BRIGHT_GREEN = "\x1b[92m";

const writeLine = (line = ""): void => {
  process.stdout.write(`${line}\r\n`);
};

const color = (value: string, code: string): string => `${code}${value}${RESET}`;

const TOOL_ICONS: Record<string, string> = {
  read_range: "📐",
  run_package_scripts_batch: "🔧",
  run_command_batch: "🛠️",
  find_files: "🧭",
  search_code: "🧠",
  find_symbol: "🔹",
  find_references: "🔗",
  file_info: "ℹ️",
  project_context: "🧭",
  apply_changes: "✏️",
  validate: "✓",
};

const MCP_METHOD_ICONS: Record<string, string> = {
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
  run_package_scripts_batch: BRIGHT_BLUE,
  run_command_batch: BRIGHT_CYAN,
};

const NARROW_TOOL_ICONS = new Set(["✎", "✖", "⚙", "⌘", "↪", "↗"]);
const DIM = "\x1b[90m";

function visibleLength(value: string): number {
  const esc = String.fromCharCode(27);
  const plain = value
    .replaceAll(`${esc}[90m`, "")
    .replaceAll(`${esc}[0m`, "")
    .replaceAll(`${esc}[92m`, "")
    .replaceAll(`${esc}[96m`, "")
    .replaceAll(`${esc}[95m`, "")
    .replaceAll(`${esc}[94m`, "")
    .replaceAll(`${esc}[93m`, "")
    .replaceAll(`${esc}[32m`, "")
    .replaceAll(`${esc}[36m`, "")
    .replaceAll(`${esc}[35m`, "")
    .replaceAll(`${esc}[34m`, "")
    .replaceAll(`${esc}[33m`, "");
  let width = 0;
  for (const character of plain) {
    const code = character.codePointAt(0) ?? 0;
    width +=
      code >= 0x1100 &&
      (code <= 0x115f ||
        code === 0x2329 ||
        code === 0x232a ||
        (code >= 0x2e80 && code <= 0xa4cf) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe10 && code <= 0xfe19) ||
        (code >= 0xfe30 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x1f300 && code <= 0x1faff))
        ? 2
        : 1;
  }
  return width;
}

const BOX_WIDTH = 76;

function boxTop(label: string, borderColor: string, width = BOX_WIDTH): string {
  const heading = `─ ${label} `;
  return `  ${color(`╭${heading}${"─".repeat(Math.max(1, width - visibleLength(heading) - 2))}╮`, borderColor)}`;
}

function boxContent(content: string, borderColor: string, width = BOX_WIDTH): string {
  const padding = Math.max(0, width - visibleLength(content) - 3);
  return `  ${color("│", borderColor)} ${content}${" ".repeat(padding)}${color("│", borderColor)}`;
}

function boxBottom(borderColor: string, width = BOX_WIDTH): string {
  return `  ${color(`╰${"─".repeat(width - 2)}╯`, borderColor)}`;
}

function printGrid(items: string[], columns = 2): void {
  const width = Math.max(40, Math.min(100, (process.stdout.columns || 100) - 4));
  const columnWidth = Math.floor(width / columns);
  for (let index = 0; index < items.length; index += columns) {
    const row = items.slice(index, index + columns);
    writeLine(
      `  ${row
        .map(
          (item) =>
            item +
            " ".repeat(
              Math.max(
                1,
                columnWidth -
                  item.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "").length,
              ),
            ),
        )
        .join("")}`,
    );
  }
}

function toolIcon(name: string): string {
  return TOOL_ICONS[name] ?? MCP_METHOD_ICONS[name] ?? "•";
}

function toolColor(name?: string): string | undefined {
  return name ? TOOL_COLORS[name] : undefined;
}

function toolLabel(name: string): string {
  const icon = toolIcon(name);
  const iconWidth = NARROW_TOOL_ICONS.has(icon) ? 1 : 2;
  const iconSlot = `${icon}${" ".repeat(Math.max(0, 2 - iconWidth))}`;
  const nameWidth = Math.max(TOOL_NAME_WIDTH, MCP_METHOD_NAME_WIDTH);
  return `${iconSlot} ${name.padEnd(nameWidth)}`;
}

export function printHelp(): void {
  writeLine("agent-dir <directory|profile> [options]");
  writeLine("");
  writeLine("Expose a local project to an AI agent through authenticated MCP.");
  writeLine("");
  writeLine("Options:");
  writeLine("  -p, --port <port>          Local server port");
  writeLine("  -t, --tunnel <provider>    Explicit tunnel provider (none, wormhole, cloudflared)");
  writeLine("  -w, --wormhole             Use Wormhole for this run");
  writeLine("  -c, --cloudflared          Use Cloudflare Tunnel for this run");
  writeLine("  -s, --subdomain <name>     Wormhole subdomain");
  writeLine("      --hostname <host>      Hostname routed to a Cloudflare Tunnel");
  writeLine(
    "      --cloudflared-token <token> Cloudflare Tunnel connector token (stored in config)",
  );
  writeLine("      --directory <path>     Directory to expose");
  writeLine("      --scripts <scripts>    Comma-separated allowed package scripts");
  writeLine("      --command <commands>   Comma-separated allowed commands");
  writeLine("      --blacklist <commands> Comma-separated blocked command prefixes");
  writeLine("      --protect <paths>      Comma-separated extra paths agents may not edit (globs)");
  writeLine(
    "      --unprotect <paths>    Comma-separated paths that stay editable despite defaults",
  );
  writeLine("      --token <token>        Explicit Bearer token");
  writeLine("      --analytics            Expose local telemetry analytics through MCP (opt-in)");
  writeLine("      --no-tunnel            Disable tunneling");
  writeLine("      --random               Use a random Wormhole URL (no subdomain)");
  writeLine("  -h, --help                 Show this help");
  writeLine("  -v, --version              Show the installed version");
  writeLine("");
  writeLine("Telemetry:");
  writeLine("  agent-dir telemetry status");
  writeLine("  agent-dir telemetry enable <anonymous|basic|detailed|diagnostic>");
  writeLine("  agent-dir telemetry disable");
  writeLine("  agent-dir telemetry schema");
  writeLine("  agent-dir telemetry show [--follow]");
  writeLine("  agent-dir telemetry summary");
  writeLine("  agent-dir telemetry reset          Reset settings and clear all recorded data");
  writeLine("");
  writeLine("Config:");
  writeLine("  agent-dir config add <name> ...");
  writeLine("  agent-dir config list");
  writeLine("  agent-dir config show <name>");
  writeLine("  agent-dir config delete <name> [--yes]");
  writeLine("  agent-dir config delete --all [--yes]");
  writeLine("  agent-dir config remove <name>    Alias for delete");
  writeLine("  agent-dir config token <name> [--rotate]");
}

export function printBanner(options: {
  root: string;
  port: number;
  tunnel: string;
  profileName?: string;
  subdomain?: string;
  hostname?: string;
  token?: string;
  allowedScripts?: string[];
  packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  commands?: string[];
  blacklistedCommands?: string[];
  protectedPaths?: string[];
  codeGraph?: boolean;
  astGrep?: boolean;
  serena?: string[];
  analytics?: boolean;
}): void {
  writeLine("");
  writeLine(
    color(
      "  ╭──────────────────────────────────────────────────────────────────────────────╮",
      BRIGHT_CYAN,
    ),
  );
  writeLine(
    `${color("  │", BRIGHT_CYAN)}  ${color("AGENT", BRIGHT_CYAN)}${color("·", BRIGHT_MAGENTA)}${color("DIR", BRIGHT_BLUE)}  ${color("LOCAL PROJECT BRIDGE", BRIGHT_MAGENTA)}`,
  );
  writeLine(
    color(
      "  ╰──────────────────────────────────────────────────────────────────────────────╯",
      BRIGHT_CYAN,
    ),
  );
  writeLine(
    `  ${color("● SESSION", BRIGHT_GREEN)}  ${color(options.profileName ?? "CLI options", BRIGHT_CYAN)}  ${color("│", DIM)}  ${color(options.tunnel.toUpperCase(), BRIGHT_MAGENTA)}  ${color("│", DIM)}  ${color(`PORT ${options.port}`, BRIGHT_BLUE)}`,
  );
  writeLine(boxTop("PROJECT", BRIGHT_CYAN));
  writeLine(boxContent(`${color("DIR", DIM)}     ${options.root}`, BRIGHT_CYAN));
  if (options.subdomain)
    writeLine(
      boxContent(
        `${color("DOMAIN", DIM)}  ${color(`https://${options.subdomain}.wormhole.bar`, BRIGHT_GREEN)}`,
        BRIGHT_CYAN,
      ),
    );
  if (options.hostname)
    writeLine(
      boxContent(
        `${color("DOMAIN", DIM)}  ${color(`https://${options.hostname}`, BRIGHT_GREEN)}`,
        BRIGHT_CYAN,
      ),
    );
  if (options.blacklistedCommands?.length)
    writeLine(
      boxContent(
        `${color("BLOCKED", BRIGHT_YELLOW)}  ${options.blacklistedCommands.join(", ")}`,
        BRIGHT_CYAN,
      ),
    );
  writeLine(
    boxContent(
      `${color("PROTECT", BRIGHT_YELLOW)}  ${[".git", ".env*", ".npmrc", ...(options.protectedPaths ?? [])].join(", ")}`,
      BRIGHT_CYAN,
    ),
  );
  writeLine(boxBottom(BRIGHT_CYAN));
  writeLine("");
  writeLine(boxTop("MCP ENDPOINT", BRIGHT_MAGENTA));
  writeLine(
    boxContent(
      `${color("⚡ POST", BRIGHT_YELLOW)} ${color("/mcp", BRIGHT_CYAN)}  ${color("JSON-RPC · tools · resources", DIM)}`,
      BRIGHT_MAGENTA,
    ),
  );
  writeLine(boxBottom(BRIGHT_MAGENTA));
  writeLine("");
  writeLine(boxTop("AVAILABLE TOOLS", BRIGHT_BLUE));
  const toolRows = [
    color(toolLabel("project_context"), BRIGHT_CYAN),
    color(toolLabel("find_files"), CYAN),
    color(toolLabel("search_code"), BRIGHT_CYAN),
    color(toolLabel("find_symbol"), GREEN),
    color(toolLabel("find_references"), GREEN),
    color(toolLabel("read_range"), GREEN),
    color(toolLabel("apply_changes"), BRIGHT_MAGENTA),
    color(toolLabel("validate"), BRIGHT_YELLOW),
    color(toolLabel("run_package_scripts_batch"), BRIGHT_BLUE),
    color(toolLabel("run_command_batch"), BRIGHT_CYAN),
    color(toolLabel("file_info"), YELLOW),
  ];
  if (options.codeGraph) toolRows.push(color(toolLabel("codegraph_explore"), BRIGHT_MAGENTA));
  if (options.astGrep) toolRows.push(color(toolLabel("ast_grep_search"), BRIGHT_GREEN));
  for (const name of options.serena ?? [])
    toolRows.push(color(toolLabel(`serena_${name}`), BRIGHT_YELLOW));
  if (options.analytics) toolRows.push(color(toolLabel("telemetry_analytics"), BRIGHT_GREEN));
  printGrid(toolRows, 2);
  writeLine(boxBottom(BRIGHT_BLUE));
  writeLine("");
  if (options.allowedScripts?.length) {
    const packageManager = options.packageManager ?? "npm";
    writeLine(
      `  ${color(`◆ ${packageManager.toUpperCase()} SCRIPTS`, BRIGHT_YELLOW)}  ${color("· scripts are allowlisted", "\x1b[90m")}`,
    );
    printGrid(
      options.allowedScripts.map(
        (script) =>
          `${color("›", BRIGHT_YELLOW)} ${color(`${packageManager} run`, BRIGHT_YELLOW)} ${color(script, BRIGHT_CYAN)}`,
      ),
      2,
    );
    writeLine("");
  }
  if (options.commands?.length) {
    writeLine(
      `  ${color("◆ COMMAND ALLOWLIST", BRIGHT_GREEN)}  ${color("· shell access is restricted", "\x1b[90m")}`,
    );
    printGrid(
      options.commands.map((command) => `${color("›", BRIGHT_GREEN)} ${color(command, CYAN)}`),
      3,
    );
    writeLine("");
  }
}

const LOG_METHOD_WIDTH = 6;
const LOG_PATH_WIDTH = 4;
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
    `  ├─ ${color(method, methodCode)} ${color(path, methodCode)} ${color("·", DIM)} ${color(status, statusCode)} ${color("·", methodCode)}${detailLines[0] ? ` ${detailLines[0]}` : ""}`,
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
  writeLine(boxTop("REQUEST STREAM", BRIGHT_MAGENTA));
  writeLine(
    boxContent(color("Live MCP traffic · method · status · tool activity", DIM), BRIGHT_MAGENTA),
  );
  writeLine(boxBottom(BRIGHT_MAGENTA));
}
