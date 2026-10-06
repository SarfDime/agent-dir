import { createRequire } from "node:module";
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

const baseTools: ToolDefinition[] = [
  tool(
    "list_files",
    "List all visible project files and directories recursively up to the server's discovery depth.",
    {},
    arrayOutput(fileEntrySchema),
  ),
  tool(
    "list_dirs",
    "List files and directories directly inside one or more project directories.",
    { paths: { type: "array", items: pathSchema, minItems: 1 } },
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
    "Read one or more UTF-8 project files in one call.",
    { paths: { type: "array", items: pathSchema, minItems: 1 } },
    arrayOutput(objectOutput({ path: stringSchema, content: stringSchema }, ["path", "content"])),
    ["paths"],
  ),
  tool(
    "write_files",
    "Create or completely replace one or more UTF-8 project files.",
    {
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
    "Apply exact text replacements to one or more UTF-8 files.",
    {
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
    { paths: { type: "array", items: pathSchema, minItems: 1 } },
    arrayOutput(
      objectOutput({ path: stringSchema, deleted: { type: "boolean" } }, ["path", "deleted"]),
    ),
    ["paths"],
  ),
  tool(
    "search_files",
    "Search text across visible project files.",
    {
      query: stringSchema,
      regex: { type: "boolean", default: false },
      maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
    },
    arrayOutput(searchMatchSchema),
    ["query"],
  ),
  tool(
    "find_files",
    "Find project files by a simple glob pattern using * and ?.",
    {
      pattern: stringSchema,
      maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
    },
    arrayOutput(stringSchema),
    ["pattern"],
  ),
  tool(
    "search_code",
    "Search source-like project files for text or a regular expression.",
    {
      query: stringSchema,
      regex: { type: "boolean", default: false },
      maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
    },
    arrayOutput(searchMatchSchema),
    ["query"],
  ),
  tool(
    "find_symbol",
    "Find likely symbol definitions across source files.",
    {
      symbol: stringSchema,
      maxResults: { type: "integer", minimum: 1, maximum: 500, default: 100 },
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
    "Find likely definitions of a symbol.",
    {
      symbol: stringSchema,
      maxResults: { type: "integer", minimum: 1, maximum: 500, default: 100 },
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
    "Find source-code references to a symbol.",
    {
      symbol: stringSchema,
      maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
    },
    arrayOutput(searchMatchSchema),
    ["symbol"],
  ),
  tool(
    "find_imports",
    "Find import and require statements in source files.",
    { maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 } },
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
    { maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 } },
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
    "Show Git working-tree status and branch information.",
    {},
    commandResultSchema,
  ),
  tool(
    "git_stage",
    "Stage one or more Git paths.",
    { paths: { type: "array", items: pathSchema, minItems: 1 } },
    commandResultSchema,
    ["paths"],
  ),
  tool(
    "git_unstage",
    "Unstage one or more Git paths without changing their working-tree contents.",
    { paths: { type: "array", items: pathSchema, minItems: 1 } },
    commandResultSchema,
    ["paths"],
  ),
  tool(
    "git_commit",
    "Create a Git commit with the currently staged changes.",
    { message: stringSchema },
    commandResultSchema,
    ["message"],
  ),
  tool(
    "git_restore",
    "Restore one or more Git paths from the index, discarding unstaged working-tree changes.",
    { paths: { type: "array", items: pathSchema, minItems: 1 } },
    commandResultSchema,
    ["paths"],
  ),
  tool(
    "git_push",
    "Push the current Git branch to a remote.",
    { remote: stringSchema, branch: stringSchema },
    commandResultSchema,
  ),
  tool(
    "git_diff",
    "Show a read-only Git diff, optionally staged or limited to a path.",
    { staged: { type: "boolean", default: false }, path: pathSchema },
    commandResultSchema,
  ),
  tool(
    "git_log",
    "Show recent Git commits in a compact, read-only form.",
    { limit: { type: "integer", minimum: 1, maximum: 200, default: 20 }, path: pathSchema },
    commandResultSchema,
  ),
  tool(
    "project_overview",
    "Summarize project structure, languages, package managers, project metadata files, and Git state.",
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
    "Run project-independent diagnostics without invoking tests, linters, or typecheckers.",
    { maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 } },
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
    "Run one or more explicitly allowed npm scripts sequentially.",
    { scripts: { type: "array", items: stringSchema, minItems: 1 } },
    arrayOutput(commandResultSchema),
    ["scripts"],
  ),
  tool(
    "run_command_batch",
    "Run one or more explicitly allowed commands sequentially without a shell.",
    {
      commands: {
        type: "array",
        items: objectOutput(
          { command: stringSchema, args: { type: "array", items: stringSchema } },
          ["command"],
        ),
        minItems: 1,
      },
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
          instructions:
            "Expose and edit the project through secure filesystem tools, code intelligence, read-only Git inspection, project metadata, diagnostics, and project-local Agent Skills.",
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
              instructions:
                "Expose and edit the project through secure filesystem tools, code intelligence, read-only Git inspection, project metadata, diagnostics, and project-local Agent Skills.",
              ttlMs: 0,
              cacheScope: "private",
            },
          });
        case "tools/list": {
          const page = paginate(baseTools, params.cursor);
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
          const toolDefinition = baseTools.find((item) => item.name === toolName);
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
            ),
          });
        }
        case "resources/list": {
          const resources = (await listSkillResources(root)).map((item) => ({
            ...item,
            description: "Agent Skill resource",
          }));
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
        message.method === "subscriptions/listen"
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
  };

  return handler;
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
): Promise<Record<string, unknown>> {
  let structuredContent: unknown;
  switch (name) {
    case "list_files":
      structuredContent = await listFiles(root);
      break;
    case "list_dirs":
      structuredContent = await listDirs(root, stringArray(args.paths, "paths"));
      break;
    case "read_range":
      structuredContent = await readRange(
        root,
        String(args.path),
        Number(args.startLine),
        Number(args.endLine),
      );
      break;
    case "read_files":
      structuredContent = await Promise.all(
        stringArray(args.paths, "paths").map(async (p) => ({
          path: p,
          content: await readFile(root, p),
        })),
      );
      break;
    case "write_files": {
      const output: Array<{ path: string; written: boolean }> = [];
      for (const file of objectArray(args.files, "files")) {
        const p = String(file.path);
        const before = await skillResourceUrisForPath(root, p);
        await writeFile(root, p, String(file.content));
        await notifyResourceChange(notify, root, p, before);
        output.push({ path: p, written: true });
      }
      structuredContent = output;
      break;
    }
    case "patch_files": {
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
      structuredContent = await patchFiles(root, files);
      for (const file of files)
        await notifyResourceChange(notify, root, file.path, before.get(file.path) ?? []);
      break;
    }
    case "delete_files": {
      const output: Array<{ path: string; deleted: boolean }> = [];
      for (const p of stringArray(args.paths, "paths")) {
        const before = await skillResourceUrisForPath(root, p);
        await deleteFile(root, p);
        await notifyResourceChange(notify, root, p, before);
        output.push({ path: p, deleted: true });
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
      );
      break;
    case "find_files":
      structuredContent = await findFiles(
        root,
        String(args.pattern),
        numberArg(args.maxResults, 200, 1000),
      );
      break;
    case "search_code":
      structuredContent = await searchCode(
        root,
        String(args.query),
        Boolean(args.regex),
        numberArg(args.maxResults, 200, 1000),
      );
      break;
    case "find_symbol":
      structuredContent = await findSymbol(
        root,
        String(args.symbol),
        numberArg(args.maxResults, 100, 500),
      );
      break;
    case "find_definition":
      structuredContent = await findDefinition(
        root,
        String(args.symbol),
        numberArg(args.maxResults, 100, 500),
      );
      break;
    case "find_references":
      structuredContent = await findReferences(
        root,
        String(args.symbol),
        numberArg(args.maxResults, 200, 1000),
      );
      break;
    case "find_imports":
      structuredContent = await findImports(root, numberArg(args.maxResults, 200, 1000));
      break;
    case "find_exports":
      structuredContent = await findExports(root, numberArg(args.maxResults, 200, 1000));
      break;
    case "git_status":
      structuredContent = await gitStatus(root);
      break;
    case "git_stage":
      structuredContent = await gitStage(root, stringArray(args.paths, "paths"));
      break;
    case "git_unstage":
      structuredContent = await gitUnstage(root, stringArray(args.paths, "paths"));
      break;
    case "git_commit":
      structuredContent = await gitCommit(root, String(args.message));
      break;
    case "git_restore":
      structuredContent = await gitRestore(root, stringArray(args.paths, "paths"));
      break;
    case "git_push":
      structuredContent = await gitPush(
        root,
        args.remote === undefined ? undefined : String(args.remote),
        args.branch === undefined ? undefined : String(args.branch),
      );
      break;
    case "git_diff":
      structuredContent = await gitDiff(
        root,
        Boolean(args.staged),
        args.path === undefined ? undefined : String(args.path),
      );
      break;
    case "git_log":
      structuredContent = await gitLog(
        root,
        numberArg(args.limit, 20, 200),
        args.path === undefined ? undefined : String(args.path),
      );
      break;
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
      structuredContent = await diagnostics(root, numberArg(args.maxResults, 200, 1000));
      break;
    case "run_npm_batch": {
      const output = [];
      for (const script of stringArray(args.scripts, "scripts")) {
        const value = await runNpm(root, script, 120000, npmAllowed, signal);
        output.push(value);
        if (value.exitCode !== 0) break;
      }
      structuredContent = output;
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
      structuredContent = output;
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
  const offset = Number(decoded);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid pagination cursor.");
  return offset;
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
