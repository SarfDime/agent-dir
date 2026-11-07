# Agent Dir: audit, open items and refactor plan

One file for everything audit-related: the cost baseline, the findings behind it, what is still open, the
decisions already taken, and the per-item plan for the current refactor pass. It merges and replaces
`AUDIT-EFFICIENCY.md` (2026-10-29) and `AUDIT-PROGRESS.md`, whose open items and findings are carried over
below.

Status marks: **Done**, **Partial**, **Open**, **Decided** (decision recorded, work pending), **Deferred**.

## 1. Baseline and method

Two windows are folded in here. Neither is a regression baseline on its own; item O-6.03 asks for one.

| Window | Source | Shape |
| --- | --- | --- |
| 2026-10-29 audit | local store, 4 profiles, 95 sessions, 8,975 events, 2,390 tool calls, versions 1.1.1 to 1.3.0 | mixes builds; bytes measured, tokens estimated at 4 B/token |
| 2026-11-06 telemetry | 8,658 events, 3 profiles (scriptr, tontine, agent-tunnel), ~908 tool calls; tool-level numbers from `Anthropic/ClaudeAI@1.0.0` only (486 calls, ~95% success) | mixes builds; the Nov 6 read below |

Wire measurements in the 2026-10-29 audit come from the built server driven over real HTTP at protocol
`2026-07-28`, so they include JSON-RPC framing and `_meta`.

**Noise excluded** from the Nov 6 window: a client polling every 60 s (`tools/list` 11.7 KB,
`resources/list`, `GET /mcp` returning 405) and a legacy extension sending malformed `apply_changes`
arguments. Neither is an Agent Dir problem.

### Where the cost is (2026-10-29 window, tool-result bytes, 12.05 MB total)

| Tool | Calls | B/call | Share of bytes | p50 ms | p95 ms |
| --- | --- | --- | --- | --- | --- |
| `read_range` | 859 | 8,103 | 58% | 1 | 2 |
| `run_command_batch` | 438 | 6,001 | 22% | 43 | 25,615 |
| `search_code` | 299 | 4,066 | 10% | 16 | 105 |
| `project_context` | 30 | 5,138 | 1% | 16 | 98 |
| `validate` (removed) | 19 | 7,259 | 1% | 4,667 | 26,700 |
| `codegraph_explore` | 15 | 5,724 | 1% | 378 | 1,603 |
| `apply_changes` | 442 | 591 | 2% | 15 | 57 |
| `find_files` | 88 | 1,328 | 1% | 6 | 14 |
| `file_info` | 20 | 526 | 0% | 0 | 1 |
| `telemetry_analytics` | 11 | 10,862 | 1% | 28 | 67 |

Per session: median 50.8 KB (~13k tokens), p95 533.7 KB (~133k), max 1.88 MB (~470k). Two tools produce 80%
of it; `read_range` alone produces 58%.

Surface health, same window:

| Signal | 2026-10-29 | 2026-11-06 |
| --- | --- | --- |
| `search_code` returned nothing | 63 of 299 (21%) | — |
| `search_code` errors | — | 10.4% (14 of 135) |
| `search_code` truncated | — | 29.6% (40 of 135) |
| `find_files` returned nothing | 10 of 88 (11%) | 6 of 32 (18.8%) |
| `apply_changes` failed | 12% (39 `not_found`, 10 `execution`, 2 `invalid_input`) | legacy extension |
| `validate` truncated | 47% | 3 of 3 on agent-tunnel |
| `telemetry_analytics` truncated | 45% | 43% on agent-tunnel |
| `codegraph_explore` truncated | 27% | — |
| Identical repeated calls in one session | 102 of 2,390 (4%) | 26 of 185 repeated-file reads (14%) |
| `run_command_batch` policy denials / `unknown_argument` | 7 | 2 of 51 `unknown_argument` |
| `httpErrors` | — | 107, mostly `GET /mcp` 405 |
| `src/mcp.ts` | 2,806 lines | 3,153 lines (then 2,871 after the extraction) |

Nov 6 signals not in the earlier table: `read_range` was 48.5% of output tokens (185 calls, median 111
lines, 92 read-to-read transitions); `search_code` was 32% of tokens; clean `run_package_scripts_batch`
runs were flagged truncated 2 of 5 times on agent-tunnel; `telemetry_analytics` cost 2.5k to 4.6k tokens per
call.

### Fixed surfaces (measured at build time)

