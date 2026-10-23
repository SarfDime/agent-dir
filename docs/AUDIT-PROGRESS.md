# Agent Dir: efficiency and reliability audit progress

Status legend: `[ ]` todo, `[~]` in progress, `[x]` done, `[!]` blocked on a decision (see section 2).
Priority: P0 critical, P1 high impact, P2 medium, P3 exploratory. Effort: S (under a day), M (1-3 days), L (more).

- Audited commit: `c6e659f` (branch `feat!/overall-package-improvements`, v1.3.0 + #50), clean tree.
- Mode: audit and planning only. No fixes are implemented until the maintainer approves.
- Evidence: source at the audited commit, local telemetry (2026-10-16 to 2026-10-17), the ChatGPT static audit (reconciled in section 8), and live probing of the connector.
- Caution: the live connector was running an older build than HEAD (it still exposes `run_npm_batch`; HEAD renamed it to `run_package_scripts_batch`). Telemetry therefore describes versions 1.1.1 to 1.3.0.

## 1. Ground rules

- MCP `2025-11-25` compatibility is mandatory because Claude agents depend on it. `2026-07-28` stays supported. Every protocol-touching task needs a contract test at `2025-11-25`.
- Batch behavior may change (breaking is acceptable). Breaking changes use `feat!:` / `BREAKING CHANGE:` footers; never hand-bump versions or tags (see `AGENTS.md`).
- Workflow: short-lived branch, PR into `main`, run `npm run check`, `npm test`, `npm pack --dry-run` before each PR. Do not use fake commit types to force releases.
- Keep the authentication model, project-root filesystem safety, command allowlists and non-shell execution intact while changing anything below.

## 2. Decisions (resolved 2026-10-18)

All decisions below were made by the maintainer. The original question text is kept after each resolution.

- [x] D-01 RESOLVED: work on the current branch `feat!/overall-package-improvements` only, no new branches; all refactors and fixes merge to `main` through it. Original: Base branch: confirm PRs for this work target `main` and which branch they start from.
- [x] D-02 RESOLVED: start with argument-aware guardrails; document explicitly that Agent Dir is not a security boundary against a hostile agent and that an executable-name allowlist alone is not a complete security system; an OS sandbox stays a separate future enhancement (3.11). Original: Execution policy tier (recommendation in section 6): guardrail with argument-aware rules, or defense against a hostile agent (needs OS sandbox).
- [x] D-03 RESOLVED: adopted; contract tests for both protocol versions; never advertise unimplemented capabilities. Original: Protocol policy: `2025-11-25` is the default behavior; `2026-07-28` is selected only by request metadata. Result shapes must be valid at both.
- [x] D-04 RESOLVED: scrub approved and delegated to the implementer; retention 30 days or 100 MB, whichever limit is reached first; the `diagnostic` level is for debugging, may include sensitive data, and must be documented as such. Original: Telemetry data: approve a one-time scrub of legacy `diagnosticDetails` (303 events, about 2.0 MB containing tool inputs and outputs), the default retention (proposal: 30 days or 100 MB), and the recommended default level.
- [x] D-05 RESOLVED: rename with no alias; update documentation, skills, tests and examples; document explicitly in release notes (task 6.04). Original: Tool rename `run_npm_batch` to `run_package_scripts_batch`: keep as a breaking change (recommended, no alias, because aliases enlarge `tools/list`) or ship an alias for one release.
- [x] D-06 RESOLVED: use the proposed defaults (`continue` for independent inspection commands, `stop` for scripts). Every item must carry an explicit status of success, failure or skipped (with a reason), so an agent never has to guess whether something ran. Original: Batch defaults (recommendation in task 3.05): `onError` with `continue` default for `run_command_batch`, `stop` default for scripts; always report skipped items.
- [x] D-07 RESOLVED: route Serena edits through the same safety layer wherever technically feasible; where not feasible, gate them behind explicit configuration until equivalent path restrictions and checks exist. Original: Serena semantic edit tools (`rename_symbol`, `replace_symbol_body`, `insert_*`): keep, gate behind config, or route through the same safety layer as `apply_changes`.
- [x] D-08 RESOLVED: use ripgrep when installed and recommend it; the CLI reports whether ripgrep or the built-in search is in use; both implementations must produce consistent output and honor the same safety limits; add tests for documentation and configuration files as well as source code. Original: Search backend: use ripgrep when installed with a Node fallback, or stay pure Node.

## 3. Baseline metrics (measured from local telemetry)

Window: about 1.5 days, 3 profiles (`agent-tunnel`, `scriptr`, `scriptr-c`), 912 tool calls, 3,153 events, versions 1.1.1 to 1.3.0, diagnostic level. Caveat: the `agent-tunnel` profile includes the previous audit session, so its call mix is exploration-heavy.

| Metric | Baseline | Target after phases |
|---|---|---|
| `tools/list` response size | about 22.7 KB (about 5.7k est. tokens), 20 calls | 12 KB or less |
| `server/discover` size / calls | about 1.5 KB / 49 calls; `resources/read`: 0 calls | unchanged size, richer content |
| `read_range` share (agent-tunnel) | 42% of calls, about 62% of est. output tokens | under 40% of tokens |
| `read_range` truncated | 28/263 (10.6%) | under 3% |
| reads that directly follow a read | 192/263 (73%) | under 50% |
| paths read 3+ times in a session | 26 of 90 (max 35 reads of one path) | halve |
| `search_code` zero-result | 13/93 (14%) | measured with `empty` flag |
| `search_code` truncation reported | 0 of 93 (unmeasurable; field absent) | 100% reported |
| `validate` truncated | 8/18 (44%), avg 13.0 s, p95 26.7 s | under 10% |
| `apply_changes` failures (agent-tunnel) | 18/83 (21.7%): 11 not_found, 7 execution | under 10% |
| duplicate output calls (`read_range`) | 18 calls, about 140 KB (about 35k tokens); input fingerprint caught only 2 | detectable and under 5 |
| `run_command_batch` | avg 3.6 s, p95 27.0 s; 5 policy denials of 118 (4.2%) | denial message lists allowed commands |
| `codegraph_explore` usage | 11 calls (1.2%), 0 failures | guidance A/B |
| `serena_*` usage | 32 calls (3.5%); in `scriptr-c` Serena search 29 vs native `search_code` 8 | guidance A/B |
| telemetry session summaries | 7 recorded for 20 sessions | all sessions |
| telemetry client identity | on 3 of 3,153 events | all requests |
| legacy `diagnosticDetails` | 303 events (v1.2.0), about 43% of the store | 0 |
| events carrying hostname, username, project root | 2,105 of 3,153 | only with explicit diagnostic opt-in |
| store growth | about 3 MB/day under active use, no retention | bounded |
| `telemetry_analytics` from Claude | 3 of 3 calls rejected client-side (server logged success, avg 32 ms) | 100% usable |

## 4. Phases

Order rationale: fix what blocks Claude clients and measurement first (1, 2), then policy and batch semantics (3), then the efficiency work that the new telemetry can verify (4, 5), then tests, docs and re-measurement (6).

### Phase 1: protocol conformance and blockers (commit types: `fix:`; breaking items `feat!:`)

| ID | Pri | Eff | Task | Depends | Acceptance criterion | Status |
|---|---|---|---|---|---|---|
| 1.01 | P0 | S | `telemetry_analytics` returns a bare object. Wrap with the standard tool result (`content`, `structuredContent`, `resultType`); make truncation return valid structure (not a cut JSON string); fix the test that asserts raw `result.mode` | none | All three modes succeed through an HTTP client at `2025-11-25` and `2026-07-28` | [x] |
| 1.02 | P0 | S | `initialize`: when the requested version is unsupported, respond with a supported version (`2025-11-25`) instead of an error; record successful initializes | none | Contract test: request `2025-06-18` returns `protocolVersion` `2025-11-25`; telemetry shows initialize successes | [x] (telemetry recording of successes done; requested-version field is task 2.02) |
| 1.03 | P1 | S | Implement `ping` (empty result) | none | `ping` returns `{}` at both revisions | [x] |
| 1.04 | P1 | S | Capability honesty at `2025-11-25`: do not advertise `prompts`, `resources.subscribe`, `listChanged` unless implemented (implement `prompts/list` returning empty, or drop) | 5.04 for tools listChanged | Declared capabilities equal implemented methods (test enumerates both) | [x] (`tools.listChanged` returns with 5.04) |
| 1.05 | P1 | S | `server/discover` `supportedVersions` lists `2025-11-25` and `2026-07-28`; fix `docs/MCP.md` | none | Test and docs agree | [x] |
| 1.06 | P1 | M | SSE framing: emit real `\n\n`; stream responses bypass the JSON clone/parse in `server.ts`; add HTTP-level subscription test | none | Ack and a later notification arrive within 1 s through `startServer` and parse with a real SSE parser | [x] |
| 1.07 | P1 | M | Contract suite using the official MCP TypeScript SDK client (dev dependency) against `startServer`: initialize, tools/list, every tool call, ping, resources, errors | 1.02, 1.03 | Runs in CI at `2025-11-25` | [~] raw-HTTP suite done in `test/protocol-contract.test.ts`; official SDK client not added (avoids a new dependency) |
| 1.08 | P2 | S | Serena/CodeGraph results use the same result shape as native tools (`resultType`, `_meta`, structured fields) | none | Telemetry sees truncation and file metrics for them | [ ] |

Note: the `2025-11-25` rule that `structuredContent` and `outputSchema` roots must be objects is resolved by task 4.01 (object envelopes for every tool), which avoids version-dependent shaping.

### Phase 2: telemetry integrity, privacy and measurement (commit types: `fix:` / `feat:`)

| ID | Pri | Eff | Task | Depends | Acceptance criterion | Status |
|---|---|---|---|---|---|---|
| 2.01 | P1 | S | `agent-dir telemetry scrub` removes legacy `diagnosticDetails` (never automatic) | D-04 | 0 events with the field after running; files stay mode 600 | [x] (`agent-dir telemetry prune`; also run once on the live store: 303 events scrubbed) |
| 2.02 | P1 | S | Record requested protocol version and client identity (read `_meta` clientInfo as well as initialize `clientInfo`) | 1.02 | Version and client present on all mcp_request events | [x] (client identity now also read from `_meta`) |
| 2.03 | P1 | M | Session durability: periodic or per-idle session summary so killed processes still produce one; add episode segmentation by idle gap at analysis time | none | Sessions with a summary: 100% in a kill test | [x] (periodic snapshots, last one wins; episode segmentation lives in the efficiency summary) |
| 2.04 | P1 | S | HMAC-SHA256 with a per-install secret for fingerprints and path/content hashes; canonicalize arguments (sorted keys, defaults stripped) | none | Duplicate detection on input and output agree on the baseline replay | [x] (HMAC key in `~/.config/agent-dir/telemetry.key`; canonical input fingerprints ignore key order and `maxBytes`) |
| 2.05 | P1 | M | Analytics read path: no write side effects (move legacy migration to an explicit command); filter by profile/session at file level; stream instead of loading everything; retention and `telemetry prune` | D-04 | Query time flat as history grows; read does not modify files | [~] done: 30 day / 100 MB retention, `telemetry prune`, side-effect-free analytics reads, file-level filtering by profile/session/time. Not done: streaming reader |
| 2.06 | P2 | S | Build runtime context lazily (skip when level is `none`; cache static fields; no per-request `/etc/os-release` read) | none | No sync fs on the hot path at level `none` | [x] (static fields cached once, including the `/etc/os-release` read) |
| 2.07 | P1 | M | Additive tool_call fields: `outcome` (ok/empty/truncated/error), `truncated` and `resultCount` for every tool, `commandExecutable` (allowlisted name only), `exitClass`, integration status, `skippedCount`, argument-shape booleans (no values) | 1.08, 4.01 | Fields populated on 100% of calls in tests | [~] done: `outcome` on every tool call, `truncated`/fingerprints for CodeGraph and Serena results, command `executables`. Remaining: `skippedCount` (with 3.05), integration status at call time, argument-shape booleans |
| 2.08 | P1 | S | Emit a tool_call event for unknown tool and invalid-argument calls | none | Event present with category | [x] (unknown tool, non-object arguments, header errors) |
| 2.09 | P1 | S | Typed error classes replace message matching: invalid_input, not_found, unavailable_integration, policy_denied, timeout, execution, internal | none | `ENOENT`, missing integration and policy denials classified correctly | [~] message-based classification extended (`not_found` for ENOENT, `unavailable_integration`, `unknown_tool`); typed error classes move to task 5.06 together with schema validation |
| 2.10 | P2 | M | `summary` mode gains an efficiency block (tokens by tool, truncation and empty rates, duplicate rate, search-then-read ratio, calls per episode, integration usage) | 2.07 | Every baseline-table metric reproducible from `summary` | [x] (`efficiency` block per profile: tokens by tool, truncated/empty rates, duplicate input and output calls, repeated file reads, search-then-read transitions, episodes, top transitions, clients, protocol versions) |
| 2.11 | P2 | S | Buffer telemetry appends instead of mkdir+append+chmod per event | none | One flush per interval; no loss on graceful exit | [~] directory creation and chmod now happen once, with a retry if the file disappears; appends are still synchronous |
| 2.12 | P3 | S | Document what each level stores; reconsider default level | D-04 | `docs/telemetry.md` matches code | [x] (default level left unchanged; diagnostic level documented as debug-only) |

### Phase 3: execution policy, security and batch semantics (commit types: `feat!:`)

| ID | Pri | Eff | Task | Depends | Acceptance criterion | Status |
|---|---|---|---|---|---|---|
| 3.01 | P0 | S | State the trust model in `SECURITY.md` and `docs/CONFIGURATION.md`: the allowlist is a guardrail, not a sandbox; list known bypass classes | D-02 | Doc merged; README wording consistent | [x] (`SECURITY.md`, `docs/MCP.md`, `docs/CONFIGURATION.md`; README still to review in Phase 6) |
| 3.02 | P1 | M | Argument-aware command policy (section 6): per-executable rules, normalized global options, presets (`git-readonly`, `search`, `gh-readonly`), unsafe interpreters opt-in only | D-02 | Table-driven tests with stub executables for every denied mode | [x] (`test/batch-policy.test.ts`; evaluated on argument lists, no destructive commands run) |
| 3.03 | P1 | S | Blacklist matching works on normalized subcommands (global options before the subcommand no longer bypass) while keeping existing prefix entries valid | 3.02 | `git -C x push`, `git -c a=b push`, `git --git-dir=x push`, `npm --prefix x publish` blocked | [x] |
| 3.04 | P1 | S | Child environment: allowlist with opt-in extras (parity with the CodeGraph/Serena environment) | D-02 | Non-secret-named credential variables not inherited | [x] closed by decision: keep the extended denylist as is; no allowlist (maintainer, 2026-10-19) |
| 3.05 | P1 | M | Batch rewrite: preflight the whole batch (policy, script existence) before running anything; `onError` option; per-item `status` (ok/failed/skipped/denied/timeout); never drop earlier results on a later failure; keep partial output on timeout; flag size-based omission | D-06 | First/middle/last failure, `rg` exit 1, timeout, and over-budget tests all report skipped and truncated items | [x] (every item reports success, failure or skipped with a reason; `okExitCodes`; stop/continue per D-06) |
| 3.06 | P1 | S | Protected paths for `apply_changes` (default: `.git/**`, `.env*`, CI workflows, `.npmrc`; configurable) | D-02 | Writes rejected with an actionable message | [x] (`protectedPaths` profile setting; defaults cover `.git`, `.env*`, `.npmrc`) |
| 3.07 | P2 | S | Authenticate before reading the body (small pre-auth cap); document Origin behavior behind tunnels | none | Unauthenticated 10 MiB body rejected without buffering | [x] (authentication now happens before the body is read; Origin check behavior unchanged) |
| 3.08 | P2 | S | Flag mutating scripts (`check:write`, `format`) in the setup wizard and docs | none | Wizard warns | [x] (setup wizard and startup both warn; `mutatingScripts` detects format/fix/write names) |
| 3.09 | P2 | M | One shared process runner for commands and package scripts; per-call timeout (bounded); partial output on timeout | 3.05 | Single implementation, tests for timeout/abort/cleanup | [x] (`spawnCapture`; per-call `timeoutMs` 1000-600000 ms on both batch tools) |
| 3.10 | P2 | S | Config migration or warning for the old `npm` profile key (HEAD ignores it silently, which empties the script allowlist) | none | Old profile loads with a warning or is migrated | [x] (`npm.allowedScripts` migrated in memory with a warning) |
| 3.11 | P3 | L | Optional OS-level sandbox wrapper (bubblewrap or container) | D-02 | Prototype and decision record | [!] deferred by D-02: the OS sandbox is a separate future enhancement |

### Phase 4: search, read and edit efficiency (commit types: `feat!:` for envelopes, otherwise `feat:`)

| ID | Pri | Eff | Task | Depends | Acceptance criterion | Status |
|---|---|---|---|---|---|---|
| 4.01 | P1 | M | Object envelope for `search_code`, `find_symbol`, `find_references` (`items`, `returned`, `truncated`, `reason`) | none | Max-results and max-bytes truncation both reported; valid at `2025-11-25` | [x] (`search_code`, `find_symbol`, `find_references` and `apply_changes` now return objects; the contract test that was a todo now passes) |
| 4.02 | P1 | S | File walker: remove or expose the depth cap (files over 6 path segments are currently invisible), honor `.gitignore`, skip tool artifacts (`.codegraph`, `.serena`, virtualenvs, build output), skip sockets and special files, report incompleteness | none | Fixtures at depths 5, 6, 7+ and ignored dirs pass | [x] (git file list honors .gitignore; walk fallback has no depth cap; tool artifact dirs skipped; sockets and special files ignored) |
| 4.03 | P1 | M | `search_code`: `paths`/`globs`, `context`, `caseSensitive`, text-file detection instead of an extension list (docs and configs searchable), linear-time regex (ripgrep or RE2) or timeout, results grouped by file | D-08 | Docs search finds `AGENTS.md` text; ReDoS pattern returns within the timeout | [~] done: ripgrep + built-in backends, paths/globs/context/caseSensitive, docs and config files searchable, nested-quantifier regexes rejected on the built-in backend, banner and `project_context` report the backend. ripgrep backend parity tests exist but could not be run here (ripgrep is not installed on this machine) |
| 4.04 | P1 | S | `read_range`: return `nextStartLine`, `totalLines` or `eof`; sane EOF behavior; auto-size the default window; optional `ranges[]`; plain-text content block with line numbers | none | Read-after-read ratio and truncation rate meet section 3 targets | [ ] |
| 4.05 | P1 | S | Compact the text block (measured +28% from pretty-printing) and apply `maxBytes` to the whole serialized result | none | Response size is at most 1.1 times the requested budget | [ ] |
| 4.06 | P1 | M | `apply_changes`: error when a patch matches more than once and `count` is omitted; on no match return closest-match hints; write via temp file and rename; binary-safe; test the rollback path | 3.06 | Failure rate under 10% on replayed workflow; rollback tests exist | [ ] |
| 4.07 | P2 | S | `find_files`: match bare filenames and `**`; case option; accurate `truncated` | none | `mcp.ts` finds `src/mcp.ts` | [x] |
| 4.08 | P2 | M | `find_symbol`/`find_references`: broaden language coverage or label as lexical heuristics; fix `$` identifiers | 4.01 | Go, Java and `$`-named fixtures pass or description is honest | [x] (language patterns broadened, case-sensitive, `$` identifiers handled, descriptions state they are lexical heuristics) |
| 4.09 | P2 | M | `validate`: fix false positives (setext underlines, JSONC), cap per-file reads, validate `level`, make `level=scripts` without scripts select configured defaults or error, return structured failure summaries instead of cut text | none | 44% truncation baseline reduced; invalid level rejected | [ ] |
| 4.10 | P2 | S | Allow bounded arguments for package scripts (for example a test path) under policy | 3.02 | Targeted test run possible without a generic command | [ ] |
| 4.11 | P3 | M | Cached file index with watcher invalidation | 4.02 | Measured gain on a large repo | [ ] |

### Phase 5: discovery, guidance and integrations (commit types: `feat:` / `fix:`)

| ID | Pri | Eff | Task | Depends | Acceptance criterion | Status |
|---|---|---|---|---|---|---|
| 5.01 | P1 | M | One generated capability model (tools, per-integration status and detail, policy including blacklist, limits, recommended workflows) feeding `initialize`, `server/discover`, the capabilities resource and `project_context` | 1.05 | Snapshot test: the four surfaces agree for every integration state | [ ] |
| 5.02 | P1 | S | Rewrite guidance as a short decision table placed in `server/discover` (the only channel clients use today: 49 discover calls, 0 resource reads); resolve contradictions (CodeGraph first vs Serena first vs `search_code`; two edit paths); make it conditional on availability; drop REQUIRED wording | 5.01 | Usage of each integration reviewed after release with telemetry | [ ] |
| 5.03 | P1 | M | Shrink `tools/list`: concise descriptions for Serena tools, drop empty output schemas and titles | 4.01 | At most 12 KB with all integrations enabled | [ ] |
| 5.04 | P1 | M | Integration self-healing: restart with backoff, re-detect the CodeGraph index, ignore non-JSON stdout from Serena, emit `tools/list_changed` (or stop declaring it), do not advertise a failed integration as required | 1.04 | Kill test: tool recovers or disappears and clients are notified | [ ] |
| 5.05 | P1 | S | Serena output bounding: honor `max_answer_chars`, fix the CodeGraph-specific trim message, expose consistent truncation fields | 1.08 | Large `include_body` result bounded with a correct message | [ ] |
| 5.06 | P2 | M | Schema-based input validation before dispatch; unknown arguments rejected with the list of valid names; remove `String()`/`Number()` coercion; error messages name the argument | none | Negative-case test for every public tool | [ ] |
| 5.07 | P2 | S | Tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), treated as hints only | none | Present on every tool; Serena edit tools marked destructive | [ ] |
| 5.08 | P2 | S | Serena edit tools: apply decision D-07 (protected paths, resource notifications, cache invalidation) | D-07, 3.06 | Edits via Serena obey the same path policy | [ ] |
| 5.09 | P2 | S | Unknown tool error lists nearest valid names; decide whether to keep `isError` (friendlier to agents) or return the protocol error the spec describes | none | Decision recorded | [ ] |
| 5.10 | P2 | S | Detect ast-grep once, asynchronously (currently a synchronous spawn per call and per discover) | none | No sync spawn in request path | [ ] |

