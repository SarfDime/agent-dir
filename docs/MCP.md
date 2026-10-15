# MCP interface and security model

Agent Dir exposes a local project through an authenticated, stateless Model Context Protocol endpoint.

## Endpoint and authentication

- `POST /mcp` is the application MCP endpoint and requires authentication.
- `HEAD /__health` is reserved for local tunnel health checks and does not expose project contents.
- Legacy direct filesystem REST routes such as `/__tree` and direct `GET`/`PUT`/`DELETE` file paths are not supported.

Use the Bearer token in the standard header:

```http
Authorization: Bearer <token>
```

The server also accepts a query-string token for clients that cannot set an Authorization header. Prefer the header because query-string tokens can be exposed in URLs and logs.

## Stateless protocol behavior

The implementation supports MCP protocol version `2026-07-28`. Requests carry protocol version and client capabilities in `params._meta`; this path does not require an initialize handshake or `Mcp-Session-Id`.

Standard Streamable HTTP requests do not need implementation-specific `MCP-Protocol-Version`, `Mcp-Method`, or `Mcp-Name` headers. If supplied, these headers are validated against the JSON-RPC request and metadata.

Supported features include:

- `server/discover`
- cursor pagination for list-style methods
- `subscriptions/listen` for tool, prompt, and resource change events
- resource subscriptions and filesystem change notifications
- cache metadata
- structured tool results with `resultType` and `outputSchema`
- the stable `io.modelcontextprotocol/skills` extension

Modern `subscriptions/listen` replaces the legacy GET/SSE notification model. List-style methods use opaque cursors when more than 50 entries are available.

## Public tool set

The core public tool set is intentionally small:

| Tool | Purpose |
| --- | --- |
| `project_context` | Compact project overview and active execution policy |
| `find_files` | Find paths by glob |
| `search_code` | Search source-like files with bounded output |
| `find_symbol` | Locate likely symbol definitions |
| `find_references` | Locate symbol references |
| `read_range` | Read a bounded line range from a UTF-8 file |
| `apply_changes` | Create, patch, or delete files |
| `file_info` | Inspect filesystem metadata |
| `validate` | Run lightweight diagnostics and explicitly requested allowed npm scripts |
| `run_npm_batch` | Run explicitly allowlisted npm scripts sequentially |
| `run_command_batch` | Run explicitly allowlisted executables sequentially without a shell |
| `ast_grep_search` | Optional syntax-aware AST pattern search when ast-grep is installed |
| `codegraph_explore` | Optional structural code intelligence when CodeGraph is available |

`ast_grep_search` is only advertised when the `ast-grep` or `sg` CLI is available on `PATH`. It runs read-only `ast-grep run` searches with an explicit argument array (no shell), supports pattern, language, include/exclude globs, and bounded context/results/output. Searches have a 30-second timeout and a 64 KB raw-output ceiling. Rewrites are not exposed. The result is compact JSON; use this tool for syntax-aware matching, `search_code` for exact text/regex, and CodeGraph for call/data-flow and impact analysis.

`codegraph_explore` is only advertised when CodeGraph is installed and the current project has a readable `.codegraph/codegraph.db` index. Other CodeGraph tools are not forwarded.

Batch command operations execute sequentially and stop at the first failed command. Tool results include structured content and a serialized text representation; tools returning structured data advertise an output schema.

## Command execution policy

npm scripts and other executables use separate allowlists. An executable not in the configured allowlist is rejected, and configured `blacklistedCommands` prefixes override the allowlist. Commands are launched without a shell.

Git is run through `run_command_batch` when `git` is allowlisted. There are no dedicated Git MCP tools. This keeps the advertised tool set small while preserving explicit executable and argument restrictions. Avoid allowing shells or interpreters unless broader command execution is intentional.

## CodeGraph integration

CodeGraph is optional and installed separately:

```bash
npm install -g @colbymchenry/codegraph
codegraph init
```

Agent Dir exposes `codegraph_explore` only when the executable is on `PATH` and the current project has a readable index. It starts CodeGraph on first use and reuses the child process for subsequent calls. The project root is fixed as the CodeGraph path; callers cannot forward arbitrary `projectPath` values. Agent Dir passes a limited environment to the child process and terminates it during shutdown.

Discovery distinguishes these states:

- `not_installed` — CodeGraph is unavailable on `PATH`.
- `not_indexed` — installed, but this project has no readable index.
- `available` — installed and indexed.
- `startup_failed` / `runtime_failed` — CodeGraph failed to start or later terminated; Agent Dir remains available.

When indexed, agents are instructed to use CodeGraph for non-trivial structural questions such as call/data flow, symbol relationships, and change impact. Exact-text searches and focused file edits use Agent Dir's native tools.

## Agent instructions and Skills

`server/discover` returns dynamically generated instructions. The Resources primitive exposes:

```text
agent-dir://instructions
agent-dir://capabilities
```

The capabilities resource reports the Agent Dir version, registered tool names, execution policy, and preferred/avoid tool-selection patterns.

Agent Dir implements the stable MCP Skills extension (`io.modelcontextprotocol/skills`) and discovers project-local `SKILL.md` files under:

```text
skills/
.agents/skills/
.claude/skills/
.github/skills/
```

Skills are exposed through `skills/list`, `skills/get`, `resources/list`, and `resources/read`. Skill manifests are bounded to 512 resources and 16 MiB. Binary supporting files are returned as MCP blobs; `resources/directory/read` lists direct children of a skill resource directory.
