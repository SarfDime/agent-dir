---
name: agent-dir-tools
description: Use an Agent Dir MCP server correctly and cheaply. Covers which tool answers which question, the exact argument shapes the server validates, how to read its bounded output, and how to fix a rejected call in the same turn instead of retrying it verbatim.
---

# Using Agent Dir

Agent Dir exposes one project over MCP: bounded file access, search, edits, allowlisted commands and
validation. It validates arguments before running a tool and bounds every result, so most mistakes come back
as a correctable message rather than a failure. Read those messages; do not resend the same call.

## Non-negotiables

- **Plain JSON arguments only.** No base64, no escaped envelope, no `_raw`, no `content_encoding`. Quotes and
  newlines in strings are ordinary JSON escapes (`"line1\nline2"`, `"he said \"hi\""`).
- **You are inside one project root.** Every path is project-relative. `../` is rejected.
- **No shell.** Commands run without a shell: no pipes, redirection, `&&`, globbing or `$VAR`. Use one command
  per batch item, and the dedicated tools where one exists.
- **Only allowlisted executables and scripts run.** A rejection means the profile does not allow it; do not try
  variants of the same command to get around it.
- **Protected paths are not editable:** `.git/**`, `.env*`, `.npmrc`, plus whatever the profile adds.
- **Every result is bounded and says so.** When a result reports `truncated`, narrow the request. Re-running the
  same call returns the same cut.

## Pick the tool by question

| Question | Tool | Not this |
| --- | --- | --- |
| What is this project, and what may I run? | `project_context` | `ls`, `cat package.json` |
| Where is file X? | `find_files` | `find`, `ls` |
| Where is text Y? | `search_code` | `grep`, `rg` |
| What are the lines around a hit? | `search_code` with `context: 2` | `search_code` then `read_range` |
| Show me code | `read_range` | `cat`, `sed -n` |
| Where is symbol X defined? | `find_symbol` | `search_code` on every guess |
| Who calls X? | `find_references` | `search_code` per call site |
| How does this subsystem work? | `codegraph_explore` when advertised | many `search_code` + `read_range` loops |
| Change files | `apply_changes` | `sed -i`, `tee`, heredocs |
| Does it compile or pass? | `validate` | guessing, or a full test suite for a typo |
| Run a project script | `run_package_scripts_batch` | `npm run …` through `run_command_batch` |
| Run git or another allowlisted binary | `run_command_batch` | shell pipelines |
| What happened across sessions? | `telemetry_analytics` when advertised | guessing |

## Argument shapes that are actually validated

`search_code`

```json
{"query": "sanitizeAnonymousEvent", "paths": ["src"], "globs": ["!**/*.test.ts"],
 "context": 0, "caseSensitive": false, "regex": false, "multiline": false,
 "includeGenerated": false, "format": "text", "maxResults": 50, "maxBytes": 8000}
```

`queries` (up to 5) replaces `query` for several patterns in one call, one labelled group each. Output is
grep-style text:

```
3 matches in 2 files (ripgrep)
src/a.ts:143:17 export function sanitizeAnonymousEvent(...)
src/a.ts:179:12   event: sanitizeAnonymousEvent(event),
note: More than 3 matches exist; narrow with paths/globs or raise maxResults.
```

`path:line:col text`, `path:start-end:col text` for a multi-line match, `  | line` for context, `note:` for
anything you need to know. Match the text you see; do not re-derive it.

`read_range` — `{startLine, endLine}` (or `ranges: [{startLine, endLine}, …]`) are required, `path` alone is
rejected. Watch `nextStartLine` and `truncated` to continue instead of re-reading.

`apply_changes` — atomic, all-or-nothing, returns only per-file status (`{items, dryRun}`), never file contents.

```json
{"dryRun": true, "changes": [
  {"kind": "patch", "path": "src/config.ts",
   "patches": [{"search": "const limit = 10;", "replace": "const limit = 20;"}]},
  {"kind": "write", "path": "docs/new.md", "content": "# Title\n\nBody.\n"},
  {"kind": "delete", "path": "docs/old.md"}
]}
```

`search` must match the file byte for byte, including indentation. `count` lets one patch replace N identical
occurrences. Send `dryRun: true` first for anything you cannot verify from a fresh `read_range`.

`run_command_batch` — `{"commands": [{"command": "git", "args": ["status", "--short"]}], "onError": "continue",
"maxBytes": 8000}`. Every item reports `status` (`success` / `failure` / `skipped`), `ran`, `exitCode`, and
`stdout`/`stderr`; nothing is ever “maybe ran”.

`validate` — `{"level": "diagnostics" | "scripts" | "full", "scripts": ["check"], "maxBytes": 8000}`. The result
carries `diagnostics.summary` (counts by severity, affected files) and `diagnostics.byFile`; the flat
`diagnostics.issues` list is present only when it fits.

## When a call is rejected

Rejections come back as a normal tool result with `isError: true` and a message written to be acted on in the
same turn. From the message:

| Message | Do this |
| --- | --- |
| `Unknown argument 'x'. Valid arguments: …` | Use the listed names exactly. |
| `…whole argument object was sent as one string…` | Send the argument object itself, not a wrapper key. |
| `There is no base64 option` | Send plain JSON with normal escapes. |
| `'x' is required` / `must be an array` / `must be one of …` | Fix that one field; the type and the allowed values are in the message. |
| `Patch text was not found in 'f'. Closest lines: …` | `read_range` that range, copy the text exactly, and include more context. |
| `Patch text occurs N times in 'f'` | Add surrounding context so it matches once, or set `count`. |
| `'f' does not exist. Did you mean 'g'?` | Use the suggested path; do not guess another. |
| `Unknown tool: x. Closest tools: …` | Call one of those; the tool list changed or the name was invented. |
| `…is not allowed by this profile` | That executable or script is out of scope. Do not retry variants. |
| `'x' is a protected path` | Edit it yourself; the agent may not. |

## Spend less

- Search before reading. Read a range, not a file. `context` on the search is cheaper than a follow-up read.
- Batch independent work into one call: `ranges` for several spans of one file, several commands in one batch,
  several patterns in one `queries` call.
- Never repeat a call that already succeeded, and never repeat one that was truncated — narrow it instead.
- Keep `maxResults` small until you know the answer is not in the first few hits. Prefer `paths`/`globs` to
  scope over raising limits.
- Stop when the question is answered. A second confirmation call is a cost, not diligence.
- When a tool reports `incomplete` or `truncated`, say so in your summary rather than implying full coverage.

## Wrong turns that look right

- Reading a whole file to find one function (use `find_symbol`, then a range).
- Re-running `search_code` with the query lightly reworded after a zero-result search (read the note: literal
  vs regex, case sensitivity, generated files skipped, scope).
- Sending `changes` as a JSON *string* instead of an array.
- Patching text you remember instead of text you just read.
- Using `run_command_batch` for something a dedicated tool does, then parsing its stdout by hand.
- Running the full validation suite after a one-line edit when `validate` at `diagnostics` answers the question.