### Phase 6: tests, documentation, release and re-measurement

- [ ] 6.01 Tests: protocol matrix (section 7), command-policy table, batch semantics, depth/ignore fixtures, truncation envelopes, apply_changes rollback and partial failure, integration kill/recover, telemetry privacy by level, analytics bounded reads.
- [ ] 6.02 Docs: `docs/MCP.md` (versions, tools, envelopes, batch semantics), `docs/CONFIGURATION.md` (policy rules, migration), `SECURITY.md` (trust model), `docs/telemetry.md` (levels, retention, scrub), `README.md`, `AGENTS.md` if tool names change.
- [ ] 6.03 Re-baseline with the same queries as section 3 on a fresh telemetry window and fill a before/after table here.
- [ ] 6.04 Release notes: list every breaking change (batch result shape, search envelopes, tool rename, config keys, policy defaults).

### Phase 7: exploratory (P3, needs measurement or prototype first)

- [ ] 7.01 Episode-level analytics and guidance experiments (does a shorter decision table change integration usage?).
- [ ] 7.02 Tree-sitter or ast-grep backed symbol index for languages the lexical tools miss.
- [ ] 7.03 Combined search-and-read tool (matches with context) if 4.03/4.04 do not reduce the search-then-read pattern.
- [ ] 7.04 Sandbox wrapper prototype (see 3.11).

