import { createRequire } from "node:module";
import type { CodeGraphCapability } from "./codegraph.js";
import { CodeGraphIntegration } from "./codegraph.js";
import {
  findDefinition,
  findExports,
  findFiles,
  findImports,
  findReferences,
  findSymbol,
  searchCode,
  searchFiles,
} from "./tools/code.js";
import { runCommand } from "./tools/commands.js";
import { diagnostics } from "./tools/diagnostics.js";
import {
  applyFileChanges,
  deleteFile,
  listDirs,
  listFiles,
  patchFiles,
  readFile,
  readRange,
  writeFile,
} from "./tools/files.js";
import {
  gitCommit,
  gitDiff,
  gitLog,
  gitPush,
  gitRestore,
  gitStage,
  gitStatus,
  gitUnstage,
} from "./tools/git.js";
import { fileInfo, packageInfo, projectOverview } from "./tools/metadata.js";
import { runNpm } from "./tools/npm.js";
import {
  getSkill,
  listSkillResources,
  listSkills,
  readSkillDirectory,
  readSkillResource,
  skillResourceUrisForPath,
} from "./tools/skills.js";
import type { CommandConfig } from "./types.js";

const require = createRequire(import.meta.url);
const packageVersion = (require("../../package.json") as { version: string }).version;
const PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-11-25";
const SERVER_INFO = { name: "agent-dir", version: packageVersion };
const SERVER_INFO_META = { "io.modelcontextprotocol/serverInfo": SERVER_INFO };
const PROTOCOL_META = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities";
const PAGE_SIZE = 50;
const DEFAULT_OUTPUT_BYTES = 32_000;
const INSTRUCTIONS_URI = "agent-dir://instructions";
const CAPABILITIES_URI = "agent-dir://capabilities";
const SUBSCRIPTION_ID_META = "io.modelcontextprotocol/subscriptionId";

interface Subscription {
  id: string | number | null | undefined;
  controller: ReadableStreamDefaultController<Uint8Array>;
  notifications: {
    toolsListChanged: boolean;
    promptsListChanged: boolean;
    resourcesListChanged: boolean;
    resourceSubscriptions: Set<string>;
  };
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}
interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

const stringSchema = { type: "string" };
const pathSchema = { type: "string", description: "Path relative to the exposed project root." };
const objectOutput = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
});
const arrayOutput = (items: Record<string, unknown>): Record<string, unknown> => ({
  type: "array",
  items,
});
const fileEntrySchema = objectOutput(
  { path: stringSchema, type: { type: "string", enum: ["file", "directory"] } },
  ["path", "type"],
);
const searchMatchSchema = objectOutput(
  {
    path: stringSchema,
    line: { type: "integer" },
    column: { type: "integer" },
    text: stringSchema,
  },
  ["path", "line", "column", "text"],
);
const commandResultSchema = objectOutput(
  {
    command: stringSchema,
    exitCode: { type: "integer" },
    stdout: stringSchema,
    stderr: stringSchema,
  },
  ["command", "exitCode", "stdout", "stderr"],
);

const codeGraphTool: ToolDefinition = tool(
  "codegraph_explore",
  "Explore the current project through its optional CodeGraph MCP index. Returns CodeGraph native structured tool results for structural, flow, and symbol questions.",
  {
    query: { type: "string", minLength: 1 },
    maxFiles: { type: "integer", minimum: 1, maximum: 100 },
  },
  { type: "object" },
  ["query"],
);

