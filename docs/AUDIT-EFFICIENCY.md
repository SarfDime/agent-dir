# Agent Dir: cost and code audit (2026-10-29)

Second audit, run after the 2.0 tool-surface work landed. It asks two questions: where does an agent's
money actually go now, and what in the code makes that worse than it needs to be. The open items that came
out of the first audit live in `docs/AUDIT-PROGRESS.md`.

## 1. Method

- **Telemetry.** The local store: 4 profiles, 95 sessions, 8,975 events, 2,390 tool calls, versions 1.1.1 to
  1.3.0 at `diagnostic` level. Bytes are measured; tokens are the 4-bytes-per-token estimate used by
  `estimateTokens` and are marked as such.
- **Wire measurements.** The built server, booted through `startServer()` and driven over real HTTP at
  `2026-07-28`, so every number below includes JSON-RPC framing and `_meta`.
- **Caveat.** The window mixes builds. It is the best behavioural data available, but 6.03 (in the tracker)
  asks for a single-build window before any of it is treated as a regression baseline.

## 2. Where the cost is now

Tool-result bytes across the store: 12.05 MB.

| Tool | Calls | B/call | Share of bytes | p50 ms | p95 ms |
| --- | --- | --- | --- | --- | --- |
| `read_range` | 859 | 8,103 | 58% | 1 | 2 |
| `run_command_batch` | 438 | 6,001 | 22% | 43 | 25,615 |
| `search_code` | 299 | 4,066 | 10% | 16 | 105 |
| `project_context` | 30 | 5,138 | 1% | 16 | 98 |
| `validate` | 19 | 7,259 | 1% | 4,667 | 26,700 |
| `codegraph_explore` | 15 | 5,724 | 1% | 378 | 1,603 |
| `apply_changes` | 442 | 591 | 2% | 15 | 57 |
| `find_files` | 88 | 1,328 | 1% | 6 | 14 |
| `file_info` | 20 | 526 | 0% | 0 | 1 |
| `telemetry_analytics` | 11 | 10,862 | 1% | 28 | 67 |

Per session, tool output is median 50.8 KB (about 13k tokens), p95 533.7 KB (about 133k), max 1.88 MB (about
470k). **Two tools produce 80% of it**, and `read_range` alone produces 58%.

Health of the rest of the surface, same window:

| Signal | Value |
| --- | --- |
| `search_code` returned nothing | 63 of 299 (21%) |
| `find_files` returned nothing | 10 of 88 (11%) |
| `apply_changes` failed | 12% (39 `not_found`, 10 `execution`, 2 `invalid_input`) |
| `validate` truncated | 47% |
| `telemetry_analytics` truncated | 45% |
| `codegraph_explore` truncated | 27% |
| Identical repeated calls (same input fingerprint) | 223 of 2,390 (9%) |
| `run_command_batch` policy denials | 7 |

Fixed surfaces, measured against this repository at build time:

| Payload | Size | Composition |
| --- | --- | --- |
| `tools/list` | 11,135 B, 12 tools | schemas 5,980 B (54%), descriptions 3,461 B (31%), names and hints 1,694 B |
| `initialize` | 833 B | instructions 641 B |
| `server/discover` | 2,378 B | instructions + capability model + CodeGraph status |
| `search_code` result, 10 matches | 1,709 B | matched text 970 B, **JSON scaffolding 739 B (43%)** |
| `read_range` result, 40 lines | 1,617 B | raw lines 1,317 B, header 45 B, framing 228 B |
| `_meta` on every tool result | 84 B | `serverInfo` name and version |

## 3. Findings

**F-01. `tools/list` is no longer the lever.** It is 11,135 B for 12 tools, down from 29,206 B, and clients
fetch it about once per session (97 calls across 95 sessions). Even at the old 23 KB it was roughly a fifth
of one session's tool bytes. Trimming descriptions further would save ~3 KB once per session; that is not
where the money went, and it must not be re-litigated as if it were.

**F-02. `read_range` is the lever, and it is the agent's choice, not a bug.** 8,103 B per call, 6%
truncated, 1% failed, median latency 1 ms. Nothing in the tool is wasteful: it refuses to dump a whole file
(`startLine` and `endLine`, or `ranges`, are required), the text form is plain with a 45 B header, and there
are no per-line number columns. The cost is that agents read large spans after a search hit instead of
searching with `context`. What is missing is the measurement to prove it: the read span is not recorded, so
"reads are too big" cannot be separated from "reads are too many".

**F-03. Search results spend 43% of their bytes on JSON keys.** Each item is
`{path, line, column, text}`, about 74 B of scaffolding per match. A `path:line:col text` rendering would
keep every fact an agent uses and remove the punctuation; on this window that is about 0.5 MB, or 130k
estimated tokens. `toolResult(payload, text)` already supports the pre-rendered text path that `read_range`
uses, so the change is local to the handler.