## 5. Findings verified at the audited commit

Status: V = verified in source at HEAD, M = also supported by measurement, T = supported by telemetry, U = not runtime-verified.

| Finding | Verdict | Evidence |
|---|---|---|
| SSE terminator is literal backslash-n | V, U (runtime) | `src/mcp.ts:2226`; zero `subscriptions/listen` calls in telemetry, so no observed client impact |
| Stream response cloned and parsed before sending | V, U | `src/server.ts:120-122` |
| Batches stop at first non-zero exit, no skipped marker | V | `src/mcp.ts:1519, 1577, 1612`; reproduced live in the first audit with an `rg` no-match; 42 consecutive `run_command_batch` calls in telemetry (consistent, not proof) |
| Silent truncation in `search_code` family | V, M, T | bare array results; 73 of 387 matches returned on a broad query; telemetry never reports truncation for these tools |
| File walker depth cap | V | `src/tools/files.ts:64`; not triggered in the audited repos |
| Allowlist is name-only; blacklist is positional prefix | V | `src/tools/commands.ts:82`; all 3 live profiles allow `node`, `npm`/`pnpm`, `git`, `gh` with no blacklist |
| Integration failure latches (CodeGraph); Serena never reset after crash | V, T (no failures observed) | `src/codegraph.ts:85`, `src/serena.ts:60` |
| `tools.listChanged` declared, never emitted | V | no call site emits a tools notification |
| Serena/CodeGraph output bounded with the wrong budget and message | V | `src/mcp.ts:1170, 2035` |
| Guidance and discovery surfaces disagree | V, T | three generators; only `server/discover` is read by clients |
| Manual coercion: `String(args.path)` etc. | V | `src/mcp.ts:1351, 1413, 1424, 1433, 1441, 1560` |
| `validate` diagnostics weak and truncated | V, T | `src/tools/diagnostics.ts:58`; 8/18 truncated |
| Native search coverage gaps (docs, scoping, context) | V, M | measured 0 hits for text present in `AGENTS.md` |
| Pretty-printed duplicate JSON text block | V, M | `src/mcp.ts:1761`; +28% measured |
| `apply_changes` patch ambiguity, best-effort rollback, no rollback test | V | `src/tools/files.ts:245` |
| Error taxonomy lumps integration and path errors into `execution` | V | message matching in `classifyTelemetryError` |
| No tool annotations | V | no assignment anywhere |
| Telemetry gaps (sessions, client identity, fingerprints, aggregation) | V, T | section 3 |