const baseTools: ToolDefinition[] = [
  tool(
    "list_files",
    "List all visible project files and directories recursively up to the server's discovery depth. Prefer project_overview, find_files, search_code, or list_dirs for targeted discovery; use this only when broad recursive discovery is actually needed.",
    {
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    arrayOutput(fileEntrySchema),
  ),
  tool(
    "list_dirs",
    "List files and directories directly inside one or more project directories.",
    {
      paths: { type: "array", items: pathSchema, minItems: 1 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    arrayOutput(
      objectOutput({ path: stringSchema, entries: arrayOutput(fileEntrySchema) }, [
        "path",
        "entries",
      ]),
    ),
    ["paths"],
  ),
  tool(
    "read_range",
    "Read a bounded line range from one UTF-8 project file.",
    {
      path: pathSchema,
      startLine: { type: "integer", minimum: 1 },
      endLine: { type: "integer", minimum: 1 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    objectOutput(
      {
        path: stringSchema,
        startLine: { type: "integer" },
        endLine: { type: "integer" },
        content: stringSchema,
      },
      ["path", "startLine", "endLine", "content"],
    ),
    ["path", "startLine", "endLine"],
  ),
  tool(
    "read_files",
    "Read one or more UTF-8 project files in one call. Prefer read_range when only a bounded section is needed; batch related files here to reduce round trips.",
    {
      paths: { type: "array", items: pathSchema, minItems: 1 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    arrayOutput(objectOutput({ path: stringSchema, content: stringSchema }, ["path", "content"])),
    ["paths"],
  ),
  tool(
    "apply_changes",
    "Apply multiple file writes, exact patches, and deletes as one preflighted transaction. Use this for related multi-file edits when partial changes would be undesirable; supports dry-run previews.",
    {
      dryRun: { type: "boolean", default: false },
      changes: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["write", "patch", "delete"] },
            path: pathSchema,
            content: stringSchema,
            patches: {
              type: "array",
              items: objectOutput(
                {
                  search: stringSchema,
                  replace: stringSchema,
                  count: { type: "integer", minimum: 1 },
                },
                ["search", "replace"],
              ),
              minItems: 1,
            },
          },
          required: ["kind", "path"],
          additionalProperties: false,
        },
      },
    },
    arrayOutput(
      objectOutput(
        {
          kind: { type: "string", enum: ["write", "patch", "delete"] },
          path: stringSchema,
          changed: { type: "boolean" },
          dryRun: { type: "boolean" },
        },
        ["kind", "path", "changed"],
      ),
    ),
    ["changes"],
  ),
  tool(
    "write_files",
    "Create or completely replace one or more UTF-8 project files.",
    {
      dryRun: { type: "boolean", default: false },
      files: {
        type: "array",
        items: objectOutput({ path: pathSchema, content: stringSchema }, ["path", "content"]),
        minItems: 1,
      },
    },
    arrayOutput(
      objectOutput({ path: stringSchema, written: { type: "boolean" } }, ["path", "written"]),
    ),
    ["files"],
  ),
  tool(
    "patch_files",
    "Apply exact text replacements to one or more UTF-8 files. Prefer this for targeted edits instead of rewriting whole files; batch related patches in one call.",
    {
      dryRun: { type: "boolean", default: false },
      files: {
        type: "array",
        items: objectOutput(
          {
            path: pathSchema,
            patches: {
              type: "array",
              items: objectOutput(
                {
                  search: stringSchema,
                  replace: stringSchema,
                  count: { type: "integer", minimum: 1 },
                },
                ["search", "replace"],
              ),
              minItems: 1,
            },
          },
          ["path", "patches"],
        ),
        minItems: 1,
      },
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    arrayOutput(
      objectOutput({ path: stringSchema, applied: { type: "integer" }, content: stringSchema }, [
        "path",
        "applied",
        "content",
      ]),
    ),
    ["files"],
  ),
  tool(
    "delete_files",
    "Delete one or more project files.",
    {
      paths: { type: "array", items: pathSchema, minItems: 1 },
      dryRun: { type: "boolean", default: false },
    },
    arrayOutput(
      objectOutput({ path: stringSchema, deleted: { type: "boolean" } }, ["path", "deleted"]),
    ),
    ["paths"],
  ),
  tool(
    "search_files",
    "Search text across visible project files. Prefer this over broad file reads; use search_code for source-only searches and keep maxResults tight.",
    {
      query: stringSchema,
      regex: { type: "boolean", default: false },
      maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    arrayOutput(searchMatchSchema),
    ["query"],
  ),
  tool(
    "find_files",
    "Find project files by a simple glob pattern using * and ?. Prefer this over list_files when you know the filename pattern.",
    {
      pattern: stringSchema,
      maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    arrayOutput(stringSchema),
    ["pattern"],
  ),
  tool(
    "search_code",
    "Search source-like project files for text or a regular expression. Prefer this over reading files broadly; start with a narrow query and expand only if needed.",
    {
      query: stringSchema,
      regex: { type: "boolean", default: false },
      maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    arrayOutput(searchMatchSchema),
    ["query"],
  ),
  tool(
    "find_symbol",
    "Find likely symbol definitions across source files. Prefer this over reading whole modules when locating an implementation.",
    {
      symbol: stringSchema,
      maxResults: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    arrayOutput(
      objectOutput(
        {
          ...(searchMatchSchema.properties as Record<string, unknown>),
          symbol: stringSchema,
          kind: stringSchema,
        },
        ["path", "line", "column", "text", "symbol", "kind"],
      ),
    ),
    ["symbol"],
  ),
  tool(
    "find_definition",
    "Find likely definitions of a symbol. Use this before reading a large file when you need one implementation.",
    {
      symbol: stringSchema,
      maxResults: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    arrayOutput(
      objectOutput(
        {
          ...(searchMatchSchema.properties as Record<string, unknown>),
          symbol: stringSchema,
          kind: stringSchema,
        },
        ["path", "line", "column", "text", "symbol", "kind"],
      ),
    ),
    ["symbol"],
  ),
  tool(
    "find_references",
    "Find source-code references to a symbol. Use this instead of searching entire files when tracing usage of a known symbol.",
    {
      symbol: stringSchema,
      maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    arrayOutput(searchMatchSchema),
    ["symbol"],
  ),
  tool(
    "find_imports",
    "Find import and require statements in source files.",
    {
      maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    arrayOutput(
      objectOutput(
        {
          ...(searchMatchSchema.properties as Record<string, unknown>),
          module: stringSchema,
          kind: { type: "string", enum: ["import", "require"] },
        },
        ["path", "line", "column", "text", "module", "kind"],
      ),
    ),
  ),
  tool(
    "find_exports",
    "Find exported declarations in source files.",
    {
      maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    arrayOutput(
      objectOutput(
        {
          ...(searchMatchSchema.properties as Record<string, unknown>),
          symbol: stringSchema,
          kind: { type: "string", const: "export" },
        },
        ["path", "line", "column", "text", "symbol", "kind"],
      ),
    ),
  ),
  tool(
    "git_status",
    "Show Git working-tree status and branch information. Use this as the lightweight first Git check; do not run a full diff unless changes need inspection.",
    {
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    commandResultSchema,
  ),
  tool(
    "git_stage",
    "Stage one or more Git paths.",
    {
      paths: { type: "array", items: pathSchema, minItems: 1 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    commandResultSchema,
    ["paths"],
  ),
  tool(
    "git_unstage",
    "Unstage one or more Git paths without changing their working-tree contents.",
    {
      paths: { type: "array", items: pathSchema, minItems: 1 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    commandResultSchema,
    ["paths"],
  ),
  tool(
    "git_commit",
    "Create a Git commit with the currently staged changes.",
    {
      message: stringSchema,
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    commandResultSchema,
    ["message"],
  ),
  tool(
    "git_restore",
    "Restore one or more Git paths from the index, discarding unstaged working-tree changes.",
    {
      paths: { type: "array", items: pathSchema, minItems: 1 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    commandResultSchema,
    ["paths"],
  ),
  tool(
    "git_push",
    "Push the current Git branch to a remote.",
    {
      remote: stringSchema,
      branch: stringSchema,
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    commandResultSchema,
  ),
  tool(
    "git_diff",
    "Show a read-only Git diff, optionally staged or limited to a path. Prefer path-scoped or staged diffs over dumping the entire repository diff.",
    {
      staged: { type: "boolean", default: false },
      path: pathSchema,
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    commandResultSchema,
  ),
  tool(
    "git_log",
    "Show recent Git commits in a compact, read-only form. Keep the limit small and scope by path when history context is local.",
    {
      limit: { type: "integer", minimum: 1, maximum: 200, default: 20 },
      path: pathSchema,
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    commandResultSchema,
  ),
  tool(
    "locate",
    "Locate project code or files in one call. Use kind auto, code, text, or file.",
    {
      query: stringSchema,
      kind: { type: "string", enum: ["auto", "code", "text", "file"], default: "auto" },
      regex: { type: "boolean", default: false },
      maxResults: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    { type: "object", additionalProperties: true },
    ["query"],
  ),
  tool(
    "inspect_symbol",
    "Inspect a known symbol in one call, returning its definition, bounded source context, and optionally references.",
    {
      symbol: stringSchema,
      includeReferences: { type: "boolean", default: false },
      contextLines: { type: "integer", minimum: 0, maximum: 20, default: 3 },
      maxResults: { type: "integer", minimum: 1, maximum: 20, default: 5 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    { type: "object", additionalProperties: true },
    ["symbol"],
  ),
  tool(
    "inspect",
    "Inspect a project target in one call. Use kind auto, file, symbol, or code; returns bounded context and optional symbol references.",
    {
      target: stringSchema,
      kind: { type: "string", enum: ["auto", "file", "symbol", "code"], default: "auto" },
      includeReferences: { type: "boolean", default: false },
      contextLines: { type: "integer", minimum: 0, maximum: 20, default: 3 },
      maxResults: { type: "integer", minimum: 1, maximum: 20, default: 5 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    { type: "object", additionalProperties: true },
    ["target"],
  ),
  tool(
    "project_context",
    "Return a compact LLM-oriented project snapshot combining project overview, package metadata, and active execution policy. Prefer this over separate orientation calls.",
    {
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    { type: "object", additionalProperties: true },
  ),
  tool(
    "read_relevant",
    "Locate relevant source matches for a query and return bounded source context in one call. Prefer this when you know what you need but not the exact lines.",
    {
      query: stringSchema,
      regex: { type: "boolean", default: false },
      contextLines: { type: "integer", minimum: 0, maximum: 20, default: 3 },
      maxResults: { type: "integer", minimum: 1, maximum: 20, default: 5 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    { type: "object", additionalProperties: true },
    ["query"],
  ),
  tool(
    "validate",
    "Run a unified project validation pass: lightweight diagnostics first, then explicitly requested allowed npm scripts. Use diagnostics for cheap checks and scripts only when executable validation is needed.",
    {
      level: { type: "string", enum: ["diagnostics", "scripts", "full"], default: "diagnostics" },
      scripts: { type: "array", items: stringSchema, minItems: 1 },
      maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    { type: "object", additionalProperties: true },
  ),
  tool(
    "git_changes",
    "Return a compact Git working-tree snapshot combining status and an optional diff. Prefer this over separate git_status and git_diff calls when reviewing changes.",
    {
      includeDiff: { type: "boolean", default: false },
      path: pathSchema,
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    { type: "object", additionalProperties: true },
  ),
  tool(
    "project_overview",
    "Summarize project structure, languages, package managers, project metadata files, and Git state in one lightweight call. Prefer this before broad discovery.",
    {},
    objectOutput(
      {
        root: stringSchema,
        files: { type: "integer" },
        directories: { type: "integer" },
        languages: { type: "array" },
        packageManagers: { type: "array", items: stringSchema },
        projectFiles: { type: "array", items: stringSchema },
        git: { type: "object" },
      },
      ["root", "files", "directories", "languages", "packageManagers", "projectFiles", "git"],
    ),
  ),
  tool(
    "package_info",
    "Read normalized metadata from package.json when present.",
    {},
    { type: "object", additionalProperties: true },
  ),
  tool(
    "allowed_commands",
    "Show the npm scripts and commands explicitly allowed by the active server configuration.",
    {},
    objectOutput(
      {
        npmScripts: { type: "array", items: stringSchema },
        commands: { type: "array", items: stringSchema },
      },
      ["npmScripts", "commands"],
    ),
  ),
  tool(
    "file_info",
    "Return filesystem metadata for a project path.",
    { path: pathSchema },
    { type: "object", additionalProperties: true },
    ["path"],
  ),
  tool(
    "diagnostics",
    "Run lightweight project-independent diagnostics without invoking tests, linters, or typecheckers. Prefer this before expensive validation when checking basic file/JSON/conflict issues.",
    {
      maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    arrayOutput(
      objectOutput(
        {
          severity: { type: "string", enum: ["error", "warning", "info"] },
          code: stringSchema,
          path: stringSchema,
          line: { type: "integer" },
          message: stringSchema,
        },
        ["severity", "code", "message"],
      ),
    ),
  ),
  tool(
    "run_npm_batch",
    "Run one or more explicitly allowed npm scripts sequentially. Prefer the narrowest relevant script; batch independent scripts in one call and avoid running full check/test when a targeted check answers the question.",
    {
      scripts: { type: "array", items: stringSchema, minItems: 1 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    arrayOutput(commandResultSchema),
    ["scripts"],
  ),
  tool(
    "run_command_batch",
    "Run one or more explicitly allowed commands sequentially without a shell. Prefer dedicated Agent Dir tools over generic commands because they return structured, bounded results with less token overhead.",
    {
      commands: {
        type: "array",
        items: objectOutput(
          { command: stringSchema, args: { type: "array", items: stringSchema } },
          ["command"],
        ),
        minItems: 1,
      },
      maxBytes: { type: "integer", minimum: 1024, maximum: 1000000, default: DEFAULT_OUTPUT_BYTES },
    },
    arrayOutput(commandResultSchema),
    ["commands"],
  ),
];

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  outputSchema: Record<string, unknown>,
  required: string[] = [],
): ToolDefinition {
  return {
    name,
    title: name.replace(/_/g, " "),
    description,
    inputSchema: {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    },
    outputSchema,
  };
}

interface McpHandler {
  (request: Request): Promise<Response>;
  closeSubscriptions: () => void;
}

export function createMcpHandler(root: string, commandConfig: CommandConfig = {}): McpHandler {
  const codeGraph = new CodeGraphIntegration(root);
  const npmAllowed = commandConfig.npm?.allowedScripts ?? [];
  const allowedCommands = commandConfig.commands ?? [];
  const subscriptions = new Set<Subscription>();
  const notify = (event: { type: "tools" | "prompts" | "resources"; uri?: string }) => {
    for (const subscription of subscriptions) {
      const shouldNotify =
        event.type === "tools"
          ? subscription.notifications.toolsListChanged
          : event.type === "prompts"
            ? subscription.notifications.promptsListChanged
            : event.uri !== undefined
              ? subscription.notifications.resourceSubscriptions.has(event.uri)
              : subscription.notifications.resourcesListChanged;
      if (shouldNotify) {
        const method =
          event.type === "tools"
            ? "notifications/tools/list_changed"
            : event.type === "prompts"
              ? "notifications/prompts/list_changed"
              : event.uri !== undefined &&
                  subscription.notifications.resourceSubscriptions.has(event.uri)
                ? "notifications/resources/updated"
                : "notifications/resources/list_changed";
        const params = event.uri === undefined ? undefined : { uri: event.uri };
        writeSse(subscription.controller, {
          jsonrpc: "2.0",
          method,
          ...(params ? { params } : {}),
          _meta: { [SUBSCRIPTION_ID_META]: subscription.id },
        });
      }
    }
  };

  const handler = async (request: Request): Promise<Response> => {
    let message: JsonRpcRequest;
    try {
      message = (await request.json()) as JsonRpcRequest;
    } catch {
      return jsonRpcError(null, -32700, "Parse error", 400);
    }
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string")
      return jsonRpcError(message.id ?? null, -32600, "Invalid Request", 400);
    const hasId = Object.hasOwn(message, "id");
    if (hasId && !isValidRequestId(message.id))
      return jsonRpcError(null, -32600, "Invalid Request", 400);
    if (!hasId) return new Response(null, { status: 202 });
    if (message.params !== undefined && !isRecord(message.params))
      return jsonRpcError(message.id as string | number, -32602, "Invalid params.", 400);
    const params = message.params ?? {};
    const requestedProtocolVersion =
      typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
    const legacyInitialize = message.method === "initialize";
    const legacyRequest =
      !legacyInitialize &&
      request.headers.get("mcp-protocol-version") === LEGACY_PROTOCOL_VERSION &&
      !isRecord(params._meta);

    if (legacyInitialize) {
      const protocolHeader = request.headers.get("mcp-protocol-version");
      if (protocolHeader !== null && protocolHeader !== LEGACY_PROTOCOL_VERSION)
        return jsonRpcError(
          message.id ?? null,
          -32020,
          "MCP-Protocol-Version does not match the initialize protocol version.",
          400,
        );
      if (requestedProtocolVersion !== LEGACY_PROTOCOL_VERSION)
        return jsonRpcError(message.id ?? null, -32602, "Unsupported protocol version.", 400, {
          supported: [LEGACY_PROTOCOL_VERSION],
          requested: requestedProtocolVersion,
        });
      if (!isRecord(params.capabilities) || !isRecord(params.clientInfo))
        return jsonRpcError(message.id ?? null, -32602, "Invalid initialize params.", 400);
      return json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: LEGACY_PROTOCOL_VERSION,
          capabilities: capabilities(),
          serverInfo: SERVER_INFO,
          instructions: buildAgentInstructions(
            npmAllowed,
            allowedCommands,
            await codeGraph.capability(),
          ),
        },
      });
    }

    if (legacyRequest) {
      if (request.headers.get("mcp-protocol-version") !== LEGACY_PROTOCOL_VERSION)
        return jsonRpcError(
          message.id ?? null,
          -32020,
          "MCP-Protocol-Version must be 2025-11-25 for legacy requests.",
          400,
        );
    } else if (!isRecord(params._meta))
      return jsonRpcError(message.id ?? null, -32602, "Missing required request metadata.", 400);
    const meta = isRecord(params._meta) ? params._meta : {};
    const version = meta[PROTOCOL_META];
    if (!legacyRequest && typeof version !== "string")
      return jsonRpcError(
        message.id ?? null,
        -32602,
        "Missing required protocol version metadata.",
        400,
      );
    if (!legacyRequest && version !== PROTOCOL_VERSION)
      return jsonRpcError(message.id ?? null, -32022, "Unsupported protocol version.", 400, {
        supported: [PROTOCOL_VERSION],
        requested: version,
      });
    if (!legacyRequest && !isRecord(meta[CLIENT_CAPABILITIES_META]))
      return jsonRpcError(
        message.id ?? null,
        -32602,
        "Missing required client capabilities metadata.",
        400,
      );
    try {
      switch (message.method) {
        case "server/discover":
          return json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              resultType: "complete",
              supportedVersions: [PROTOCOL_VERSION],
              capabilities: capabilities(),
              _meta: SERVER_INFO_META,
              instructions: buildAgentInstructions(
                npmAllowed,
                allowedCommands,
                await codeGraph.capability(),
              ),
              codeGraph: await codeGraph.capability(),
              ttlMs: 0,
              cacheScope: "private",
            },
          });
        case "tools/list": {
          const page = paginate(await availableTools(codeGraph), params.cursor);
          return json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              resultType: "complete",
              tools: page.items,
              ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
              ttlMs: 0,
              cacheScope: "private",
              _meta: SERVER_INFO_META,
            },
          });
        }
        case "tools/call": {
          if (typeof params.name !== "string" || params.name.length === 0)
            return jsonRpcError(
              message.id ?? null,
              -32602,
              "tools/call name must be a non-empty string.",
              400,
            );
          const toolName = params.name;
          const toolDefinition = (await availableTools(codeGraph)).find(
            (item) => item.name === toolName,
          );
          if (!toolDefinition) throw new Error(`Unknown tool: ${toolName}`);
          if (params.arguments !== undefined && !isRecord(params.arguments))
            return jsonRpcError(
              message.id ?? null,
              -32602,
              "tools/call arguments must be an object.",
              400,
            );
          const argumentsValue = params.arguments ?? {};
          const headerError = validateMcpParamHeaders(
            toolDefinition.inputSchema,
            argumentsValue,
            request.headers,
          );
          if (headerError) return jsonRpcError(message.id ?? null, -32020, headerError, 400);
          return json({
            jsonrpc: "2.0",
            id: message.id,
            result: await callTool(
              toolName,
              argumentsValue,
              root,
              npmAllowed,
              allowedCommands,
              notify,
              request.signal,
              codeGraph,
            ),
          });
        }
        case "resources/list": {
          const resources = [
            {
              uri: INSTRUCTIONS_URI,
              name: "Agent Dir usage instructions",
              description:
                "Dynamically generated, efficiency-focused instructions for using this Agent Dir server.",
              mimeType: "text/markdown",
            },
            {
              uri: CAPABILITIES_URI,
              name: "Agent Dir capabilities",
              description:
                "Machine-readable current tools and execution policy for this Agent Dir server.",
              mimeType: "application/json",
            },
            ...(await listSkillResources(root)).map((item) => ({
              ...item,
              description: "Agent Skill resource",
            })),
          ];
          const page = paginate(resources, params.cursor);
          return json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              resultType: "complete",
              resources: page.items,
              ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
              ttlMs: 0,
              cacheScope: "private",
              _meta: SERVER_INFO_META,
            },
          });
        }
        case "resources/read": {
          if (typeof params.uri !== "string" || params.uri.length === 0)
            return jsonRpcError(
              message.id ?? null,
              -32602,
              "resources/read uri must be a non-empty string.",
              400,
            );
          if (params.uri === INSTRUCTIONS_URI)
            return json({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                resultType: "complete",
                contents: [
                  {
                    uri: INSTRUCTIONS_URI,
                    mimeType: "text/markdown",
                    text: buildAgentInstructions(
                      npmAllowed,
                      allowedCommands,
                      await codeGraph.capability(),
                    ),
                  },
                ],
                ttlMs: 0,
                cacheScope: "private",
                _meta: SERVER_INFO_META,
              },
            });
          if (params.uri === CAPABILITIES_URI)
            return json({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                resultType: "complete",
                contents: [
                  {
                    uri: CAPABILITIES_URI,
                    mimeType: "application/json",
                    text: JSON.stringify(
                      buildAgentCapabilities(npmAllowed, allowedCommands),
                      null,
                      2,
                    ),
                  },
                ],
                ttlMs: 0,
                cacheScope: "private",
                _meta: SERVER_INFO_META,
              },
            });
          const value = await readSkillResource(root, params.uri);
          return json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              resultType: "complete",
              contents: [value],
              ttlMs: 0,
              cacheScope: "private",
              _meta: SERVER_INFO_META,
            },
          });
        }
        case "resources/directory/read": {
          if (typeof params.uri !== "string" || params.uri.length === 0)
            return jsonRpcError(
              message.id ?? null,
              -32602,
              "resources/directory/read uri must be a non-empty string.",
              400,
            );
          const resources = await readSkillDirectory(root, params.uri);
          const page = paginate(resources, params.cursor);
          return json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              resultType: "complete",
              resources: page.items,
              ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
              ttlMs: 0,
              cacheScope: "private",
              _meta: SERVER_INFO_META,
            },
          });
        }
        case "skills/list": {
          const page = paginate(await listSkills(root), params.cursor);
          return json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              resultType: "complete",
              skills: page.items,
              ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
              ttlMs: 0,
              cacheScope: "private",
              _meta: SERVER_INFO_META,
            },
          });
        }
        case "subscriptions/listen": {
          const notifications = subscriptionNotifications(params.notifications);
          return subscriptionResponse(message.id, notifications, subscriptions);
        }
        case "skills/get":
          if (typeof params.uri !== "string" || params.uri.length === 0)
            return jsonRpcError(
              message.id ?? null,
              -32602,
              "skills/get uri must be a non-empty string.",
              400,
            );
          return json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              resultType: "complete",
              skill: await getSkill(root, params.uri),
              ttlMs: 0,
              cacheScope: "private",
              _meta: SERVER_INFO_META,
            },
          });
        default:
          return jsonRpcError(
            message.id ?? null,
            -32601,
            `Method not found: ${message.method}`,
            404,
          );
      }
    } catch (error) {
      if (message.method === "tools/call")
        return json(
          {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              resultType: "complete",
              isError: true,
              content: [
                { type: "text", text: error instanceof Error ? error.message : String(error) },
              ],
              structuredContent: { error: error instanceof Error ? error.message : String(error) },
              _meta: SERVER_INFO_META,
            },
          },
          200,
        );
      const code =
        message.method === "skills/get" ||
        message.method === "resources/read" ||
        message.method === "resources/directory/read" ||
        message.method === "subscriptions/listen" ||
        message.method === "skills/list"
          ? -32602
          : -32603;
      return jsonRpcError(
        message.id ?? null,
        code,
        error instanceof Error ? error.message : String(error),
        code === -32602 ? 400 : 500,
      );
    }
  };

  handler.closeSubscriptions = () => {
    for (const subscription of subscriptions) {
      writeSse(subscription.controller, {
        jsonrpc: "2.0",
        id: null,
        result: {
          resultType: "complete",
          _meta: {
            ...SERVER_INFO_META,
            [SUBSCRIPTION_ID_META]: subscription.id,
          },
        },
      });
      subscription.controller.close();
    }
    subscriptions.clear();
    void codeGraph.close();
  };

  return handler;
}

async function availableTools(codeGraph: CodeGraphIntegration): Promise<ToolDefinition[]> {
  const capability = await codeGraph.capability();
  return capability.status === "available" ||
    capability.status === "startup_failed" ||
    capability.status === "runtime_failed"
    ? [...baseTools, codeGraphTool]
    : baseTools;
}

function buildAgentInstructions(
  npmAllowed: string[],
  allowedCommands: string[],
  codeGraph: CodeGraphCapability,
): string {
  const npm = npmAllowed.length ? npmAllowed.map((item) => `- ${item}`).join("\n") : "- none";
  const commands = allowedCommands.length
    ? allowedCommands.map((item) => `- ${item}`).join("\n")
    : "- none";
  const codeGraphSection =
    codeGraph.status === "available" ||
    codeGraph.status === "startup_failed" ||
    codeGraph.status === "runtime_failed"
      ? "\n\n## CodeGraph\n- CodeGraph is an optional code-intelligence backend for this project.\n- Prefer `codegraph_explore` for structural, symbol, and code-flow questions when available.\n- Agent Dir pins CodeGraph to this project root; do not attempt to select another project.\n- Current status: " +
        codeGraph.status +
        (codeGraph.detail ? ` — ${codeGraph.detail}` : "") +
        "."
      : "";
  return `# Agent Dir operating instructions\n\nUse Agent Dir as the primary project interface. Optimize for correctness with the minimum necessary tool calls, filesystem reads, command output, and context.\n\n## Efficiency rules\n- Start with the narrowest operation that can answer the question. Do not dump the repository, large files, or full command output when a targeted operation is sufficient.\n- Prefer project_context for initial orientation; it combines project structure, package metadata, and execution policy in one call. Use project_overview when package metadata is unnecessary.\n- Prefer find_files for known filename patterns and list_dirs for one directory. Use list_files only when recursive discovery is genuinely required.\n- Prefer search_code/search_files before reading files. Search first, then read only the relevant ranges. Use read_relevant when one call can locate and return the needed source context.\n- Prefer find_symbol/find_definition/find_references for known symbols instead of scanning source files manually.\n- Prefer read_range for a bounded section. Use read_files to batch several already-identified files.\n- Prefer patch_files for targeted edits. Do not rewrite an entire file when a small exact replacement is sufficient.\n- Batch related reads, writes, patches, searches, and commands into one tool call when practical.\n- Keep maxResults and Git log limits small unless the initial result is insufficient.\n- Prefer dedicated Agent Dir tools over run_command_batch because dedicated tools return structured, bounded results.\n- Prefer diagnostics before expensive tests, linters, or typechecks when checking basic structural issues.\n- Run the narrowest relevant validation after a change; escalate only when required by the task or release workflow.\n- Before a broad Git diff, use git_status; then inspect only the relevant path or staged diff.\n- Never repeat a successful discovery/read just because another tool can provide the same information.\n\n## Preferred workflow\n1. Orient: project_overview.\n2. Locate: find_files/search_code/find_symbol/find_definition as appropriate.\n3. Read: read_range or batched read_files.\n4. Modify: patch_files for targeted changes; write_files for new/complete files.\n5. Validate: diagnostics first when applicable, then the narrowest relevant npm script.\n6. Review: git_status, then scoped git_diff when needed.\n\n## Execution policy\nAllowed npm scripts:\n${npm}\n\nAllowed executables:\n${commands}\n\nOnly use commands from the execution policy. Do not attempt to bypass it with shells or alternate executables.\n\n## Tool selection\n- Discovery: project_context > locate > project_overview > find_files/list_dirs > list_files.\n- Code location: inspect_symbol > find_definition/find_symbol > locate > search_code > broad file reads.\n- File reading: read_relevant > read_range > targeted read_files > broad recursive reads.\n- Editing: patch_files > write_files for complete files.\n- Validation: diagnostics > targeted npm script > full check/test.\n- Git inspection: git_changes > git_status > scoped git_diff > full repository diff.\n\nThe execution policy and this guidance are generated from the running Agent Dir configuration; do not maintain a separate client-specific copy.${codeGraphSection}`;
}

function buildAgentCapabilities(
  npmAllowed: string[],
  allowedCommands: string[],
): Record<string, unknown> {
  return {
    version: packageVersion,
    tools: baseTools.map((item) => item.name),
    resources: [INSTRUCTIONS_URI, CAPABILITIES_URI],
    execution: { npmScripts: [...npmAllowed], commands: [...allowedCommands] },
    efficiency: {
      preferred: {
        orientation: "project_context",
        focusedReading: "read_relevant",
        changeReview: "git_changes",
        discovery: ["find_files", "list_dirs", "search_code"],
        symbolNavigation: ["find_definition", "find_symbol", "find_references"],
        reading: ["read_range", "read_files"],
        editing: ["apply_changes", "patch_files", "write_files"],
        validation: ["validate", "diagnostics", "targeted npm script"],
        gitInspection: ["git_changes", "git_status", "git_diff", "git_log"],
      },
      avoid: [
        "recursive discovery when targeted search is enough",
        "whole-file reads when a line range is enough",
        "full-repository diffs when a path-scoped diff is enough",
        "expensive validation when a targeted check answers the question",
        "generic command execution when a dedicated Agent Dir tool exists",
      ],
    },
  };
}

function capabilities(): Record<string, unknown> {
  return {
    tools: { listChanged: true },
    resources: { listChanged: true, subscribe: true },
    extensions: { "io.modelcontextprotocol/skills": { directoryRead: true } },
  };
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  root: string,
  npmAllowed: string[],
  allowedCommands: string[],
  notify: (event: { type: "tools" | "prompts" | "resources"; uri?: string }) => void,
  signal?: AbortSignal,
  codeGraph?: CodeGraphIntegration,
): Promise<Record<string, unknown>> {
  let structuredContent: unknown;
  if (name === "codegraph_explore") {
    if (!codeGraph) throw new Error("CodeGraph integration is unavailable.");
    if (typeof args.query !== "string" || args.query.trim().length === 0)
      throw new Error("query must be a non-empty string.");
    if (
      args.maxFiles !== undefined &&
      (!Number.isInteger(args.maxFiles) || Number(args.maxFiles) < 1 || Number(args.maxFiles) > 100)
    )
      throw new Error("maxFiles must be an integer between 1 and 100.");
    return await codeGraph.explore(
      args.query,
      args.maxFiles === undefined ? undefined : Number(args.maxFiles),
    );
  }
  switch (name) {
    case "list_files": {
      const items = await listFiles(root);
      structuredContent = boundedItems(items, outputBytesArg(args.maxBytes)).items;
      break;
    }
    case "list_dirs": {
      const items = await listDirs(root, stringArray(args.paths, "paths"));
      structuredContent = boundedItems(items, outputBytesArg(args.maxBytes)).items;
      break;
    }
    case "read_range": {
      const result = await readRange(
        root,
        String(args.path),
        Number(args.startLine),
        Number(args.endLine),
      );
      const bounded = truncateText(result.content, outputBytesArg(args.maxBytes));
      structuredContent = { ...result, content: bounded.text };
      break;
    }
    case "read_files": {
      const maxBytes = outputBytesArg(args.maxBytes);
      let remaining = maxBytes;
      const output = [];
      for (const p of stringArray(args.paths, "paths")) {
        const content = await readFile(root, p);
        const bounded = truncateText(content, remaining);
        output.push({ path: p, content: bounded.text });
        remaining -= Buffer.byteLength(bounded.text, "utf8");
        if (bounded.truncated || remaining <= 0) break;
      }
      structuredContent = output;
      break;
    }
    case "apply_changes": {
      const changes = objectArray(args.changes, "changes").map((change) => {
        const kind = String(change.kind);
        if (kind !== "write" && kind !== "patch" && kind !== "delete")
          throw new Error("Change kind must be write, patch, or delete.");
        if (kind === "write" && typeof change.content !== "string")
          throw new Error("write changes require content.");
        if (kind === "patch" && !Array.isArray(change.patches))
          throw new Error("patch changes require patches.");
        return {
          kind,
          path: String(change.path),
          ...(kind === "write" ? { content: String(change.content) } : {}),
          ...(kind === "patch"
            ? {
                patches: objectArray(change.patches, "patches").map((patch) => ({
                  search: String(patch.search),
                  replace: String(patch.replace),
                  ...(patch.count === undefined ? {} : { count: Number(patch.count) }),
                })),
              }
            : {}),
        } as
          | { kind: "write"; path: string; content: string }
          | {
              kind: "patch";
              path: string;
              patches: Array<{ search: string; replace: string; count?: number }>;
            }
          | { kind: "delete"; path: string };
      });
      const dryRun = args.dryRun === true;
      const affected = [...new Set(changes.map((change) => change.path))];
      const before = new Map<string, string[]>();
      for (const p of affected) before.set(p, await skillResourceUrisForPath(root, p));
      structuredContent = await applyFileChanges(root, changes, dryRun);
      if (!dryRun)
        for (const p of affected) await notifyResourceChange(notify, root, p, before.get(p) ?? []);
      break;
    }
    case "write_files": {
      const dryRun = args.dryRun === true;
      const output: Array<{ path: string; written: boolean; dryRun?: boolean }> = [];
      for (const file of objectArray(args.files, "files")) {
        const p = String(file.path);
        const before = await skillResourceUrisForPath(root, p);
        if (!dryRun) {
          await writeFile(root, p, String(file.content));
          await notifyResourceChange(notify, root, p, before);
        }
        output.push({ path: p, written: true, ...(dryRun ? { dryRun: true } : {}) });
      }
      structuredContent = output;
      break;
    }
    case "patch_files": {
      const dryRun = args.dryRun === true;
      const files = objectArray(args.files, "files").map((file) => ({
        path: String(file.path),
        patches: objectArray(file.patches, "patches").map((p) => ({
          search: String(p.search),
          replace: String(p.replace),
          ...(p.count === undefined ? {} : { count: Number(p.count) }),
        })),
      }));
      const before = new Map<string, string[]>();
      for (const file of files)
        before.set(file.path, await skillResourceUrisForPath(root, file.path));
      if (dryRun) {
        structuredContent = await patchFilesDryRun(root, files);
      } else {
        structuredContent = await patchFiles(root, files);
      }
      const maxBytes = outputBytesArg(args.maxBytes);
      if (Array.isArray(structuredContent)) {
        structuredContent = boundedItems(
          structuredContent.map((item) => {
            if (!isRecord(item) || typeof item.content !== "string") return item;
            return { ...item, content: truncateText(item.content, maxBytes).text };
          }),
          maxBytes,
        ).items;
      }
      if (!dryRun) {
        for (const file of files)
          await notifyResourceChange(notify, root, file.path, before.get(file.path) ?? []);
      }
      break;
    }
    case "delete_files": {
      const dryRun = args.dryRun === true;
      const output: Array<{ path: string; deleted: boolean; dryRun?: boolean }> = [];
      for (const p of stringArray(args.paths, "paths")) {
        const before = await skillResourceUrisForPath(root, p);
        if (!dryRun) {
          await deleteFile(root, p);
          await notifyResourceChange(notify, root, p, before);
        }
        output.push({ path: p, deleted: true, ...(dryRun ? { dryRun: true } : {}) });
      }
      structuredContent = output;
      break;
    }
    case "search_files":
      structuredContent = await searchFiles(
        root,
        String(args.query),
        Boolean(args.regex),
        numberArg(args.maxResults, 200, 1000),
        outputBytesArg(args.maxBytes),
      );
      break;
    case "find_files":
      structuredContent = boundedItems(
        await findFiles(root, String(args.pattern), numberArg(args.maxResults, 200, 1000)),
        outputBytesArg(args.maxBytes),
      ).items;
      break;
    case "search_code":
      structuredContent = await searchCode(
        root,
        String(args.query),
        Boolean(args.regex),
        numberArg(args.maxResults, 200, 1000),
        outputBytesArg(args.maxBytes),
      );
      break;
    case "find_symbol":
      structuredContent = await findSymbol(
        root,
        String(args.symbol),
        numberArg(args.maxResults, 100, 500),
        outputBytesArg(args.maxBytes),
      );
      break;
    case "find_definition":
      structuredContent = await findDefinition(
        root,
        String(args.symbol),
        numberArg(args.maxResults, 100, 500),
        outputBytesArg(args.maxBytes),
      );
      break;
    case "find_references":
      structuredContent = await findReferences(
        root,
        String(args.symbol),
        numberArg(args.maxResults, 200, 1000),
        outputBytesArg(args.maxBytes),
      );
      break;
    case "find_imports":
      structuredContent = await findImports(
        root,
        numberArg(args.maxResults, 200, 1000),
        outputBytesArg(args.maxBytes),
      );
      break;
    case "find_exports":
      structuredContent = await findExports(
        root,
        numberArg(args.maxResults, 200, 1000),
        outputBytesArg(args.maxBytes),
      );
      break;
    case "git_status":
      structuredContent = boundCommandResult(await gitStatus(root), outputBytesArg(args.maxBytes));
      break;
    case "git_stage":
      structuredContent = boundCommandResult(
        await gitStage(root, stringArray(args.paths, "paths")),
        outputBytesArg(args.maxBytes),
      );
      break;
    case "git_unstage":
      structuredContent = boundCommandResult(
        await gitUnstage(root, stringArray(args.paths, "paths")),
        outputBytesArg(args.maxBytes),
      );
      break;
    case "git_commit":
      structuredContent = boundCommandResult(
        await gitCommit(root, String(args.message)),
        outputBytesArg(args.maxBytes),
      );
      break;
    case "git_restore":
      structuredContent = boundCommandResult(
        await gitRestore(root, stringArray(args.paths, "paths")),
        outputBytesArg(args.maxBytes),
      );
      break;
    case "git_push":
      structuredContent = boundCommandResult(
        await gitPush(
          root,
          args.remote === undefined ? undefined : String(args.remote),
          args.branch === undefined ? undefined : String(args.branch),
        ),
        outputBytesArg(args.maxBytes),
      );
      break;
    case "git_diff":
      structuredContent = boundCommandResult(
        await gitDiff(
          root,
          Boolean(args.staged),
          args.path === undefined ? undefined : String(args.path),
        ),
        outputBytesArg(args.maxBytes),
      );
      break;
    case "git_log":
      structuredContent = boundCommandResult(
        await gitLog(
          root,
          numberArg(args.limit, 20, 200),
          args.path === undefined ? undefined : String(args.path),
        ),
        outputBytesArg(args.maxBytes),
      );
      break;
    case "locate": {
      const query = String(args.query);
      const kind = typeof args.kind === "string" ? args.kind : "auto";
      const regex = args.regex === true;
      const maxResults = numberArg(args.maxResults, 20, 100);
      const resolvedKind =
        kind === "auto"
          ? /[*?]/.test(query)
            ? "file"
            : /\.(ts|tsx|js|jsx|py|go|rs|java|json|md|yml|yaml|css|html)$/.test(query)
              ? "file"
              : "code"
          : kind;
      const items =
        resolvedKind === "file"
          ? await findFiles(root, query, maxResults)
          : resolvedKind === "text"
            ? await searchFiles(root, query, regex, maxResults)
            : await searchCode(root, query, regex, maxResults);
      const bounded = boundedItems(items as unknown[], outputBytesArg(args.maxBytes));
      structuredContent = {
        query,
        kind: resolvedKind,
        items: bounded.items,
        count: bounded.items.length,
        truncated: bounded.truncated || items.length >= maxResults,
      };
      break;
    }
    case "inspect_symbol": {
      const symbol = String(args.symbol);
      const contextLines = args.contextLines === undefined ? 3 : Number(args.contextLines);
      if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > 20)
        throw new Error("contextLines must be an integer between 0 and 20.");
      const maxResults = numberArg(args.maxResults, 5, 20);
      const maxBytes = outputBytesArg(args.maxBytes);
      const definitions = await findDefinition(root, symbol, maxResults, maxBytes);
      const definitionContext = await Promise.all(
        definitions.map(async (definition) => {
          const range = await readRange(
            root,
            definition.path,
            Math.max(1, definition.line - contextLines),
            definition.line + contextLines,
          );
          return { ...definition, context: range.content };
        }),
      );
      const references =
        args.includeReferences === true
          ? await findReferences(root, symbol, maxResults, maxBytes)
          : undefined;
      const result = {
        symbol,
        definitions: definitionContext,
        ...(references ? { references } : {}),
      };
      const bounded = truncateText(JSON.stringify(result), maxBytes);
      structuredContent = bounded.truncated
        ? { symbol, result: bounded.text, truncated: true }
        : result;
      break;
    }
    case "inspect": {
      const target = String(args.target);
      const requestedKind = typeof args.kind === "string" ? args.kind : "auto";
      const contextLines = args.contextLines === undefined ? 3 : Number(args.contextLines);
      if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > 20)
        throw new Error("contextLines must be an integer between 0 and 20.");
      const maxResults = numberArg(args.maxResults, 5, 20);
      const maxBytes = outputBytesArg(args.maxBytes);
      let kind = requestedKind;
      if (kind === "auto") {
        try {
          await readFile(root, target);
          kind = "file";
        } catch {
          kind = /[*?]/.test(target) ? "code" : "symbol";
        }
      }

      if (kind === "file") {
        const content = await readFile(root, target);
        const boundedContent = truncateText(content, Math.max(1, maxBytes - 128));
        const result = {
          target,
          kind,
          path: target,
          content: boundedContent.text,
          truncated: boundedContent.truncated,
        };
        structuredContent = result;
        break;
      }

      if (kind === "symbol") {
        const definitions = await findDefinition(root, target, maxResults, maxBytes);
        const definitionsWithContext = await Promise.all(
          definitions.map(async (definition) => {
            const range = await readRange(
              root,
              definition.path,
              Math.max(1, definition.line - contextLines),
              definition.line + contextLines,
            );
            return { ...definition, context: range.content };
          }),
        );
        const references =
          args.includeReferences === true
            ? await findReferences(root, target, maxResults, maxBytes)
            : undefined;
        const result = {
          target,
          kind,
          definitions: definitionsWithContext,
          ...(references ? { references } : {}),
        };
        const bounded = truncateText(JSON.stringify(result), maxBytes);
        structuredContent = bounded.truncated
          ? { target, kind, result: bounded.text, truncated: true }
          : result;
        break;
      }

      const matches = await searchCode(root, target, false, maxResults, maxBytes);
      const relevant = await Promise.all(
        matches.map(async (match) => {
          const range = await readRange(
            root,
            match.path,
            Math.max(1, match.line - contextLines),
            match.line + contextLines,
          );
          return {
            ...match,
            context: range.content,
            startLine: range.startLine,
            endLine: range.endLine,
          };
        }),
      );
      const bounded = boundedItems(relevant, maxBytes);
      structuredContent = {
        target,
        kind: "code",
        matches: bounded.items,
        count: bounded.items.length,
        truncated: bounded.truncated || relevant.length >= maxResults,
      };
      break;
    }
    case "project_context": {
      const overview = await projectOverview(root);
      let pkg: Record<string, unknown> = { path: "package.json", exists: false };
      try {
        const packageJson = JSON.parse(await readFile(root, "package.json")) as Record<
          string,
          unknown
        >;
        pkg = {
          path: "package.json",
          name: packageJson.name ?? null,
          version: packageJson.version ?? null,
          description: packageJson.description ?? null,
          packageManager: packageJson.packageManager ?? null,
          scripts: packageJson.scripts ?? {},
        };
      } catch {
        // Package metadata is optional; project context remains useful without it.
      }
      const maxBytes = outputBytesArg(args.maxBytes);
      const bounded = truncateText(
        JSON.stringify({
          ...overview,
          package: pkg,
          execution: { npmScripts: [...npmAllowed], commands: [...allowedCommands] },
        }),
        maxBytes,
      );
      structuredContent = bounded.truncated
        ? { result: bounded.text, truncated: true }
        : JSON.parse(bounded.text);
      break;
    }
    case "read_relevant": {
      const query = String(args.query);
      const contextLines = args.contextLines === undefined ? 3 : Number(args.contextLines);
      if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > 20)
        throw new Error("contextLines must be an integer between 0 and 20.");
      const maxResults = numberArg(args.maxResults, 5, 20);
      const matches = await searchCode(
        root,
        query,
        Boolean(args.regex),
        maxResults,
        outputBytesArg(args.maxBytes),
      );
      const relevant = await Promise.all(
        matches.map(async (match) => {
          const range = await readRange(
            root,
            match.path,
            Math.max(1, match.line - contextLines),
            match.line + contextLines,
          );
          return {
            ...match,
            context: range.content,
            startLine: range.startLine,
            endLine: range.endLine,
          };
        }),
      );
      const maxBytes = outputBytesArg(args.maxBytes);
      const bounded = boundedItems(relevant, Math.max(1, maxBytes - 128));
      const result = {
        query,
        matches: bounded.items,
        count: relevant.length,
        truncated: bounded.truncated || relevant.length >= maxResults,
      };
      structuredContent = result;
      break;
    }
    case "validate": {
      const level = typeof args.level === "string" ? args.level : "diagnostics";
      const maxResults = numberArg(args.maxResults, 200, 1000);
      const maxBytes = outputBytesArg(args.maxBytes);
      const diagnosticItems = await diagnostics(root, maxResults);
      const scripts =
        level === "diagnostics"
          ? []
          : args.scripts !== undefined
            ? stringArray(args.scripts, "scripts")
            : level === "full"
              ? ["check", "test"].filter((script) => npmAllowed.includes(script))
              : [];
      const checks: Array<Record<string, unknown>> = [
        {
          kind: "diagnostics",
          ok: !diagnosticItems.some((item) => item.severity === "error"),
          count: diagnosticItems.length,
          issues: boundedItems(diagnosticItems, maxBytes).items,
        },
      ];
      for (const script of scripts) {
        const result = await runNpm(root, script, 120000, npmAllowed, signal);
        checks.push({
          kind: "npm",
          script,
          ok: result.exitCode === 0,
          result,
        });
        if (result.exitCode !== 0) break;
      }
      structuredContent = {
        level,
        ok: checks.every((check) => check.ok === true),
        checks,
        scriptsRequested: scripts,
      };
      break;
    }
    case "git_changes": {
      const status = await gitStatus(root);
      const includeDiff = Boolean(args.includeDiff);
      const path = args.path === undefined ? undefined : String(args.path);
      const maxBytes = outputBytesArg(args.maxBytes);
      const diff = includeDiff ? await gitDiff(root, false, path) : undefined;
      const statusBytes = Buffer.byteLength(JSON.stringify(status), "utf8");
      const diffBudget = Math.max(0, maxBytes - statusBytes - 64);
      const boundedDiff = diff ? truncateText(diff.stdout, diffBudget) : undefined;
      const result = {
        status,
        ...(diff
          ? {
              diff: {
                ...diff,
                stdout: boundedDiff?.text ?? "",
                truncated: boundedDiff?.truncated ?? false,
              },
            }
          : {}),
      };
      structuredContent = result;
      break;
    }
    case "project_overview":
      structuredContent = await projectOverview(root);
      break;
    case "package_info":
      structuredContent = await packageInfo(root);
      break;
    case "allowed_commands":
      structuredContent = {
        npmScripts: [...npmAllowed],
        commands: [...allowedCommands],
      };
      break;
    case "file_info":
      structuredContent = await fileInfo(root, String(args.path));
      break;
    case "diagnostics":
      structuredContent = boundedItems(
        await diagnostics(root, numberArg(args.maxResults, 200, 1000)),
        outputBytesArg(args.maxBytes),
      ).items;
      break;
    case "run_npm_batch": {
      const output = [];
      for (const script of stringArray(args.scripts, "scripts")) {
        const value = await runNpm(root, script, 120000, npmAllowed, signal);
        output.push(value);
        if (value.exitCode !== 0) break;
      }
      const maxBytes = outputBytesArg(args.maxBytes);
      const boundedOutput = [];
      let remaining = maxBytes - 2;
      for (const item of output) {
        const separatorBytes = boundedOutput.length ? 1 : 0;
        if (remaining <= separatorBytes) break;
        const budget = remaining - separatorBytes;
        const bounded = boundCommandResult(item, budget);
        const boundedBytes = Buffer.byteLength(JSON.stringify(bounded), "utf8");
        if (boundedBytes > budget) break;
        boundedOutput.push(bounded);
        remaining -= separatorBytes + boundedBytes;
        if (remaining <= 0) break;
      }
      structuredContent = boundedOutput;
      break;
    }
    case "run_command_batch": {
      const output = [];
      for (const item of objectArray(args.commands, "commands")) {
        const value = await runCommand(
          root,
          String(item.command),
          Array.isArray(item.args) ? item.args.map(String) : [],
          allowedCommands,
          120000,
          signal,
        );
        output.push(value);
        if (value.exitCode !== 0) break;
      }
      const maxBytes = outputBytesArg(args.maxBytes);
      const boundedOutput = [];
      let remaining = maxBytes - 2;
      for (const item of output) {
        const separatorBytes = boundedOutput.length ? 1 : 0;
        if (remaining <= separatorBytes) break;
        const budget = remaining - separatorBytes;
        const bounded = boundCommandResult(item, budget);
        const boundedBytes = Buffer.byteLength(JSON.stringify(bounded), "utf8");
        if (boundedBytes > budget) break;
        boundedOutput.push(bounded);
        remaining -= separatorBytes + boundedBytes;
        if (remaining <= 0) break;
      }
      structuredContent = boundedOutput;
      break;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
  return completeToolResult(structuredContent);
}

const MCP_PARAM_PREFIX = "Mcp-Param-";
const X_MCP_HEADER = "x-mcp-header";

export function validateMcpParamHeaders(
  inputSchema: Record<string, unknown>,
  args: Record<string, unknown>,
  headers: Headers,
): string | undefined {
  const annotations = collectMcpHeaderAnnotations(inputSchema);
  for (const annotation of annotations) {
    const value = valueAtPath(args, annotation.path);
    const headerName = `${MCP_PARAM_PREFIX}${annotation.headerName}`;
    const headerValue = headers.get(headerName);

    if (value === undefined || value === null) {
      if (headerValue !== null)
        return `${headerName} must be absent when the annotated argument is absent.`;
      continue;
    }

    const rendered = renderMcpHeaderValue(value);
    if (rendered === undefined)
      return `${headerName} can only mirror string, integer, or boolean arguments.`;
    if (headerValue === null) return `${headerName} is required for the annotated argument.`;

    const decoded = decodeMcpHeaderValue(headerValue);
    if (decoded === undefined || !mcpHeaderValuesEqual(annotation.type, rendered, decoded))
      return `${headerName} does not match the annotated argument.`;
  }
  return undefined;
}

interface McpHeaderAnnotation {
  path: string[];
  headerName: string;
  type: "string" | "integer" | "boolean";
}

function collectMcpHeaderAnnotations(schema: Record<string, unknown>): McpHeaderAnnotation[] {
  const result: McpHeaderAnnotation[] = [];
  const visit = (node: unknown, path: string[]) => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return;
    const record = node as Record<string, unknown>;
    const properties = record.properties;
    if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return;

    for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
      if (typeof child !== "object" || child === null || Array.isArray(child)) continue;
      const property = child as Record<string, unknown>;
      if (property[X_MCP_HEADER] !== undefined) {
        const headerName = property[X_MCP_HEADER];
        if (
          typeof headerName !== "string" ||
          !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName) ||
          !headerName
        ) {
          throw new Error(
            `Invalid x-mcp-header annotation for property ${[...path, name].join(".")}.`,
          );
        }
        if (
          property.type !== "string" &&
          property.type !== "integer" &&
          property.type !== "boolean"
        )
          throw new Error(`Invalid x-mcp-header type for property ${[...path, name].join(".")}.`);
        if (result.some((item) => item.headerName.toLowerCase() === headerName.toLowerCase()))
          throw new Error(`Duplicate x-mcp-header annotation: ${headerName}.`);
        result.push({
          path: [...path, name],
          headerName,
          type: property.type as "string" | "integer" | "boolean",
        });
      }
      visit(property, [...path, name]);
    }
  };
  visit(schema, []);
  return result;
}

function valueAtPath(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function renderMcpHeaderValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  return undefined;
}

function decodeMcpHeaderValue(value: string): string | undefined {
  const prefix = "=?base64?";
  const suffix = "?=";
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return value;
  try {
    const encoded = value.slice(prefix.length, -suffix.length);
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64") !== encoded) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

function mcpHeaderValuesEqual(
  type: McpHeaderAnnotation["type"],
  bodyValue: string,
  headerValue: string,
): boolean {
  if (type === "integer")
    return Number.isSafeInteger(Number(headerValue)) && Number(headerValue) === Number(bodyValue);
  return bodyValue === headerValue;
}

function completeToolResult(structuredContent: unknown): Record<string, unknown> {
  return {
    resultType: "complete",
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    _meta: SERVER_INFO_META,
  };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isValidRequestId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}
function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`${name} must be an array of strings.`);
  return value;
}
function objectArray(value: unknown, name: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "object" || item === null))
    throw new Error(`${name} must be an array of objects.`);
  return value as Record<string, unknown>[];
}
function outputBytesArg(value: unknown): number {
  const result = value === undefined ? DEFAULT_OUTPUT_BYTES : Number(value);
  if (!Number.isInteger(result) || result < 1024 || result > 1_000_000)
    throw new Error("maxBytes must be an integer between 1024 and 1000000.");
  return result;
}

function truncateText(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
  if (maxBytes <= 32) return { text: "", truncated: true };
  const buffer = Buffer.from(value, "utf8");
  return {
    text: `${buffer.subarray(0, Math.max(0, maxBytes - 32)).toString("utf8")}\n…[truncated]`,
    truncated: true,
  };
}

function boundCommandResult(value: unknown, maxBytes: number): unknown {
  if (!isRecord(value)) return value;
  const command = typeof value.command === "string" ? value.command : "";
  const stdout = typeof value.stdout === "string" ? value.stdout : "";
  const stderr = typeof value.stderr === "string" ? value.stderr : "";
  let commandBudget = Buffer.byteLength(command, "utf8");
  let stdoutBudget = Buffer.byteLength(stdout, "utf8");
  let stderrBudget = Buffer.byteLength(stderr, "utf8");
  const candidate = () => ({
    ...value,
    command: truncateText(command, commandBudget).text,
    stdout: truncateText(stdout, stdoutBudget).text,
    stderr: truncateText(stderr, stderrBudget).text,
  });
  let result = candidate();
  while (
    Buffer.byteLength(JSON.stringify(result), "utf8") > maxBytes &&
    (commandBudget > 0 || stdoutBudget > 0 || stderrBudget > 0)
  ) {
    const excess = Buffer.byteLength(JSON.stringify(result), "utf8") - maxBytes;
    if (stdoutBudget >= stderrBudget && stdoutBudget > 0)
      stdoutBudget = Math.max(0, stdoutBudget - excess);
    else if (stderrBudget > 0) stderrBudget = Math.max(0, stderrBudget - excess);
    else commandBudget = Math.max(0, commandBudget - excess);
    result = candidate();
  }
  if (Buffer.byteLength(JSON.stringify(result), "utf8") <= maxBytes) return result;
  return { ...value, command: truncateText(command, commandBudget).text, stdout: "", stderr: "" };
}

function boundedItems<T>(items: T[], maxBytes: number): { items: T[]; truncated: boolean } {
  const selected: T[] = [];
  let bytes = 2;
  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    const separatorBytes = selected.length ? 1 : 0;
    if (selected.length && bytes + separatorBytes + itemBytes > maxBytes) break;
    if (!selected.length && bytes + itemBytes > maxBytes) break;
    selected.push(item);
    bytes += separatorBytes + itemBytes;
  }
  return { items: selected, truncated: selected.length < items.length };
}

function numberArg(value: unknown, fallback: number, max: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < 1 || result > max)
    throw new Error(`Value must be an integer between 1 and ${max}.`);
  return result;
}
function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  status: number,
  data?: unknown,
): Response {
  return json(
    { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } },
    status,
  );
}
function paginate<T>(items: T[], cursorValue: unknown): { items: T[]; nextCursor?: string } {
  const offset = decodeCursor(cursorValue);
  const page = items.slice(offset, offset + PAGE_SIZE);
  const nextOffset = offset + page.length;
  return nextOffset < items.length
    ? { items: page, nextCursor: encodeCursor(nextOffset) }
    : { items: page };
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function decodeCursor(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "string" || value.length > 128)
    throw new Error("Invalid pagination cursor.");
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64url").toString("utf8");
  } catch {
    throw new Error("Invalid pagination cursor.");
  }
  if (!/^(?:0|[1-9]\d*)$/.test(decoded)) throw new Error("Invalid pagination cursor.");
  const offset = Number(decoded);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid pagination cursor.");
  return offset;
}

