import type { CodeGraphIntegration } from "./codegraph.js";
import type { CommandConfig } from "./types.js";

const DEFAULT_OUTPUT_BYTES = 8_000;
const READ_RANGE_DEFAULT_BYTES = 16_000;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

const stringSchema = { type: "string" };
const stringArrayOrSingle = (maxItems: number) => ({
  anyOf: [{ type: "array", items: stringSchema, maxItems }, stringSchema],
});
const pathSchema = { type: "string", description: "Project-relative path." };
const objectOutput = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
});
const timeoutMsSchema = {
  type: "integer",
  minimum: 1000,
  maximum: 600000,
  default: 120000,
  description: "Per-item timeout.",
};
const okExitCodesSchema = {
  type: "array",
  items: { type: "integer", minimum: 0, maximum: 255 },
  minItems: 1,
  maxItems: 8,
};
const onErrorSchema = {
  type: "string",
  enum: ["continue", "stop"],
  description: "Stop or continue after failure.",
};

const codeGraphTool: ToolDefinition = tool(
  "codegraph_explore",
  "Use first for structure: explain behavior, trace call flow, map symbols or assess impact. Prefer over repeated grep/read loops. Use search_code/find_symbol/read_range for exact-text follow-up; treat returned source as read.",
  {
    query: { type: "string", minLength: 1 },
    maxFiles: { type: "integer", minimum: 1, maximum: 100, default: 10 },
    maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
  },
  ["query"],
);

const baseTools: ToolDefinition[] = [
  tool(
    "read_range",
    "Read UTF-8 ranges in a project file; pass up to 10. Continue with nextStartLine; use search_code context for nearby matches or skipIfUnchanged=true to omit unchanged repeats.",
    {
      path: pathSchema,
      startLine: { type: "integer", minimum: 1 },
      endLine: { type: "integer", minimum: 1 },
      ranges: {
        type: "array",
        maxItems: 10,
        items: objectOutput(
          { startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } },
          ["startLine", "endLine"],
        ),
        description: "Same-file ranges; replaces startLine/endLine.",
      },
      skipIfUnchanged: {
        type: "boolean",
        default: false,
        description: "Omit unchanged repeats in this session.",
      },
      maxBytes: {
        type: "integer",
        minimum: 1024,
        maximum: 64000,
        default: READ_RANGE_DEFAULT_BYTES,
      },
    },
    ["path"],
  ),
  tool(
    "apply_changes",
    "Atomically apply related writes, exact patches, and deletes. Returns only per-file status; never returns file contents or diffs. Use dryRun=true to preview changes.",
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
    ["changes"],
  ),
  tool(
    "find_files",
    "Find project paths by glob (`*`, `**`, `?`); bare names match any depth. Honors .gitignore. Empty results may suggest a nearby path.",
    {
      pattern: stringSchema,
      maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
    },
    ["pattern"],
  ),
  tool(
    "search_code",
    "Search project text by literal or regex. Scope with paths/globs and use context to avoid follow-up reads. Honors .gitignore; skips binaries and files over 1 MB. Lockfiles and minified files require includeGenerated. Truncation includes per-file counts.",
    {
      query: stringSchema,
      regex: { type: "boolean", default: false },
      caseSensitive: { type: "boolean", default: false },
      paths: {
        ...stringArrayOrSingle(20),
        description: "Project-relative path(s) to search.",
      },
      globs: {
        ...stringArrayOrSingle(20),
        description: "Include or exclude glob; prefix exclusions with !.",
      },
      context: { type: "integer", minimum: 0, maximum: 5, default: 0 },
      multiline: {
        type: "boolean",
        default: false,
        description: "Allow multiline matches in either backend.",
      },
      includeGenerated: { type: "boolean", default: false },
      format: {
        type: "string",
        enum: ["text", "json"],
        default: "text",
        description: "Text or JSON output.",
      },
      queries: {
        ...stringArrayOrSingle(5),
        description: "Patterns share maxBytes across result groups.",
      },
      maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
    },
    [],
    {
      anyOf: [
        { required: ["query"], properties: { query: stringSchema } },
        {
          required: ["queries"],
          properties: { queries: stringArrayOrSingle(5) },
        },
      ],
    },
  ),
  tool(
    "find_symbol",
    "Find likely case-sensitive definitions by pattern (JS/TS, Python, Rust, Go, Java, C#, Kotlin, Swift, Ruby, PHP). Use read_range for context.",
    {
      symbol: stringSchema,
      maxResults: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
    },
    ["symbol"],
  ),
  tool(
    "find_references",
    "Find case-sensitive whole-identifier matches, including comments, strings and unrelated same-named identifiers. Use find_symbol for likely definitions.",
    {
      symbol: stringSchema,
      maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 200 },
      maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
    },
    ["symbol"],
  ),
  tool(
    "project_context",
    "Return a compact LLM-oriented project snapshot combining project overview, package metadata, and active execution policy. Prefer this over separate orientation calls.",
    {
      maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
    },
  ),
  tool("file_info", "Return filesystem metadata for a project path.", { path: pathSchema }, [
    "path",
  ]),
  tool(
    "run_package_scripts_batch",
    "Run allowed package scripts sequentially without a shell. Success output defaults to the last 20 lines; maxBytes can return more. Prefer targeted scripts. Default onError=stop; validate the full batch first.",
    {
      scripts: {
        type: "array",
        minItems: 1,
        maxItems: 10,
        items: {
          anyOf: [
            stringSchema,
            objectOutput(
              { script: stringSchema, args: { type: "array", items: stringSchema, maxItems: 16 } },
              ["script"],
            ),
          ],
        },
        description: "Names or {script,args}; extra arguments require argumentScripts.",
      },
      onError: onErrorSchema,
      timeoutMs: timeoutMsSchema,
      maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
    },
    ["scripts"],
  ),
  tool(
    "run_command_batch",
    "Run up to 10 allowlisted commands sequentially without a shell. Prefer dedicated tools; default onError=continue. Set okExitCodes for expected non-zero results; item values override the batch default.",
    {
      commands: {
        type: "array",
        items: objectOutput(
          {
            command: stringSchema,
            args: { type: "array", items: stringSchema },
            okExitCodes: {
              ...okExitCodesSchema,
              description: "Overrides the batch default.",
            },
          },
          ["command"],
        ),
        minItems: 1,
        maxItems: 10,
      },
      okExitCodes: {
        ...okExitCodesSchema,
        description: "Success codes (default [0]); item values override.",
      },
      onError: onErrorSchema,
      timeoutMs: timeoutMsSchema,
      maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
    },
    ["commands"],
  ),
];

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
  schemaExtras: Record<string, unknown> = {},
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
      ...schemaExtras,
      additionalProperties: false,
    },
  };
}