### New findings in this pass

- `telemetry_analytics` result shape is non-conformant and rejected by the Claude client (task 1.01). Cause: early `return result` bypasses the standard result wrapper (`src/mcp.ts:1321`).
- `initialize` rejects unsupported versions instead of negotiating; 3 of 3 recorded Claude initializes failed on v1.1.1; successes are not recorded at all (task 1.02). Cause of those failures cannot be determined because the requested version is not stored.
- No `ping`; `prompts` capability advertised without `prompts/list`; `resources.subscribe` and `listChanged` advertised without the `2025-11-25` mechanisms (tasks 1.03, 1.04).
- Legacy telemetry holds full tool inputs and outputs for 303 events (task 2.01).
- Client identity is lost for stateless clients because `_meta.clientInfo` is not read (task 2.02).
- `read_range` dominates token cost and is read in chunks (task 4.04).
- Profile key rename `npm` to `scripts` has no migration (task 3.10); tool rename affects agents (D-05).

## 6. Command allowlist recommendation

Keep the allowlist (default deny, `shell: false`), but change what it promises and how it works.

1. Treat it as a guardrail against accidents and unreviewed tool sprawl, not a security boundary. Allowing an interpreter or package runner grants arbitrary execution (`node -e`, `npm exec`, `pnpm dlx`), and several common tools have execution modes in their arguments (`rg --pre`, `find -exec`/`-delete`, `git -c`, `gh api`). Say so in `SECURITY.md`.
2. Add per-executable argument rules evaluated after normalizing global options, instead of prefix blacklists. Defaults: `git` read-only subcommands (status, diff, log, show, branch, rev-parse, ls-files, blame, grep) and reject `-c`, `--git-dir`, `--work-tree`, `--exec-path`; `rg`/`grep`/`find` without `--pre`, `-exec*`, `-delete`, `-fprint*`; `gh` read-only views only, never `api` or `auth`; package managers only through the dedicated script tool, never `exec`, `dlx`, `publish`, `config`.
3. Do not allow `node` or other interpreters by default. Offer an explicit `unsafe` opt-in that the wizard and the capability response label clearly.
4. Keep `blacklistedCommands` working for compatibility, but match normalized subcommands so options before the subcommand cannot bypass it.
5. Protect paths for writes (`.git`, `.env*`, CI workflows, `.npmrc`) and use an environment allowlist for children.
6. Make denials actionable: list the allowed executables and rules in the error (5 denials observed, 4.2% of command calls). Reduce friction by adding safe built-in tools rather than widening the list.
7. If the threat is a hostile or prompt-injected agent, add an OS sandbox (container or bubblewrap, no network, read-only outside the project). Argument rules cannot close that gap.