async function patchFilesDryRun(
  root: string,
  files: Array<{
    path: string;
    patches: Array<{ search: string; replace: string; count?: number }>;
  }>,
): Promise<Array<{ path: string; applied: number; content: string; dryRun: true }>> {
  return Promise.all(
    files.map(async ({ path: relativePath, patches }) => {
      let content = await readFile(root, relativePath);
      for (const patch of patches) {
        if (!patch.search) throw new Error("Patch search text cannot be empty.");
        const occurrences = content.split(patch.search).length - 1;
        const count = patch.count ?? 1;
        if (occurrences === 0) throw new Error(`Patch text was not found in '${relativePath}'.`);
        if (!Number.isInteger(count) || count < 1)
          throw new Error("Patch count must be a positive integer.");
        if (occurrences < count)
          throw new Error(
            `Patch text occurs ${occurrences} time(s), but ${count} replacement(s) were requested.`,
          );
        let offset = 0;
        for (let index = 0; index < count; index += 1) {
          const position = content.indexOf(patch.search, offset);
          content =
            content.slice(0, position) +
            patch.replace +
            content.slice(position + patch.search.length);
          offset = position + patch.replace.length;
        }
      }
      return { path: relativePath, applied: patches.length, content, dryRun: true as const };
    }),
  );
}