| Payload | Size | Composition |
| --- | --- | --- |
| `tools/list` | 11,135 B, 12 tools | schemas 5,980 B (54%), descriptions 3,461 B (31%), names and hints 1,694 B |
| `initialize` | 833 B | instructions 641 B |
| `server/discover` | 2,378 B | instructions + capability model + CodeGraph status |
| `search_code` result, 10 matches | 1,709 B | matched text 970 B, JSON scaffolding 739 B (43%) — now text-rendered |
| `read_range` result, 40 lines | 1,617 B | raw lines 1,317 B, header 45 B, framing 228 B |
| `_meta` per tool result | 84 B | removed |

### Confirmed by probe, not inferred

- `search_code` with `queries` sent as a string answered `'query' is required.` — the wrong branch was
  reported.
- `search_code` with `context: 6` answered with the tool-level `context must be an integer between 0 and 5.`
  instead of the schema-level `'context' must be at most 5.` — the schema check was skipped.

Both are fixed (P-01 below).

## 2. Findings

**F-01. `tools/list` is not the lever.** 11,135 B for 12 tools, down from 29,206 B, fetched about once per
session (97 calls across 95 sessions). Even at 23 KB it was roughly a fifth of one session's tool bytes.
Trimming descriptions saves ~3 KB once per session. Do not re-litigate this as if it were the main cost.

**F-02. `read_range` is the lever, and it is the agent's choice, not a bug.** Nothing in the tool is
wasteful: it refuses to dump a whole file, the text form is plain, there are no line-number columns. The
cost is that agents read large spans after a search hit instead of searching with `context`.

**F-03. Search results spent 43% of their bytes on JSON keys.** Fixed by text rendering (R-E02).

**F-04. Empty results said nothing.** 21% of searches and 11% of `find_files` calls returned 68 B of
`{"items":[]}`, leaving the agent to guess whether the term was absent, the glob wrong, the path out of
scope, or the file ignored. Fixed (R-E01).

**F-05. `apply_changes` is cheap per call and expensive per failure.** 591 B per call, 12% fail, `not_found`
was 39 of 53 failures. Fixed for the closest-path hint (R-E05).

**F-06. `validate` was slow and then truncated anyway.** 47% truncated, p50 4,667 ms, p95 26.7 s. The tool
itself has since been removed (P-15); the summary-shaped default landed first (R-E06).

**F-07. 4% of calls repeat an identical earlier call in the same session.** Residue of agents re-reading
after context compaction. Cheap to absorb, not free to fix (P-09).

**F-08. Every tool result used to carry 84 B of redundant `_meta`.** About 200 KB over the window, 24% of
the `file_info` payload. Removed (R-E08).

**C-01. `src/mcp.ts` was 2,806 lines** (3,153 by November). Tool table, argument validation, dispatch, result
enveloping, guidance rendering, capability modelling and telemetry glue were consolidated in one file.
P-10 extracted those responsibilities; the router is now 976 lines.

**C-02. One test is coupled to the working tree.** `configured package scripts work with the filtered
environment` runs the repository's own `npm run check` and `npm run format:check`, so it fails whenever the
tree has unformatted files and cannot pass mid-edit. Move it to a temporary fixture project (P-12).

**C-03. Coverage is 62.28% lines, 75.89% branches, and nothing enforces it.** No coverage script in
`package.json`. The untested area is concentrated in error handling, which is where the failure paths above
live (P-12).

