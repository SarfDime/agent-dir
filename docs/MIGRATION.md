# Migrating to Agent Dir 2.0

Agent Dir 2.0 lands the changes from the efficiency and reliability audit. Everything below is
user-visible; nothing else about the authentication model, project-root confinement, command
allowlists or non-shell execution changed.

## Tool set

| Change | Replacement |
| --- | --- |
| `serena_*` tools removed | `find_symbol`, `find_references`, `search_code`, `read_range`, `apply_changes` |
| `ast_grep_search` removed | `search_code` (now with `multiline`) or `codegraph_explore` for structural questions |
| `run_npm_batch` renamed | `run_package_scripts_batch` (no alias) |

An Agent Dir instance now advertises 11 tools, plus `codegraph_explore` when the project is indexed
and `telemetry_analytics` when started with `--analytics`. Prompts or agent instructions that name
`serena_find_symbol`, `serena_find_referencing_symbols`, `ast_grep_search` or `run_npm_batch` must be
updated.

## Tool results

Each result carries **one** representation: a `content` text block with the compact JSON payload, or
the rendered line-range text for `read_range`. `structuredContent` is gone, and tools no longer
advertise `outputSchema` or `title`. This removed a duplicate copy that was billed on every request
and took `tools/list` from 29.2 KB to 11.85 KB.

```diff
- const payload = result.structuredContent;
+ const payload = JSON.parse(result.content[0].text);
```

Errors keep `isError: true`, with the message now a JSON text block (`{"error": "..."}`) instead of a
second `structuredContent` copy. Invalid arguments are rejected before the tool runs, and the message
names the argument:

- `Unknown argument 'nope'. Valid arguments: path, startLine, endLine, ranges, maxBytes.`
- `'timeoutMs' must be at least 1000.`
- `Unknown tool: read_rang. Closest tools: read_range.`

Result sizes respect `maxBytes` end to end (1.01–1.13x of the requested budget, previously
1.84–2.08x).

## Result shapes per tool

| Tool | Result |
| --- | --- |
| `search_code`, `find_symbol`, `find_references` | `{ items, returned, truncated, truncationReason?, backend, incomplete?, notes? }` instead of a bare array |
| `find_files` | `{ items, truncated }` |
| `apply_changes` | `{ items, dryRun }` (per-file status only, never contents or diffs) |
| `read_range` | Plain text with a header plus `eof`, `totalLines`, `nextStartLine`; 16 KB default; `ranges: [...]` for several ranges |
| `validate` | `{ level, ok, diagnostics, scripts?, scriptsRequested, truncated, note? }` |
| `run_command_batch`, `run_package_scripts_batch` | `{ ok, onError, summary, items, truncated }` with a per-item `status` |

`search_code` also gained `multiline` (patterns can span lines; identical on the ripgrep and built-in
backends) alongside the existing `paths`, `globs`, `context`, `caseSensitive` and `includeGenerated`.

## Batch semantics

Every item reports exactly one `status` (`success`, `failure` or `skipped`) plus `ran` and, when not
successful, a `reason`, so an agent never has to infer whether a command ran.

- `onError` defaults to `continue` for `run_command_batch` and `stop` for `run_package_scripts_batch`.
- The whole batch is validated before anything runs; in `stop` mode a rejected item means nothing runs.
- `okExitCodes` (for example `[0, 1]` for `rg` or `grep`) marks a normal non-zero exit as success.
- `timeoutMs` (1000–600000) applies per item; a timeout keeps the partial output and earlier results.

## Configuration

| Key | Change |
| --- | --- |
| `npm.allowedScripts` | Moved to `scripts.allowedScripts`, with `packageManager` for the manager. An old profile is migrated in memory with a warning. |
| `tools.disabledSets` | `serena` and `ast_grep` no longer exist and are stripped with a warning. Supported sets: `codegraph`, `analytics`, `filesystem`, `search`, `commands`. |
| `tools.disabled` | Entries such as `serena_find_symbol` or `ast_grep_search` are stripped with a warning. |
| `blacklistedCommands` | Matched against normalized subcommands, so `git -C x push` and `npm --prefix x publish` are blocked like `git push`. Prefix entries keep working. |
| `commandPolicy`, `protectedPaths` | New per-profile guardrails for argument rules and for paths `apply_changes` may not write. |

Remove the obsolete keys after the first start to silence the warnings.

## Discovery and instructions

`initialize` and `server/discover` now return the same short decision table (under 700 characters),
conditioned on which integrations are available. The long form stays available as the
`agent-dir://instructions` resource.

`server/discover` additionally returns `capabilityModel` (and `codeGraph` for compatibility), and
`project_context` now includes the same `efficiency` block, so an agent that never calls `discover`
still sees the preferred workflow and the anti-patterns to avoid.

## Upgrading

1. Install 2.0 and start Agent Dir once; profile migration warnings are expected and harmless.
2. Remove `serena_*`, `ast_grep_search` and `run_npm_batch` from saved prompts and agent instructions.
3. If you read `structuredContent`, switch to `content[0].text`.
4. If you size responses with `maxBytes`, results now fit the budget instead of roughly doubling it.
5. Confirm the advertised set: `tools/list` should be about 11.9 KB with every optional integration
   enabled, and `tools/list` telemetry now records `toolCount` and `toolSetHash` so size changes can
   be attributed to a tool appearing or disappearing.
