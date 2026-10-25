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

The implementation supports MCP protocol versions `2025-11-25` and `2026-07-28`.

- `2025-11-25` (standard handshake): clients call `initialize`, then `notifications/initialized`, and send `MCP-Protocol-Version` on later requests. If a client requests a version Agent Dir does not support, `initialize` answers with `2025-11-25` so the client can decide whether to continue. Only implemented capabilities (`tools`, `resources`) are advertised. `ping` is supported.
- `2026-07-28` (stateless): requests carry protocol version and client capabilities in `params._meta`; this path does not require an initialize handshake or `Mcp-Session-Id`. `server/discover` lists both supported versions.

Both versions are covered by HTTP-level contract tests (`test/protocol-contract.test.ts`).

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
| `find_files` | Find paths by glob; a pattern without `/` matches file names at any depth |
| `search_code` | Search project text (source, docs, config) with scoping, context lines and bounded output; reports `truncated` |
| `find_symbol` | Locate likely symbol definitions (heuristic; JS/TS, Python, Rust, Go, Java, C#, Kotlin, Swift, Ruby, PHP) |
| `find_references` | Locate whole-identifier occurrences of a symbol (lexical, case-sensitive) |
| `read_range` | Read a bounded line range from a UTF-8 file |
| `apply_changes` | Create, patch, or delete files |
| `file_info` | Inspect filesystem metadata |
| `validate` | Run lightweight diagnostics and explicitly requested allowed package scripts |
| `run_package_scripts_batch` | Run explicitly allowlisted package scripts sequentially |
| `run_command_batch` | Run explicitly allowlisted executables sequentially without a shell |
| `ast_grep_search` | Optional syntax-aware AST pattern search when ast-grep is installed |
| `codegraph_explore` | Optional structural code intelligence when CodeGraph is available |
| `serena_*` | Optional Serena semantic navigation and allowlisted symbol-aware edits when installed and configured |

### Search

`search_code`, `find_symbol`, `find_references` and `find_files` share one file list and one search implementation:

- **File list:** inside a git work tree it is `git ls-files --cached --others --exclude-standard`, so `.gitignore` (nested and global) is honored. Elsewhere a bounded walk skips `.git`, `node_modules`, `dist`, `build`, `coverage`, virtualenvs and tool caches. There is no depth limit; if the file cap is hit the result says `incomplete`.
- **What is searched:** any text file, including docs and configuration. Binary files and files over 1 MB are skipped; lockfiles and minified files are skipped unless `includeGenerated` is true. Results are ordered by path and line, one result per line.
- **`search_code` parameters:** `query`, `regex`, `caseSensitive` (default false), `paths` (files or directories), `globs` (includes, or excludes prefixed with `!`), `context` (0-5 surrounding lines in `before`/`after`), `includeGenerated`, `maxResults`, `maxBytes`.
- **Results are objects:** `{ items, returned, truncated, truncationReason, backend, incomplete?, notes? }`. `truncationReason` is `maxResults` or `maxBytes`; `notes` explains things like a path that matched no files.
- **Backends:** ripgrep is used when it is installed (recommended: faster and its regex engine cannot backtrack catastrophically); otherwise a built-in scanner runs. Both search the same candidate files and return the same shape and limits, and `backend` reports which one ran. The built-in backend rejects regexes with nested quantifiers. The startup banner and `project_context` say which backend is active. Set `AGENT_DIR_SEARCH_BACKEND=builtin` to force the built-in search. A pattern ripgrep cannot parse (for example lookahead) falls back to the built-in search with a note.

`apply_changes` returns `{ items, dryRun }`.

### Reading, editing and validating

- **`read_range`** returns the text with a header (`path lines a-b of N`) and a continuation hint, plus structured `{ path, startLine, endLine, content, truncated, eof, totalLines, nextStartLine }`. When `truncated` is true or `nextStartLine` is present, continue from `nextStartLine`. `ranges: [{ startLine, endLine }]` reads several ranges of one file in one call. The default budget is 16 KB; binary files are rejected; files up to 20 MB can be read.
- **`apply_changes`** is all-or-nothing: every change is validated first, files are written through a temporary file and renamed into place (keeping their mode), and a failure while applying restores earlier changes byte-for-byte, including binary files. A patch whose text occurs more than once is rejected with the line numbers unless `count` is set; a patch whose text is not found returns the closest matching lines. Missing files are reported as `'path' does not exist.`
- **`validate`** runs diagnostics (broken symlinks, invalid JSON, merge-conflict blocks; JSON with comments is accepted in files such as `tsconfig.json`) and, for `level` `scripts` or `full`, allowed package scripts. Diagnostics do not include type checking or linting, so `level: diagnostics` is not proof that code compiles. Without `scripts`, `level: scripts` runs `check` (or `typecheck` and `lint`) and `full` runs `check` and `test`; if none is allowed it fails with the allowed script names. Script results use the same `success`/`failure`/`skipped` items as `run_package_scripts_batch`. An unknown `level` is rejected.
- **Script arguments:** `run_package_scripts_batch` accepts `{ script, args }` items. Arguments are appended after `--` and are only accepted for scripts listed in `scripts.argumentScripts` in the profile (for example `["test"]` to run one test file). the `ast-grep` or `sg` CLI is available on `PATH`. It runs read-only `ast-grep run` searches with an explicit argument array (no shell), supports pattern, language, include/exclude globs, and bounded context/results/output. Searches have a 30-second timeout and a 64 KB raw-output ceiling. Rewrites are not exposed. The result is compact JSON; use this tool for syntax-aware matching, `search_code` for exact text/regex, and CodeGraph for call/data-flow and impact analysis.

`codegraph_explore` is only advertised when CodeGraph is installed and the current project has a readable `.codegraph/codegraph.db` index. Other CodeGraph tools are not forwarded.

Serena is optional and exposes an explicit allowlist with the `serena_` prefix: read-only navigation plus selected semantic edits (`rename_symbol`, `replace_symbol_body`, `insert_before_symbol`, and `insert_after_symbol`). Agent Dir does not expose Serena’s general file-creation tools or shell-execution tools. When `.serena/project.yml` exists, Agent Dir checks for a symbol-index cache and runs `serena project index <project-root>` before starting Serena if no cache is found. Indexing failures are logged but do not prevent Agent Dir from starting. Serena updates its index during normal use. Set `AGENT_DIR_SERENA_AUTO_INDEX=0` to disable Agent Dir’s initial-indexing step.

Batch command operations execute sequentially and stop at the first failed command. Tool results include structured content and a serialized text representation; tools returning structured data advertise an output schema.

## Command execution policy

Package scripts and other executables use separate allowlists. An executable not in the configured allowlist is rejected, and configured `blacklistedCommands` prefixes override the allowlist. Commands are launched without a shell.

Agent Dir is not a security boundary against a hostile agent; see `SECURITY.md`. Built-in argument-aware guardrails (global-option-aware blacklist matching, git/package-manager/gh/rg/find rules) and protected paths for `apply_changes` reduce accidents and common bypasses, and are configurable per profile (`commandPolicy`, `protectedPaths`).

### Batch results

`run_command_batch` and `run_package_scripts_batch` return one object: `{ ok, onError, summary, items, truncated }`. Every item has exactly one `status`: `success`, `failure` or `skipped`, plus `ran` (whether the process was started) and, when not successful, a `reason`. Agents never have to infer whether a command ran.

- The whole batch is validated (allowlist, blacklist, guardrails, script existence) before anything runs.
- `onError: "continue"` (default for commands) keeps running independent commands after a failure; `onError: "stop"` (default for scripts) reports later items as `skipped` with the reason. In `stop` mode a rejected item means nothing runs.
- A command item may set `okExitCodes` (for example `[0, 1]` for `rg` or `grep`) so a normal non-zero exit counts as success.
- A timeout or abort is a `failure` that keeps the partial output; earlier results are never discarded.
- Output is shared fairly across items within `maxBytes`; truncated items carry `outputTruncated`, and failures keep the tail of their output.

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

## Serena integration

Install Serena separately and create a project configuration from the project root with `serena project create .`. Agent Dir only advertises Serena tools when the CLI and `.serena/project.yml` are available. It exposes read-only navigation plus four symbol-aware edit operations: `rename_symbol`, `replace_symbol_body`, `insert_before_symbol`, and `insert_after_symbol`. General file creation and shell-execution tools remain unavailable through Serena; use Agent Dir’s native filesystem and allowlisted command tools for those tasks. On first startup without a symbol cache, Agent Dir runs `serena project index <project-root>`; use `AGENT_DIR_SERENA_AUTO_INDEX=0` to disable automatic initial indexing. Indexing can take time on large projects, so the startup logs report when it begins, completes, or fails.

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
