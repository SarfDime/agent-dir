import { createRequire } from "node:module";
import { runCommand } from "./tools/commands.js";
import type { FilePatch } from "./tools/files.js";
import {
  deleteFile,
  listDir,
  listDirs,
  listFiles,
  patchFile,
  patchFiles,
  readFile,
  writeFile,
} from "./tools/files.js";
import { runNpm } from "./tools/npm.js";
import type { CommandConfig } from "./types.js";

const require = createRequire(import.meta.url);
const packageVersion = (require("../../package.json") as { version: string }).version;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const filePathSchema = {
  type: "string",
  description: "Path relative to the exposed project root.",
};

const baseTools: ToolDefinition[] = [
  {
    name: "list_files",
    description: "List files and directories in the exposed project.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_dir",
    description: "List files and directories directly inside a specific project directory.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          ...filePathSchema,
          description: "Directory path relative to the exposed project root.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "list_dirs",
    description: "List files and directories directly inside multiple project directories.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: filePathSchema, minItems: 1 },
      },
      required: ["paths"],
    },
  },
  {
    name: "read_file",
    description: "Read one UTF-8 text file.",
    inputSchema: { type: "object", properties: { path: filePathSchema }, required: ["path"] },
  },
  {
    name: "read_files",
    description: "Read multiple UTF-8 text files in one call.",
    inputSchema: {
      type: "object",
      properties: { paths: { type: "array", items: filePathSchema, minItems: 1 } },
      required: ["paths"],
    },
  },
  {
    name: "write_file",
    description: "Create or completely replace one UTF-8 text file.",
    inputSchema: {
      type: "object",
      properties: { path: filePathSchema, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "write_files",
    description: "Create or completely replace multiple UTF-8 text files in one call.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: {
            type: "object",
            properties: { path: filePathSchema, content: { type: "string" } },
            required: ["path", "content"],
          },
          minItems: 1,
        },
      },
      required: ["files"],
    },
  },
  {
    name: "patch_file",
    description:
      "Apply exact text replacements to a UTF-8 file without replacing its entire contents.",
    inputSchema: {
      type: "object",
      properties: {
        path: filePathSchema,
        patches: {
          type: "array",
          items: {
            type: "object",
            properties: {
              search: { type: "string" },
              replace: { type: "string" },
              count: { type: "integer", minimum: 1 },
            },
            required: ["search", "replace"],
          },
          minItems: 1,
        },
      },
      required: ["path", "patches"],
    },
  },
  {
    name: "patch_files",
    description: "Apply exact text replacements to multiple UTF-8 files in one call.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: filePathSchema,
              patches: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    search: { type: "string" },
                    replace: { type: "string" },
                    count: { type: "integer", minimum: 1 },
                  },
                  required: ["search", "replace"],
                },
                minItems: 1,
              },
            },
            required: ["path", "patches"],
          },
          minItems: 1,
        },
      },
      required: ["files"],
    },
  },
  {
    name: "delete_file",
    description: "Delete one file.",
    inputSchema: { type: "object", properties: { path: filePathSchema }, required: ["path"] },
  },
  {
    name: "delete_files",
    description: "Delete multiple files in one call.",
    inputSchema: {
      type: "object",
      properties: { paths: { type: "array", items: filePathSchema, minItems: 1 } },
      required: ["paths"],
    },
  },
  {
    name: "run_npm",
    description: "Run one explicitly allowed npm script.",
    inputSchema: {
      type: "object",
      properties: { script: { type: "string" } },
      required: ["script"],
    },
  },
  {
    name: "run_npm_batch",
    description: "Run multiple explicitly allowed npm scripts sequentially.",
    inputSchema: {
      type: "object",
      properties: { scripts: { type: "array", items: { type: "string" }, minItems: 1 } },
      required: ["scripts"],
    },
  },
  {
    name: "run_command",
    description: "Run one explicitly allowed executable. No shell is used.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
      },
      required: ["command"],
    },
  },
  {
    name: "run_command_batch",
    description: "Run multiple explicitly allowed commands sequentially without a shell.",
    inputSchema: {
      type: "object",
      properties: {
        commands: {
          type: "array",
          items: {
            type: "object",
            properties: {
              command: { type: "string" },
              args: { type: "array", items: { type: "string" } },
            },
            required: ["command"],
          },
          minItems: 1,
        },
      },
      required: ["commands"],
    },
  },
];