**C-04. Type strictness is already strong.** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noUnusedLocals` and `noUnusedParameters` are on and an extra `tsc` run over the tree reports nothing. The
P-10 extraction addressed the structural concern in C-01; no further `src/mcp.ts` split is currently planned.

**C-05. Error classification used string matching.** O-2.09 now gives command and integration failures
typed categories and safe reasons; message matching remains only as a compatibility fallback.

## 3. Recommendations from the 2026-10-29 audit

| ID | Change | Basis | Effect | Effort | Status |
| --- | --- | --- | --- | --- | --- |
| R-E01 | Explain empty and truncated results: files scanned, match mode, ignore rules, one next step. | F-04 | removes a class of wasted retries; 63 empty searches alone | S | **Done** |
| R-E02 | Render `search_code` results as `path:line:col text` by default, JSON on request. | F-03 | −43% of search bytes; measured 2,028→964 B and 8,643→3,962 B (−52%, −54%) | S | **Done** |
| R-E03 | Record the read span as a bucketed telemetry field. | F-02 | turns the largest cost into a measured question | S | **Done**: `readLines` per call, `efficiency.readSpans` buckets (1-40, 41-200, 201-800, 801+) |
| R-E04 | Note repeated identical calls in the result so the client can skip re-reading. | F-07 | low risk, targets 4% of calls | M | **Done**: overlapping reads add one note; unchanged exact repeats can be omitted with `skipIfUnchanged: true` |
| R-E05 | Suggest the closest existing path on `apply_changes` `not_found`. | F-05 | recovers 39 failures in one turn instead of two | S | **Done** |
| R-E06 | `validate` default: severity and per-file summary plus the first errors per file. | F-06 | removed the 47% truncated case | M | **Done**, then the tool itself was removed |
| R-E07 | `search_code` accepts `queries: string[]` with labelled groups. | O-4c-3 | fewer round trips for multi-pattern work | S | **Done**: two patterns in one call, 1,024 B vs 1,157 B plus a round trip |
| R-E08 | Drop `serverInfo` from per-result `_meta`. | F-08 | −84 B per call, ~200 KB on the window | S | **Done**: `file_info` 347→261 B, `read_range` 1,618→1,532 B |

**Do not do:** shrink `tools/list` further (F-01), re-add output schemas or titles, or remove
`run_command_batch` — 22% of bytes but the only route to git and package managers.

## 4. Open items

| ID | Pri | Eff | What remains | What would close it |
| --- | --- | --- | --- | --- |
| O-2.09 | P1 | M | Typed error classes instead of message matching. Adopted for `apply_changes` and `read_range`; tool failures record a machine-readable `errorReason`. | **Closed:** command preflight, timeout, abort and spawn failures and CodeGraph integration failures use typed categories and allowlisted reasons; regression tests cover classification. |
| O-2.05 | P2 | M | Streaming analytics reader. Retention, filtering, side-effect-free reads and `prune` are in place; `telemetry_analytics` still loads filtered files into memory, bounded by the retention cap. | Measure analytics latency above ~1 s on a large store, then stream. Without that measurement it is speculative. |
| O-2.11 | P3 | S | Asynchronous telemetry appends. Directory creation and chmod already happen once per file; appends are still synchronous. | A measured latency effect, or an explicit decision to trade durability for speed. |
| O-4.11 | P3 | M | Watcher-based file index. The 2 s cached file list is in place. | A large-repository measurement that justifies the invalidation complexity; none exists. |
| O-6.03 | P1 | S | Behavioural re-baseline. Structural metrics are done; the historical windows mix builds. Profiles use whichever build was opened; reports showing older versions are from older sessions, not evidence that current profiles run an old build. | After this branch is released, aggregate a fresh window from the current build only, comparing `toolSetHash` first. No need to verify profile build selection for old sessions. |
| O-4c-1 | P1 | M | Ignored trees are invisible to `search_code` and `find_files`. **Decided 2026-11-06:** no `includeIgnored`; `read_range` and `rg --no-ignore` stay the routes to a known ignored path. | **Closed:** both docs state the boundary, and a scoped empty `search_code` result names a Git-ignored path. |
| O-4c-2 | P2 | S | `git grep` and `git log -S` bypass the removal of shell search commands while `git` stays allowed. **Decided 2026-11-06:** document only, no default rule. | **Closed:** documented the optional `denySubcommands` / `denyOptions` snippet and tested that it parses and denies `git grep`. |
| O-4c-3 | P2 | S | Several unrelated patterns needed several round trips. | **Closed:** `queries: string[]` (up to 5), one labelled group each, `maxBytes` split between them. |
| O-4c-4 | P3 | S | `docs/CONFIGURATION.md` still shows `--command grep,find,rg,git`, contradicting the recommendation to drop them. | **Closed:** replaced the example with `--command git` and pointed at the optional Git rule. |

## 5. Decisions

- **O-4c-1, `includeIgnored`: no.** No evidence of need; empty results cannot be attributed to ignored
  trees. Escape hatches already exist (`read_range` on a known path, `rg --no-ignore`). Every new option is
  schema text in every session, working against P-14. Ignored paths often hold local secrets. Revisit if
  telemetry shows empty searches repeatedly followed by `rg --no-ignore`, or a user asks.
- **O-4c-2, `git grep`: document only.** From `command_call` events, 2026-10-16 to 2026-11-05: 810 batches,
  110 (13.6%) search-only, 15% of batch output bytes, median 3.4 KB, 98.8% success, and the Claude
  search-only share fell from 47% (Oct 16-29) to 17% (Oct 30-Nov 5) as the dedicated tools improved. Not
  proof of harm; telemetry records executable names only, so `git grep` is invisible. Flip to a default rule
  only when, on single-build windows: search-only batches stay under ~5% for two consecutive windows across
  clients; a paired measure shows the shell route costs more calls or tokens; and `git` subcommand usage is
  visible.
- **D-02: an OS sandbox stays a separate future enhancement**, not part of the guardrail model. The allowlist
  is a guardrail, not a security boundary (see `docs/SECURITY.md`).
- **Declined: a tree-sitter or ast-grep symbol index.** Re-adding an AST parser reintroduces the dependency
  this release removed; CodeGraph covers structural navigation where installed. Revisit only with evidence
  that `find_symbol` misses real cases without CodeGraph.

## 6. Refactor plan and progress

Branch `feature/mcp-refactor`, branched from `main`. `npm run check`, `npm test` and
`npm pack --dry-run` passed before each commit; the latest test run passed all 218 tests.

| Commit | Subject | Item |
| --- | --- | --- |
| `2ef2e6a` | `feat!: remove the validate tool` | P-15 |
| `96b3bcd` | `fix(validation): check an object's own properties after an anyOf match` | P-01 |
| `cefde1f` | `refactor(mcp): move argument validation into src/validation.ts` | P-10, first extraction |