**F-04. Empty results say nothing.** 21% of searches and 11% of `find_files` calls return
`{"items":[],"returned":0,"truncated":false,"backend":"ripgrep"}` — 68 B that leave the agent guessing
whether the term is absent, the glob is wrong, the path is out of scope, or the file is ignored. Each guess
costs a full round trip (a search result plus the model's reasoning), which is worth far more than the ~100 B
a "searched 412 files, literal match, case-insensitive, generated files excluded" note would cost.

**F-05. `apply_changes` is cheap per call and expensive per failure.** 591 B per call, but 12% fail, and
`not_found` is 39 of 53 failures. The tool already reports the failing file and, for ambiguous patches, a
closest-line hint; what it does not do is suggest the closest existing path for a `not_found`, which is the
one thing that would let the agent recover inside the same turn.

**F-06. `validate` is slow and then truncated anyway.** 47% truncated at p50 4,667 ms and p95 26.7 s. When
the result is cut, the agent usually has to run it again narrower, so the first call is close to pure cost.
The fix is a summary-shaped default: counts by severity and by file, plus the first errors per file, instead
of a bounded flat list.

**F-07. 9% of calls repeat an earlier identical call.** 223 calls carry an input fingerprint already seen in
the window. That is the residue of agents re-searching rather than re-reading their own results, and it is
cheap to absorb (see E-04) but not free to fix.

**F-08. Every tool result carries 84 B of redundant `_meta`.** 2,390 calls × 84 B is about 200 KB, and for
small results it is proportionally large: 24% of the 347 B `file_info` payload. The client already learned
the server name and version during `initialize`.

## 4. Recommendations, ordered by expected effect

| ID | Change | Basis | Expected effect | Effort | Status |
| --- | --- | --- | --- | --- | --- |
| E-01 | Explain empty and truncated results: files scanned, match mode, ignore rules applied, and one next step. | F-04 | Removes a class of wasted retries; 63 empty searches alone | S | Done |
| E-02 | Render `search_code` results as `path:line:col text` lines by default, JSON on request. | F-03 | −43% of search bytes, about 0.5 MB and 130k tokens on this window | S | Done: 2,028 B to 964 B and 8,643 B to 3,962 B on two measured queries (−52%, −54%) |
| E-03 | Record the read span (lines requested) as a bucketed telemetry field, then decide whether reads are too big or too many. | F-02 | Turns the largest cost into a measured question | S | Open |
| E-04 | Note repeated identical calls in the result (`same arguments as an earlier call in this session`) so the client can skip re-reading. | F-07 | Low risk, targets 9% of calls | M | Open |
| E-05 | Suggest the closest existing path on `apply_changes` `not_found`. | F-05 | Recovers 39 observed failures in one turn instead of two | S | Done |
| E-06 | `validate` default: severity and per-file summary plus the first few errors per file. | F-06 | Removes the 47% truncated case that currently forces a second run | M | Open |
| E-07 | `search_code` accepts `queries: string[]` and returns labelled groups. | §4c-3 | Fewer round trips for multi-pattern work, which today falls back to `run_command_batch` | S | Open |
| E-08 | Drop `serverInfo` from per-result `_meta`. | F-08 | −84 B per call, about 200 KB on this window | S | Open |

**Do not do:** shrink `tools/list` further (F-01), re-add output schemas or titles, or remove
`run_command_batch` — it is 22% of bytes but it is the only route to git and package managers, and removing
it would leave agents with no way to run the commands the policy already allows.

## 5. Code quality findings

**C-01. `src/mcp.ts` is 2,806 lines.** It holds the tool table, argument validation, dispatch, result
enveloping, guidance rendering, capability modelling and telemetry glue. Every change to a tool description
and every change to a handler touch the same file, which is why formatting drift and merge conflicts land
there first. Splitting into `tools/registry.ts`, `handlers/`, `guidance.ts` and `validation.ts` is mechanical
and needs no behaviour change.

**C-02. One test is coupled to the working tree.** `configured package scripts work with the filtered
environment` runs the repository's own `npm run check` and `npm run format:check`. It therefore fails
whenever the tree has unformatted files — it caught real drift today, but as a side effect it turns a code
test into a repository-hygiene assertion, and it cannot pass on a developer machine mid-edit. Move it to a
temporary fixture project with a stand-in script.

**C-03. Coverage is 62.28% lines, 75.89% branches, and nothing enforces it.** There is no coverage script in
`package.json`, so the number is invisible to CI. The untested area is concentrated in error handling, which
is exactly the code that produces the 12% (`apply_changes`) and 2% (commands) failure paths above.

**C-04. Type strictness is already strong.** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noUnusedLocals` and `noUnusedParameters` are on, and an extra `tsc --noUnusedLocals --noUnusedParameters`
run over the tree reports nothing. There is no dead code to clean up; the remaining code debt is structural
(C-01), not per-file.

**C-05. Error classification is still string matching.** This is open item 2.09. It matters here because the
failure table in §2 is built from those categories, and a new message that does not match a pattern quietly
lands in `execution`.

## 6. Instrumentation gaps to close first

1. Read span per `read_range` call (E-03). Without it the largest cost cannot be attributed.
2. Whether a client reused a previous `tools/list` response. Today every call records `responseBytes`, but a
   client that caches costs nothing after the first, and a client that does not costs 11 KB per session.
3. Prompt growth versus tool output growth in the same session. Telemetry records tool bytes only, so "the
   agent is expensive" and "the tool returns too much" are not separable from the server side.