async function notifyResourceChange(
  notify: (event: { type: "tools" | "prompts" | "resources"; uri?: string }) => void,
  root: string,
  pathValue: string,
  before: string[],
): Promise<void> {
  const after = await skillResourceUrisForPath(root, pathValue);
  if (before.length === 0 && after.length === 0) return;

  if (before.length === 0 || after.length === 0) {
    notify({ type: "resources" });
    return;
  }

  for (const uri of after) notify({ type: "resources", uri });
}

function subscriptionNotifications(value: unknown): Subscription["notifications"] {
  if (!isRecord(value)) throw new Error("subscriptions/listen notifications are required.");
  for (const key of ["toolsListChanged", "promptsListChanged", "resourcesListChanged"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean")
      throw new Error(`subscriptions/listen ${key} must be a boolean.`);
  }
  if (
    value.resourceSubscriptions !== undefined &&
    (!Array.isArray(value.resourceSubscriptions) ||
      value.resourceSubscriptions.some((uri) => typeof uri !== "string" || uri.length === 0))
  )
    throw new Error(
      "subscriptions/listen resourceSubscriptions must be an array of non-empty strings.",
    );

  const resourceSubscriptions =
    value.resourceSubscriptions === undefined ? [] : (value.resourceSubscriptions as string[]);
  return {
    toolsListChanged: value.toolsListChanged === true,
    promptsListChanged: value.promptsListChanged === true,
    resourcesListChanged: value.resourcesListChanged === true,
    resourceSubscriptions: new Set(resourceSubscriptions),
  };
}

function subscriptionResponse(
  id: string | number | null | undefined,
  notifications: Subscription["notifications"],
  subscriptions: Set<Subscription>,
): Response {
  let subscription: Subscription | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const honored = {
        toolsListChanged: notifications.toolsListChanged,
        promptsListChanged: notifications.promptsListChanged,
        resourcesListChanged: notifications.resourcesListChanged,
        resourceSubscriptions: notifications.resourceSubscriptions,
      };
      subscription = { id, controller, notifications: honored };
      subscriptions.add(subscription);
      writeSse(controller, {
        jsonrpc: "2.0",
        method: "notifications/subscriptions/acknowledged",
        params: {
          notifications: {
            ...(honored.toolsListChanged ? { toolsListChanged: true } : {}),
            ...(honored.promptsListChanged ? { promptsListChanged: true } : {}),
            ...(honored.resourcesListChanged ? { resourcesListChanged: true } : {}),
            ...(honored.resourceSubscriptions.size
              ? { resourceSubscriptions: [...honored.resourceSubscriptions] }
              : {}),
          },
        },
        _meta: { ...SERVER_INFO_META, [SUBSCRIPTION_ID_META]: id },
      });
    },
    cancel() {
      if (subscription) subscriptions.delete(subscription);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function writeSse(controller: ReadableStreamDefaultController<Uint8Array>, message: unknown): void {
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(message)}\\n\\n`));
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