Diff against `main`: 12 files changed, 384 insertions, 703 deletions.

| Item | Status | Notes |
| --- | --- | --- |
| P-00 | Open | After this branch is released, aggregate a fresh window from the current build and compare `toolSetHash` first. Older-version telemetry describes old sessions; no per-profile version check is needed. |
| P-01 | **Done** | See below. |
| P-02 | **Done** | `read_range` failures use `ToolFailure` reasons and classify as `invalid_input`; regression coverage verifies all four reasons. |
| P-03 | **Done** | Exported `closestPathHint` now suggests bounded project-relative paths in `read_range`, `file_info`, and empty `find_files` results; traversal paths receive no hint. |
| P-04 | **Done** | Successful package scripts return the last 20 lines by default; `maxBytes` returns full output up to its cap. |
| P-05 | **Done** | `search_code` wraps single-string `paths`, `globs` and `queries`; `maxBytes` truncation includes bounded per-file counts for unreturned matches. |
| P-06 | **Done** | `okExitCodes` is accepted at the batch level as a default; item-level values override it, with regression coverage. |
| P-07 | **Done** | Expected `GET /mcp` 405s no longer count as HTTP errors; type-mismatch telemetry records allowlisted argument names and JSON types; analytics summaries count MCP requests by method. |
| P-08 | **Done** | Summary defaults to compact rates, top issues and a bounded per-client split; `view=full`, failure grouping and `excludeClients` are covered by tests. |
| P-09 | **Done** | Bounded per-session read history uses hashed path keys in memory, notes overlaps, supports opt-in unchanged-repeat stubs, and invalidates after `apply_changes`. |
| P-10 | **Done** | Validation, error classification, analytics formatting, tool definitions/selection, capabilities, telemetry, protocol helpers and the per-tool handler table are extracted. `src/mcp.ts` is 976 lines (was 3,153) and now contains MCP routing and request/envelope wiring. |
| P-11 | **Done** | Added the opt-in `search-footer` guidance variant; telemetry can compare it against the existing table variant using read-span and search-to-read metrics. |
| P-12 | **Done** | Moved the package-script test to a temporary fixture, added `test:coverage` with Node 24, and wired the source-only report into CI. Current `dist/src` coverage: 86.75% lines, 81.08% branches; `classify-errors.ts` is 100% line-covered. |
| P-13 | **Done** | Documented ignored-tree behavior and command boundaries; the optional Git policy example is parsed and tested to deny `git grep`. |
| P-14 | **Done** | With 11 tools (analytics disabled), `tools/list` fell from 11,427 to 8,982 bytes; description text fell from 3,364 to 1,855 bytes. The stable-key `toolSetHash` is unchanged and schema parameters were preserved. |
| P-15 | **Done** | See below. |

### P-01, as shipped

`validateToolArguments` and its helpers (`typeMatches`, `isRecord`) and the wrapper-argument detection now
live in `src/validation.ts` (199 lines); `src/mcp.ts` imports them (~54) and keeps the call site (~785). After
an `anyOf` branch passes, the parent's own properties are validated, so `paths`, `globs`, `context`,
`maxResults` and `maxBytes` are schema-checked. Type errors name the received type
(`'paths' must be an array (got string)`). When no branch matches, the error comes from the closest branch,
so `queries` as a string is no longer reported as a missing `query`, and both-missing reads
`One of 'query' or 'queries' is required`. Regression coverage is `test/argument-validation.test.ts`, asserted
against the schema `search_code` actually advertises.

