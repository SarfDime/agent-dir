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
enveloping, guidance rendering, capability modelling and telemetry glue in one file. Being split (P-10).

**C-02. One test is coupled to the working tree.** `configured package scripts work with the filtered
environment` runs the repository's own `npm run check` and `npm run format:check`, so it fails whenever the
tree has unformatted files and cannot pass mid-edit. Move it to a temporary fixture project (P-12).

**C-03. Coverage is 62.28% lines, 75.89% branches, and nothing enforces it.** No coverage script in
`package.json`. The untested area is concentrated in error handling, which is where the failure paths above
live (P-12).

**C-04. Type strictness is already strong.** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noUnusedLocals` and `noUnusedParameters` are on and an extra `tsc` run over the tree reports nothing. The
remaining code debt is structural (C-01), not per-file.

**C-05. Error classification was still string matching.** Open item O-2.09; it matters because the failure
table above is built from those categories.

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
| O-2.09 | P1 | M | Typed error classes instead of message matching. The six main classes are classified first, mostly by matching our own strings. Adopted for `apply_changes` (`ToolFailure` with `patch_text_not_found`, `patch_ambiguous`, `path_not_found`) and tool failures record a machine-readable `errorReason`. | Typed reasons for the command and integration tools; `read_range` reasons landed in P-02. |
| O-2.05 | P2 | M | Streaming analytics reader. Retention, filtering, side-effect-free reads and `prune` are in place; `telemetry_analytics` still loads filtered files into memory, bounded by the retention cap. | Measure analytics latency above ~1 s on a large store, then stream. Without that measurement it is speculative. |
| O-2.11 | P3 | S | Asynchronous telemetry appends. Directory creation and chmod already happen once per file; appends are still synchronous. | A measured latency effect, or an explicit decision to trade durability for speed. |
| O-4.11 | P3 | M | Watcher-based file index. The 2 s cached file list is in place. | A large-repository measurement that justifies the invalidation complexity; none exists. |
| O-6.03 | P1 | S | Behavioural re-baseline. Structural metrics are done; the numbers above mix builds. | One aggregation on a window produced only by the current build, comparing `toolSetHash` first. Run it **after** the refactor branch is released, since that branch changes the tool list. |
| O-4c-1 | P1 | M | Ignored trees are invisible to `search_code` and `find_files`. **Decided 2026-11-06:** no `includeIgnored`; `read_range` and `rg --no-ignore` stay the routes to a known ignored path. | State the boundary in `docs/MCP.md` and `docs/CONFIGURATION.md`, and make the `search_code` empty-result note name the ignored directory when `paths` points into one. |
| O-4c-2 | P2 | S | `git grep` and `git log -S` bypass the removal of shell search commands while `git` stays allowed. **Decided 2026-11-06:** document only, no default rule. | Document the optional `denySubcommands` / `denyOptions` snippet with a test that it parses and denies `git grep`. |
| O-4c-3 | P2 | S | Several unrelated patterns needed several round trips. | **Closed:** `queries: string[]` (up to 5), one labelled group each, `maxBytes` split between them. |
| O-4c-4 | P3 | S | `docs/CONFIGURATION.md` still shows `--command grep,find,rg,git`, contradicting the recommendation to drop them. | Replace the example with the recommended set and point at the optional `git` rule. |

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

Branch `feature/mcp-refactor`, branched from `main`. `npm run check` and `npm test` pass after each commit;
the final pass count was not captured.

| Commit | Subject | Item |
| --- | --- | --- |
| `2ef2e6a` | `feat!: remove the validate tool` | P-15 |
| `96b3bcd` | `fix(validation): check an object's own properties after an anyOf match` | P-01 |
| `cefde1f` | `refactor(mcp): move argument validation into src/validation.ts` | P-10, first extraction |

Diff against `main`: 12 files changed, 384 insertions, 703 deletions.