Decision D-02 chooses between guardrail (steps 1-6) and guardrail plus sandbox (step 7).

## 7. Test plan (all fixtures in temp dirs, stub executables, no destructive commands)

- Protocol at `2025-11-25` (official SDK client over real HTTP): initialize with older and current versions, tools/list, every tool, ping, resources, errors, notifications; at `2026-07-28`: discover, `_meta` handling, subscriptions with real SSE parsing.
- Commands: allowed vs denied executables, argument rules, normalized-option bypass attempts using stubs, timeout/abort/cleanup, environment filtering.
- Batches: lengths 1 and 10, invalid last command, first/middle/last failure, `rg` exit 1, over-budget output, preflight with no side effects.
- Files and search: depths 5, 6, 7+, `.gitignore`, binary and over-1 MB files, docs and config search, max-results and max-bytes truncation flags, regex safety, symlink and root escape.
- Edits: duplicate paths, ambiguous and missing patches, failure after a successful earlier write, rollback failure, protected paths.
- Telemetry: each level, persistence on/off, malformed JSONL, legacy data, scrub, retention, analytics bounded reads without writes, fingerprints stable only where intended.
- Integrations: kill and recover CodeGraph and Serena, not-indexed to indexed transition, list_changed emission.

## 8. Reconciliation with the ChatGPT static audit

