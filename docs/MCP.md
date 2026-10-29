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

| Tool                        | Purpose                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `project_context`           | Compact project overview and active execution policy                                                           |
| `find_files`                | Find paths by glob; a pattern without `/` matches file names at any depth                                      |
| `search_code`               | Search project text (source, docs, config); grep-style output, scoping and context lines                       |
| `find_symbol`               | Locate likely symbol definitions (heuristic; JS/TS, Python, Rust, Go, Java, C#, Kotlin, Swift, Ruby, PHP)      |
| `find_references`           | Locate whole-identifier occurrences of a symbol (lexical, case-sensitive)                                      |
| `read_range`                | Read a bounded line range from a UTF-8 file                                                                    |
| `apply_changes`             | Create, patch, or delete files                                                                                 |
| `file_info`                 | Inspect filesystem metadata                                                                                    |
| `validate`                  | Run lightweight diagnostics and explicitly requested allowed package scripts                                   |
| `run_package_scripts_batch` | Run explicitly allowlisted package scripts sequentially                                                        |
| `run_command_batch`         | Run explicitly allowlisted executables sequentially without a shell                                            |
| `codegraph_explore`         | Optional structural code intelligence when CodeGraph is available                                              |

### Search

`search_code`, `find_symbol`, `find_references` and `find_files` share one file list and one search implementation:

- **File list:** inside a git work tree it is `git ls-files --cached --others --exclude-standard`, so `.gitignore` (nested and global) is honored. Elsewhere a bounded walk skips `.git`, `node_modules`, `dist`, `build`, `coverage`, virtualenvs and tool caches. There is no depth limit; if the file cap is hit the result says `incomplete`.
- **What is searched:** any text file, including docs and configuration. Binary files and files over 1 MB are skipped; lockfiles and minified files are skipped unless `includeGenerated` is true. Results are ordered by path and line, one result per line.
- **`search_code` parameters:** `query`, `regex`, `caseSensitive` (default false), `paths` (files or directories), `globs` (includes, or excludes prefixed with `!`), `context` (0-5 surrounding lines), `multiline` (let the pattern span lines; with `regex`, `.` also matches newlines), `includeGenerated`, `format` (`text` by default, `json` for the object envelope), `maxResults`, `maxBytes`. `multiline` behaves identically on the ripgrep (`-U`) and built-in backends.
- **`search_code` output is text by default:** a summary line `N matches in M files (backend[, truncated: reason])`, then one line per match as `path:line:col text` (`path:start-end:col` when a match spans lines). Context lines follow the match as `  | line`. Pass `format: "json"` to get `{ items, returned, truncated, truncationReason, backend, incomplete?, scanned?, notes? }` instead; `truncationReason` is `maxResults` or `maxBytes`.
- **Empty and truncated results explain themselves.** A search that finds nothing says how many files were searched and which mode applied (literal, case-insensitive, generated and binary files skipped) and what to try next. A cut result says whether `maxBytes` or `maxResults` stopped it. `find_files` does the same for a pattern that matches nothing, including the reminder that `*` does not cross `/`.
- **Backends:** ripgrep is used when it is installed (recommended: faster and its regex engine cannot backtrack catastrophically); otherwise a built-in scanner runs. Both search the same candidate files and return the same shape and limits, and `backend` reports which one ran. The built-in backend rejects regexes with nested quantifiers. The startup banner and `project_context` say which backend is active. Set `AGENT_DIR_SEARCH_BACKEND=builtin` to force the built-in search. A pattern ripgrep cannot parse (for example lookahead) falls back to the built-in search with a note.

`apply_changes` returns `{ items, dryRun }`. A change that targets a file that does not exist names the closest existing paths, so a mistyped path costs one turn instead of two.

### Reading, editing and validating

- **`read_range`** returns the text with a header (`path lines a-b of N`) and a continuation hint, plus structured `{ path, startLine, endLine, content, truncated, eof, totalLines, nextStartLine }`. When `truncated` is true or `nextStartLine` is present, continue from `nextStartLine`. `ranges: [{ startLine, endLine }]` reads several ranges of one file in one call. The default budget is 16 KB; binary files are rejected; files up to 20 MB can be read.
- **`apply_changes`** is all-or-nothing: every change is validated first, files are written through a temporary file and renamed into place (keeping their mode), and a failure while applying restores earlier changes byte-for-byte, including binary files. A patch whose text occurs more than once is rejected with the line numbers unless `count` is set; a patch whose text is not found returns the closest matching lines. Missing files are reported as `'path' does not exist.`
- **`validate`** runs diagnostics (broken symlinks, invalid JSON, merge-conflict blocks; JSON with comments is accepted in files such as `tsconfig.json`) and, for `level` `scripts` or `full`, allowed package scripts. Diagnostics do not include type checking or linting, so `level: diagnostics` is not proof that code compiles. Without `scripts`, `level: scripts` runs `check` (or `typecheck` and `lint`) and `full` runs `check` and `test`; if none is allowed it fails with the allowed script names. Script results use the same `success`/`failure`/`skipped` items as `run_package_scripts_batch`. An unknown `level` is rejected.
- **Script arguments:** `run_package_scripts_batch` accepts `{ script, args }` items. Arguments are appended after `--` and are only accepted for scripts listed in `scripts.argumentScripts` in the profile (for example `["test"]` to run one test file).

`codegraph_explore` is only advertised when CodeGraph is installed and the current project has a readable `.codegraph/codegraph.db` index. Other CodeGraph tools are not forwarded.

Batch command operations execute sequentially and stop at the first failed command. Every tool result carries **one** representation: a `content` text block with the compact JSON payload (or the rendered line-range text for `read_range`). Results are not duplicated in `structuredContent`, and tools do not advertise an `outputSchema` or a `title`, because both are paid for on every model request.

## Command execution policy

Package scripts and other executables use separate allowlists. An executable not in the configured allowlist is rejected, and configured `blacklistedCommands` prefixes override the allowlist. Commands are launched without a shell.

Agent Dir is not a security boundary against a hostile agent; see `SECURITY.md`. Built-in argument-aware guardrails (global-option-aware blacklist matching, git/package-manager/gh/rg/find rules) and protected paths for `apply_changes` reduce accidents and common bypasses, and are configurable per profile (`commandPolicy`, `protectedPaths`).

### Argument validation and errors

Arguments are validated against the advertised `inputSchema` before the tool runs. An unknown argument is rejected with the valid names (`Unknown argument 'nope'. Valid arguments: path, startLine, endLine, ranges, maxBytes.`), and type, `enum`, `minimum`/`maximum`, `minLength`/`maxLength`, `minItems`/`maxItems`, `required` and `anyOf` are enforced, so a mistake names the argument instead of surfacing as a coercion artefact inside the tool.

Rejections return a normal tool result with `isError: true` and a single JSON text block (`{"error": "..."}`) rather than a protocol error, so the calling agent sees the message and can correct the call in the same turn. Calling an unknown tool returns `isError` too, with close matches when there are any (`Unknown tool: read_rang. Closest tools: read_range.`).

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

## Agent instructions and Skills

One capability model is generated per request and rendered by every discovery surface, so `initialize`, `server/discover`, the capabilities resource and `project_context` cannot disagree:

- `initialize` and `server/discover` return the same short decision table as `instructions` (sub-700 characters), conditioned on which integrations are actually available. Set `AGENT_DIR_GUIDANCE=terse` for a single-paragraph variant; the variant is recorded in telemetry so the two can be compared (see `docs/telemetry.md`).
- `server/discover` also returns the full model as `capabilityModel` (and the CodeGraph status as `codeGraph` for compatibility).
- `project_context` includes the model's `efficiency` block, so an agent that never calls `discover` still sees the same preferred workflow and anti-patterns.

The Resources primitive exposes:

```text
agent-dir://instructions
agent-dir://capabilities
```

The capabilities resource returns the same model as JSON: version, advertised tool names, per-integration status and detail, execution policy, and preferred/avoid tool-selection patterns. The instructions resource returns a long form of the same policy for clients that want more detail than the short table.

Agent Dir implements the stable MCP Skills extension (`io.modelcontextprotocol/skills`) and discovers project-local `SKILL.md` files under:

```text
skills/
.agents/skills/
.claude/skills/
.github/skills/
```

Skills are exposed through `skills/list`, `skills/get`, `resources/list`, and `resources/read`. Skill manifests are bounded to 512 resources and 16 MiB. Binary supporting files are returned as MCP blobs; `resources/directory/read` lists direct children of a skill resource directory.