/** Hints for clients (never a security control): which tools only read, and which may change things. */
const READ_ONLY_TOOLS = new Set([
  "project_context",
  "file_info",
  "read_range",
  "find_files",
  "search_code",
  "find_symbol",
  "find_references",
  "codegraph_explore",
  "telemetry_analytics",
]);

export function toolAnnotations(name: string): Record<string, unknown> {
  if (READ_ONLY_TOOLS.has(name)) return { readOnlyHint: true, openWorldHint: false };
  if (name === "apply_changes")
    return {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    };
  // run_command_batch and run_package_scripts_batch run programs that may touch anything.
  return { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
}

/** Tools removed on purpose: name the replacement instead of guessing the closest tool. */
export const REMOVED_TOOL_HINTS = new Map([
  [
    "validate",
    " validate was removed; run an allowed package script such as check with run_package_scripts_batch.",
  ],
]);

/** Plain Levenshtein distance, used only to suggest a tool name to a confused agent. */
function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j] ?? 0;
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      previous[j] = Math.min((previous[j] ?? 0) + 1, (previous[j - 1] ?? 0) + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return previous[right.length] ?? right.length;
}

/** Up to three advertised tool names closest to a mistyped one. */
export function nearestNames(name: string, available: string[], limit = 3): string[] {
  const needle = name.toLowerCase();
  const threshold = Math.max(2, Math.floor(needle.length / 3));
  return available
    .map((candidate) => ({
      candidate,
      distance: editDistance(needle, candidate.toLowerCase()),
    }))
    .filter((entry) => entry.distance <= threshold)
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

/** True when the profile's tool selection removes this tool. */
export function isToolDisabled(name: string, selection: CommandConfig["tools"]): boolean {
  if (selection?.disabled?.includes(name)) return true;
  const sets = new Set(selection?.disabledSets ?? []);
  if (sets.has("codegraph") && name === "codegraph_explore") return true;
  if (sets.has("analytics") && name === "telemetry_analytics") return true;
  if (sets.has("filesystem") && ["read_range", "find_files", "file_info"].includes(name))
    return true;
  if (
    sets.has("search") &&
    ["search_code", "find_symbol", "find_references", "codegraph_explore"].includes(name)
  )
    return true;
  if (sets.has("commands") && ["run_command_batch", "run_package_scripts_batch"].includes(name))
    return true;
  return false;
}

export async function availableTools(
  codeGraph: CodeGraphIntegration,
  analyticsEnabled = false,
  selection: CommandConfig["tools"] = undefined,
): Promise<ToolDefinition[]> {
  const disabled = new Set(selection?.disabled ?? []);
  const disabledSets = new Set(selection?.disabledSets ?? []);
  const isDisabled = (name: string): boolean => isToolDisabled(name, selection);
  const capability =
    !disabledSets.has("codegraph") && !disabled.has("codegraph_explore")
      ? await codeGraph.capability()
      : undefined;
  const codeGraphTools = capability?.status === "available" ? [codeGraphTool] : [];
  const candidates = [
    ...baseTools,
    ...codeGraphTools,
    ...(analyticsEnabled ? [telemetryAnalyticsTool] : []),
  ];
  return candidates
    .filter((item) => !isDisabled(item.name))
    .map((item) => ({ ...item, annotations: toolAnnotations(item.name) }));
}

const telemetryAnalyticsTool: ToolDefinition = tool(
  "telemetry_analytics",
  "Analyze locally persisted Agent Dir telemetry across all profiles and sessions. Summary mode defaults to compact rates, top issues and a per-client split; set view='full' for full tables. excludeClients removes matching clients; event mode returns bounded sanitized records. Available only when Agent Dir is started with --analytics.",
  {
    mode: { type: "string", enum: ["summary", "sessions", "events"], default: "summary" },
    view: {
      type: "string",
      enum: ["compact", "full"],
      default: "compact",
      description: "Summary view only; full includes the per-tool and per-command tables.",
    },
    profile: { type: "string", maxLength: 100 },
    session: { type: "string", maxLength: 100 },
    client: {
      type: "string",
      maxLength: 100,
      description:
        "Only events from this MCP client, by name or name@version (for example better-deepseek@0.1.15).",
    },
    excludeClients: {
      type: "array",
      items: { type: "string", maxLength: 100 },
      maxItems: 20,
      description: "Exclude matching MCP clients; each selector uses the same matching as client.",
    },
    since: { type: "string", description: "Optional ISO timestamp lower bound." },
    until: { type: "string", description: "Optional ISO timestamp upper bound." },
    limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
    maxBytes: { type: "integer", minimum: 1024, maximum: 64000, default: DEFAULT_OUTPUT_BYTES },
  },
);