const result = (content: unknown) => ({
  content: [
    {
      type: "text",
      text: typeof content === "string" ? content : JSON.stringify(content, null, 2),
    },
  ],
});

export function createMcpHandler(
  root: string,
  commandConfig: CommandConfig = {},
): (request: Request) => Promise<Response> {
  const npmAllowed = commandConfig.npm?.allowedScripts ?? [];
  const allowedCommands = commandConfig.commands ?? [];
  return async (request: Request): Promise<Response> => {
    let message: JsonRpcRequest;
    try {
      message = (await request.json()) as JsonRpcRequest;
    } catch {
      return json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } }, 400);
    }
    const { id, method, params = {} } = message;
    if (method === "initialize")
      return json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "agent-dir", version: packageVersion },
        },
      });
    if (method === "notifications/initialized") return new Response(null, { status: 202 });
    if (method === "tools/list") return json({ jsonrpc: "2.0", id, result: { tools: baseTools } });
    if (method === "tools/call") {
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const output = await callTool(name, args, root, npmAllowed, allowedCommands);
        return json({ jsonrpc: "2.0", id, result: output });
      } catch (error) {
        return json({
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            ...result(error instanceof Error ? error.message : String(error)),
          },
        });
      }
    }
    return json({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  };
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  root: string,
  npmAllowed: string[],
  allowedCommands: string[],
): Promise<ReturnType<typeof result>> {
  switch (name) {
    case "list_files":
      return result(await listFiles(root));
    case "list_dir":
      return result(await listDir(root, String(args.path ?? ".")));
    case "list_dirs":
      return result(await listDirs(root, stringArray(args.paths, "paths")));
    case "read_file":
      return result(await readFile(root, String(args.path)));
    case "read_files":
      return result(
        await Promise.all(
          stringArray(args.paths, "paths").map(async (filePath) => ({
            path: filePath,
            content: await readFile(root, filePath),
          })),
        ),
      );
    case "write_file":
      await writeFile(root, String(args.path), String(args.content));
      return result("File written successfully.");
    case "write_files":
      for (const file of objectArray(args.files, "files"))
        await writeFile(root, String(file.path), String(file.content));
      return result("Files written successfully.");
    case "patch_file": {
      const patches: FilePatch[] = objectArray(args.patches, "patches").map((patch) => {
        if (patch.count === undefined)
          return { search: String(patch.search), replace: String(patch.replace) };
        return {
          search: String(patch.search),
          replace: String(patch.replace),
          count: Number(patch.count),
        };
      });
      return result(await patchFile(root, String(args.path), patches));
    }
    case "patch_files": {
      const files = objectArray(args.files, "files").map((file) => ({
        path: String(file.path),
        patches: objectArray(file.patches, "patches").map((patch) => ({
          search: String(patch.search),
          replace: String(patch.replace),
          ...(patch.count === undefined ? {} : { count: Number(patch.count) }),
        })),
      }));
      return result(await patchFiles(root, files));
    }
    case "delete_file":
      await deleteFile(root, String(args.path));
      return result("File deleted successfully.");
    case "delete_files":
      for (const filePath of stringArray(args.paths, "paths")) await deleteFile(root, filePath);
      return result("Files deleted successfully.");
    case "run_npm":
      return result(await runNpm(root, String(args.script), 120000, npmAllowed));
    case "run_npm_batch": {
      const results = [];
      for (const script of stringArray(args.scripts, "scripts")) {
        const output = await runNpm(root, script, 120000, npmAllowed);
        results.push(output);
        if (output.exitCode !== 0) break;
      }
      return result(results);
    }
    case "run_command":
      return result(
        await runCommand(
          root,
          String(args.command),
          Array.isArray(args.args) ? args.args.map(String) : [],
          allowedCommands,
        ),
      );
    case "run_command_batch": {
      const results = [];
      for (const item of objectArray(args.commands, "commands")) {
        const output = await runCommand(
          root,
          String(item.command),
          Array.isArray(item.args) ? item.args.map(String) : [],
          allowedCommands,
        );
        results.push(output);
        if (output.exitCode !== 0) break;
      }
      return result(results);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
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

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