| Item | Status | Notes |
| --- | --- | --- |
| P-00 | Open | Re-baseline only after this branch is released; three commits change `toolSetHash`. Same work as O-6.03. |
| P-01 | **Done** | See below. |
| P-02 | **Done** | `read_range` failures use `ToolFailure` reasons and classify as `invalid_input`; regression coverage verifies all four reasons. |
| P-03 | **Done** | Exported `closestPathHint` now suggests bounded project-relative paths in `read_range`, `file_info`, and empty `find_files` results; traversal paths receive no hint. |
| P-04 | **Done** | Successful package scripts return the last 20 lines by default; `maxBytes` returns full output up to its cap. |
| P-05 | **Done** | `search_code` wraps single-string `paths`, `globs` and `queries`; `maxBytes` truncation includes bounded per-file counts for unreturned matches. |
| P-06 | **Done** | `okExitCodes` is accepted at the batch level as a default; item-level values override it, with regression coverage. |
| P-07 | **Done** | Expected `GET /mcp` 405s no longer count as HTTP errors; type-mismatch telemetry records allowlisted argument names and JSON types; analytics summaries count MCP requests by method. |
| P-08 | **Done** | Summary defaults to compact rates, top issues and a bounded per-client split; `view=full`, failure grouping and `excludeClients` are covered by tests. |
| P-09 | **Done** | Bounded per-session read history uses hashed path keys in memory, notes overlaps, supports opt-in unchanged-repeat stubs, and invalidates after `apply_changes`. |
| P-10 | **Partial** | `validation.ts` extracted. Remaining: `classify-errors.ts`, `analytics-format.ts`, one handler module per tool. `src/mcp.ts` is 2,871 lines (was 3,153); target under ~1,200. |
| P-11 | Open | Unblocked: validation extraction landed. |
| P-12 | Open | |
| P-13 | **Decided** | Decisions in section 5; docs pending. |
| P-14 | Open | Gated on P-05 and P-06, which change schema text. |
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
unknown-tool hint at `src/mcp.ts` ~1237, which points at `run_package_scripts_batch` and has a test. Docs
updated: `docs/MCP.md`, `docs/MIGRATION.md` (removed in 3.0), `skills/agent-dir-tools/SKILL.md`.

**The major bump depends on the merge method.** semantic-release reads the squash message. If the PR is
squash-merged, that message must be `feat!:` with a `BREAKING CHANGE:` footer, or the removal ships as a
patch/minor. Merging with commits preserved avoids it. Never hand-bump the version or tag.

### Remaining work packages

**P-00. Single-build re-baseline (O-6.03, no code).** Confirm which build each profile runs now (scriptr
reported `agentDirVersion` 2.1.0 on Nov 2-3 while `package.json` is 2.2.0), then re-run the aggregation on a
window from the current build only, comparing `toolSetHash` first, and replace section 1.

**P-02. Typed errors for `read_range` (part of O-2.09, C-05).** `read.ts` throws plain `Error` for a range
over 2,000 lines, "is not a file", binary file and over 20 MB, which classify as `execution/other`. Use
`ToolFailure` with `range_too_large`, `not_a_file`, `binary_file`, `file_too_large`, added to
`TELEMETRY_ERROR_REASONS` in `src/telemetry/types.ts` and to the privacy allowlist, mapped to `invalid_input`
where the caller can correct the call. `fix(read):` (patch). Done when no `read_range` failure lands in
`execution/other`, with a regression test per reason.

**P-03. "Did you mean" outside `apply_changes`.** Export `closestPathHint` and use it in `read_range`,
`file_info` and `find_files` empty results. Hints stay inside the project root and are bounded.
`feat(files):` (minor). Test covers a path that would escape the root (no hint, no leak).

**P-04. Successful batch output: keep the tail.** `applyOutputBudget` (`src/tools/batch.ts`) keeps the head
of successful output; for lint, typecheck and test runs the useful line is at the end, so a clean run reports
`truncated: true` and gets re-run. Return status plus the last ~20 lines by default, full output through
`maxBytes`, and set `truncated` only when something that matters was cut. Add a `shortcut:` comment for the
512 KB capture in `commands.ts`, or keep head and tail. `feat(batch):` (minor). Done when a passing
`run_package_scripts_batch` is a few hundred bytes with `truncated: false`.

**P-05. `search_code` leniency and truncation footer.** Accept a single string for `paths`, `globs`,
`queries` and wrap it. When truncated at `maxBytes`, append per-file match counts for the remainder (path and
count only) so the next call can target the right file. `feat(search):` ×2 (minor). Done when string inputs
work and the truncated rate target is met.

**P-06. `run_command_batch` top-level `okExitCodes`.** Accept it as the default for every item, an item's own
value winning, and declare it in the schema. `feat(commands):` (minor).

**P-07. Telemetry correctness.** Count `GET /mcp` 405 as expected rather than an error. On `type_mismatch`,
record the argument name and the received JSON type (never the value) via the privacy allowlist in
`src/telemetry/privacy.ts`. Add per-method request counts to the summary (1,742 MCP requests vs 514 tool
calls on scriptr). Add the instrumentation gaps in section 8. `fix(telemetry):` plus `feat(telemetry):`;
update `docs/telemetry.md`.