All twenty items were checked against HEAD. Line numbers in that file drifted slightly; none of its claims were contradicted.

| ID | Verdict | Note |
|---|---|---|
| A1 SSE framing | Confirmed | Priority lowered to P1 because telemetry shows no `subscriptions/listen` use |
| A2 clone/JSON on stream | Confirmed by code | Runtime hang still unexecuted |
| A3 allowlist and blacklist | Confirmed and extended | Adds `rg --pre`, `find -exec`; live profiles have no blacklist |
| A4 depth cap | Confirmed | |
| A5 bare-array search results | Confirmed | Measured 81% drop on a broad query |
| A6 discover advertises only `2026-07-28` | Confirmed | Extended by `initialize`, `ping`, capability findings |
| A7 stale or failed integrations | Confirmed | Plus latch and unemitted `list_changed` |
| A8 rollback and protected paths | Confirmed | No rollback test exists |
| A9 body read before auth | Confirmed | |
| A10 coercion | Confirmed | |
| A11 analytics read side effects | Confirmed | No legacy file exists today, so no current side effect; full synchronous load remains |
| A12 fingerprints and diagnostic context | Confirmed, worse than assumed | 303 legacy events hold full inputs and outputs |
| A13 runtime context on hot path | Confirmed | Plus lost client identity |
| A14 batch semantics | Confirmed | Verified: stops on first non-zero exit, no skipped markers |
| A15 allowed scripts are arbitrary code | Confirmed | |
| A16 annotations | Confirmed | |
| A17 version coverage | Partly verified | Test coverage at `2025-11-25` not re-counted in this pass |
| A18 analytics capability | Confirmed | Field population measured: `truncated` 36/623, `resultCount` 256/623, `paginated` 0 |
| A19 search coverage | Confirmed | |
| A20 duplicated lifecycle code | Partly verified | `package-scripts.ts` still duplicates `commands.ts`; `git.ts` not reviewed |