Done when the next window's `search_code` argument errors are all `isError` results with schema-level
messages; code side done, telemetry side needs P-00.

### P-15, as shipped

`validate` is gone from the tool list: tool definition and handler, `defaultValidationScripts`,
`src/tools/diagnostics.ts`, `test/validate.test.ts`, the `validate` cases in `test/mcp.test.ts`,
`test/modern.test.ts` and `test/protocol-contract.test.ts`, and the `src/logging.ts` entry. No `validate`
reference remains in `src/telemetry/`, `src/logging.ts` or `src/config.ts`; the server `instructions` no
longer contains the old "Check: validate, then a targeted script" sentence; the only remaining text is the
unknown-tool hint, which points at `run_package_scripts_batch` and has a test. Docs
updated: `docs/MCP.md`, `docs/MIGRATION.md` (removed in 3.0), `skills/agent-dir-tools/SKILL.md`.

**The major bump depends on the merge method.** semantic-release reads the squash message. If the PR is
squash-merged, that message must be `feat!:` with a `BREAKING CHANGE:` footer, or the removal ships as a
patch/minor. Merging with commits preserved avoids it. Never hand-bump the version or tag.

### Remaining work

**P-00 / O-6.03.** After this branch is released, aggregate a fresh window from the current build only,
compare `toolSetHash` first, and update section 1. Earlier versions in telemetry are from old sessions; the
profile starts whichever build was opened, and the user reports opening the latest build. Do not spend time
checking each profile or re-aggregating old sessions.

**Measurement-gated, not currently scheduled:** O-2.05 (stream analytics only if large-store latency exceeds
about one second), O-2.11 (async telemetry only with a measured latency effect or explicit durability
trade-off), and O-4.11 (watcher-based indexing only if a large-repository measurement justifies invalidation
complexity).

## 7. Targets

| Signal | Baseline | Target |
| --- | --- | --- |
| `search_code` errors | 10.4% | under 3% |
| `search_code` truncated | 29.6% | under 15% |
| Clean script result flagged truncated | 2 of 5 runs on agent-tunnel | 0 |
| `read_range` in `execution/other` | 4 | 0 |
| `run_command_batch` `unknown_argument` (ClaudeAI) | 2 | 0 |
| `httpErrors` from `GET /mcp` 405 | most of 107 | 0 |
| Default analytics summary | ~9k tokens | ~2k tokens |
| `mcp.ts` lines | 3,153 (now 976) | under ~1,200 (met) |
| `tools/list` size | 11.7 KB (~2.9k tokens) | ~8.5 to 9 KB after P-14 and P-15 |
| `validate` share of calls | 0.8% | 0 (code done) |

Percentage targets are judgment calls, not measured limits; revisit after P-00.

## 8. Instrumentation gaps to close first

1. Read span per `read_range` call — done (R-E03).
2. Whether a client reused a previous `tools/list` response. Every call records `responseBytes`, but a client
   that caches costs nothing after the first. MCP request counts by method (P-07) separate protocol requests
   from tool calls, but do not reveal client-side response caching.
3. Prompt growth versus tool output growth in the same session. Telemetry records tool bytes only, so "the
   agent is expensive" and "the tool returns too much" are not separable from the server side.

## 9. Sequencing

1. After this branch is released, perform P-00/O-6.03 using a fresh single-build telemetry window.
2. Pursue O-2.05, O-2.11 or O-4.11 only if their measurement gates are met.
3. Keep section 1 historical until that new-build window is available; do not infer current profile versions
   from older sessions.

## 10. Checked and left alone

- **`tools/list` size:** a once-per-session cost, not the lever (F-01). P-14 exists because the trim is cheap,
  with the saving stated honestly. The 60 s polling client is a client problem.
- **`apply_changes`:** status-only results (36 to 141 tokens), 90% success for the real client, patch
  errors carry closest-line hints. The failure rate is the legacy extension.
- **Request body cap, auth, tunnel:** 10 MiB cap present, 3 auth failures all week, one tunnel disconnect.
- **Latency:** `read_range` ~0.6 ms, `search_code` ~49 ms average (p95 ~154 ms), commands 100% successful.
- **Streaming analytics reader (O-2.05), async telemetry appends (O-2.11), watcher-based index (O-4.11):**
  speculative without a measured latency problem.