**P-08. `telemetry_analytics` output size.** Compact default (rates, top issues, per-client split), a `view`
or `sections` option for full tables, run-length encoding of repeated identical failures (`event`, `count`,
`first`, `last`), and a client exclusion option. `feat(telemetry):` (minor). Done when the default summary for
the Nov 6 window fits in ~2k tokens.

**P-09. Repeated and overlapping reads (R-E04).** Bound the expectation: 14% of reads repeat a file, at most
~7% of all output tokens if every one were skipped. Design: per-session map of
`path key -> {mtime, size, ranges, call index}`, capped (for example 200 entries, LRU), memory only, no
content stored. Default stays "content plus one note line"; the stub is only when the caller opts in (for
example `skipIfUnchanged: true`), because most repeats are re-reads after context compaction. Invalidate on
mtime or size change and after any `apply_changes` on that path. `feat(read):` (minor). Risks: bounded
session growth; path keys must not be logged (use the existing fingerprint hashing).

**P-10. Decompose `src/mcp.ts` (C-01).** Remaining extractions, one `refactor:` PR each, no behaviour change,
tests green before and after: `classify-errors.ts` (with the P-02 reasons), `analytics-format.ts`, then one
handler module per tool under `src/tools/` registered through a table instead of a growing `switch`. Branches
`feature/mcp-extract-analytics`, `feature/mcp-tool-handlers`. Done when `mcp.ts` is routing and envelope code
only.

**P-11. Reduce read volume through guidance, measured.** 55 search-then-read transitions and 126 reads of 41
to 200 lines suggest agents read around a hit instead of using `context`. Use the existing guidance-variant
mechanism (`docs/telemetry.md`) to test a one-line hint in the `search_code` footer against the current text
and compare read-span buckets. An experiment, no behaviour change. `feat(guidance):`.

**P-12. Tests and coverage (C-02, C-03).** Move the working-tree-coupled test to a temporary fixture project
with a stand-in script. Add a coverage script and report it in CI; confirm the Node 24 flag before wiring it,
and target the error paths behind the failure classes above. Optional: quote the glob in the `test` script.
`test:` and `chore(ci):`.

**P-13. O-4c docs.** State the ignored-tree boundary in `docs/MCP.md` and `docs/CONFIGURATION.md`; replace the
`--command grep,find,rg,git` example and document the optional `git` rule with a test that it parses and
denies `git grep`. `docs:` and `test:`.

**P-14. Trim tool descriptions and schema text.** Measure first with a small script that reports bytes per
tool split into name, description, schema and parameters (descriptions are ~3.5 KB of the 11.7 KB list).
Cut result-shape restatements and duplicated parameter notes; keep the sentences that steer behaviour. Start
from these targets: `search_code` 690→270, `codegraph_explore` 470→220, `run_command_batch` 400→220,
`read_range` 365→175, `run_package_scripts_batch` 545→200, `find_symbol`/`find_references` 265/235→150,
`find_files` 230→150. ~1.4 KB, about 650 tokens once per session: cheap and low-risk, not the main lever.
Descriptions steer behaviour, so compare read and search patterns before and after via `toolSetHash`. Dropping
schema parameters is breaking (`additionalProperties: false`); check `argShape` and defer to a `feat!:`
release. `feat(tools):` (minor). Ships after P-05, P-06 and P-15.

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
| `mcp.ts` lines | 3,153 (now 2,871) | under ~1,200 |
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

1. P-00 after the refactor branch is released; in parallel P-02, P-06, P-07. (P-01 and P-15 are done.)
2. P-03, P-04, P-05, P-08.
3. P-09 and P-11 now that the validation extraction has landed; P-10 continues alongside.
4. P-14 after P-05 and P-06; P-12 and P-13 any time; each PR carries its own regression test.
5. After each release, re-aggregate on the new build only and update section 1.

## 10. Checked and left alone

- **`tools/list` size:** a once-per-session cost, not the lever (F-01). P-14 exists because the trim is cheap,
  with the saving stated honestly. The 60 s polling client is a client problem.
- **`apply_changes`:** status-only results (36 to 141 tokens), 90% success for the real client, patch
  errors carry closest-line hints. The failure rate is the legacy extension.
- **Request body cap, auth, tunnel:** 10 MiB cap present, 3 auth failures all week, one tunnel disconnect.
- **Latency:** `read_range` ~0.6 ms, `search_code` ~49 ms average (p95 ~154 ms), commands 100% successful.
- **Streaming analytics reader (O-2.05), async telemetry appends (O-2.11), watcher-based index (O-4.11):**
  speculative without a measured latency problem.