Issues the ChatGPT audit did not find: analytics result shape, initialize negotiation, missing `ping`, legacy telemetry contents, `tools/list` size, `read_range` token share, config key migration.

## 9. Uncertainties and limits

- The live connector ran an older build than HEAD; HEAD-only changes (tool rename, config keys) are verified by source only.
- Telemetry covers about 1.5 days and 3 profiles and includes audit-style exploration; it shows what can be measured, not long-run usage.
- Low use of CodeGraph, Serena and ast-grep may reflect discoverability or lack of need; it is not evidence they lack value.
- No tests or builds were run, so SSE and stream behavior are from source. The requested protocol version of the failed initializes is unknown.
- Telemetry cannot show what commands `run_command_batch` ran or which files were deeper than the walker limit.
- `src/tools/git.ts`, `skills.ts`, `metadata.ts` and `tunnel.ts` were not reviewed in depth.

## 10. Change log

- 2026-10-18: initial audit, plan and baseline recorded. No code changed.
- 2026-10-18: decisions D-01 to D-08 recorded. Phase 1 tasks 1.01 to 1.07 implemented and verified (`npm run check` and `npm test` pass); not committed.
- 2026-10-18: Phase 1 committed (`db12718`); 1.01 confirmed live against the restarted connector.
- 2026-10-18: Phase 2 partially implemented (2.01, 2.02, 2.04, 2.05, 2.06, 2.08, 2.12 done; 2.09 and 2.11 partial). Still open in Phase 2: 2.03 session durability, 2.07 additive fields, 2.10 efficiency summary, typed errors (2.09).
- 2026-10-19: Phase 2 completed except the items noted partial in the table (2.05 streaming reader, 2.07 remaining fields, 2.09 typed errors moved to 5.06, 2.11 async appends). Live check after restart: the Claude client identifies as `Anthropic/ClaudeAI` 1.0.0 and calls `server/discover` over protocol `2026-07-28` (one sample; 2025-11-25 support stays mandatory per D-03).
- 2026-10-19: Phase 3 implemented: guardrail policy engine, batch rewrite with explicit statuses (breaking result shape), protected paths, auth before body, config migration, trust-model documentation. Still open in Phase 3: 3.08 (setup wizard warning for mutating scripts), per-call timeouts (3.09), 3.11 (sandbox prototype, exploratory). Batch outputs are now objects; the remaining array outputs are handled by task 4.01.
- 2026-10-19: Phase 3 completed after maintainer review: env denylist kept as is (no allowlist), workflows stay unprotected by default, `node` stays allowed; added `--protect`/`--unprotect`, a setup-wizard prompt and banner line for protected paths, mutating-script warnings, and per-call `timeoutMs` for both batch tools. 3.11 (OS sandbox) is deferred per D-02.
- 2026-10-19: Phase 4 part 1 (4.01, 4.02, 4.03, 4.07, 4.08): object envelopes with `truncated`, git-aware file list without the depth cap, scoped/context search with ripgrep and built-in backends, find_files bare names, broader symbol patterns. Breaking: `search_code`, `find_symbol`, `find_references` and `apply_changes` results are now objects. Open: 4.04 read_range, 4.05 output compaction, 4.06 apply_changes ergonomics, 4.09 validate, 4.10, 4.11. ripgrep is not installed on the maintainer machine now, so the ripgrep code path is covered by tests that skip here.
