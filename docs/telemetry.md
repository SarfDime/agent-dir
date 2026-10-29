# Telemetry interpretation

Agent Dir telemetry is a local operational record of MCP activity. It describes what the server handled, how long it took, and where failures occurred without recording project contents, command arguments, tokens, environment variables, or project paths at standard levels. The opt-in diagnostic level additionally records local troubleshooting metadata, including project paths, hostname, username, process identifiers, full Node version, Linux distribution ID/name/version, kernel version, memory usage, process uptime, and process details. Raw tool inputs, tool outputs, command arguments, and error messages are never recorded at any level (Agent Dir 1.2.x recorded bounded raw tool details at the diagnostic level; `agent-dir telemetry prune` scrubs that legacy data). The diagnostic level is for debugging only: its identifying metadata can still be sensitive, so enable it temporarily and disable it afterwards.

## Data hierarchy

Telemetry is organized as:

- `none`: disabled.
- `anonymous`: operational events without runtime/project context.
- `basic`: anonymous events plus coarse runtime context.
- `detailed`: basic context plus coarse project classification.
- `diagnostic`: detailed context plus identifying/troubleshooting metadata (project paths, hostname, username, process details). Debugging use only: it can expose sensitive information about your machine and projects, and it is stored locally. Enable it temporarily.

configuration → session → event

- **Configuration** identifies the Agent Dir configuration that produced the event. Named profiles use the profile name; direct CLI configurations use a stable hash of the effective share configuration.
- **Session** identifies one MCP handler lifetime. A session starts with its first MCP request and is finalized when the server closes the handler.
- **Event** is one recorded operation or one session-finalization record.

## Event types

### mcp_request

One MCP/JSON-RPC request handled by Agent Dir. Its duration covers the request from entry through response/error handling.

For `tools/list`, the event also records `toolCount` and `toolSetHash` (a keyed hash of the sorted tool names). Use them before comparing `responseBytes` across time: an integration appearing or disappearing changes the list without any code change, which is otherwise easy to misread as a schema regression.

For `initialize` and `server/discover`, the event records `guidanceVariant` (see [Guidance experiments](#guidance-experiments)).

### tool_call

One Agent Dir tool execution inside an MCP request. Tool metrics are the best measure of individual Agent Dir capability reliability. Tool events include UTF-8 input/output byte counts, a rough token-size estimate (`ceil(bytes / 4)`), hashed request/input/output fingerprints, output repetition within the current process session, and bounded per-file metadata. File metadata contains hashes of paths and returned file text plus byte counts; it does not contain the paths or text themselves. A matching output fingerprint means the serialized tool result was identical, not that Claude necessarily re-read or billed those bytes again.

Token estimates are **not tokenizer measurements** and do not represent Claude's actual input/output tokens or billing. Agent Dir cannot observe Claude's hidden prompt, cached tokens, reasoning tokens, or context carried between turns. Search results can be compared by result count, output bytes, truncation, and pagination, but Agent Dir does not currently judge semantic search relevance. Repeated input fingerprints and event ordering can help identify retry patterns, while validation-after-change counts must be inferred from the raw event sequence rather than treated as a definitive causal metric.

Three further fields describe *how* a tool was called, never what was passed:

| Field | Meaning |
| --- | --- |
| `skippedCount` | Batch tools only: items reported as `skipped`, i.e. never started because an earlier item failed or was rejected. |
| `integration` / `integrationStatus` | Set for integration-backed tools (`codegraph_explore`), with the integration status at call time. |
| `argShape` | Booleans for the optional arguments that were supplied (`regex`, `caseSensitive`, `paths`, `globs`, `context`, `multiline`, `ranges`, `dryRun`, `okExitCodes`, `limit`). Values are never recorded. |
| `readLines` | `read_range` only: total lines requested, summed over `ranges`. A count, never content. `mode=summary` buckets it under `efficiency.readSpans`, which is how a large-byte read total is attributed to big reads or to many small ones. |

`argShape` is what makes guidance experiments measurable: it shows whether agents actually use `paths`/`globs` to scope a search, or `context` instead of a follow-up read.

### command_call

One command operation performed by an Agent Dir command tool. Command metrics describe command execution separately from MCP transport success.

### session

A final summary emitted when the MCP handler closes. It contains:

- wallClockDurationMs: elapsed time from the first request to the last request.
- activeRequestDurationMs: sum of MCP request processing durations.
- idleGapDurationMs: wall-clock time minus active request time.
- requestCount: number of MCP requests in the session.
- toolCallCount: number of tool calls in the session.
- commandCallCount: number of command operations in the session.

Idle gaps are **not agent thinking time**. They can contain agent reasoning, network latency, client delays, scheduling, or other time outside Agent Dir request processing.

## Success rates

There is intentionally **no single overall success rate**.

An MCP tool invocation normally produces both a tool_call event and an enclosing mcp_request event. Counting both as independent successes or failures would double-count the same operation and make the metric misleading.

Instead, interpret these independently:

- **MCP success** = successful MCP requests / MCP requests.
- **Tool success** = successful tool calls / tool calls.
- **Command success** = successful command calls / command calls.
- **Per-tool success** = successful calls for that tool / calls for that tool.
- **Per-command success** = successful calls for that command operation / calls for that command operation.

A rate of — means there were no events of that type, not that the type failed.

## Failures

Failure categories are separated by event type:

- mcp failures belong to MCP request handling.
- tool failures belong to Agent Dir tool execution.
- command failures belong to command execution.

This separation prevents a failed tool call and its failed enclosing MCP request from being presented as one combined failure metric.

## Duration metrics

- **Avg** is the arithmetic mean of recorded durations for that operation.
- **P95** is the 95th-percentile recorded duration using the nearest observed sample at or above the percentile rank.
- Session wall-clock time is not equivalent to active server processing time.

Do not infer agent reasoning time, user wait time, or network latency from tool duration alone.

## Privacy levels

- **anonymous** records operational event data only.
- **basic** adds bounded Agent Dir/runtime and MCP client information.
- **detailed** additionally adds coarse project classification such as language, package manager, Git/CodeGraph availability, and project size.
- **diagnostic** additionally adds local troubleshooting metadata such as project paths, hostname, username, process identifiers, Node version, memory usage, and process uptime. This level is opt-in and should only be enabled when needed for local diagnosis.

Telemetry is persisted locally only when enabled. Persistence failures must never affect MCP request handling.

### Adding a telemetry field

Event shapes live in `src/telemetry/types.ts`; the persistence allowlist lives in `src/telemetry/privacy.ts`. The allowlist is a rule table typed against each event interface, so adding a field without a rule — or adding a whole event type — fails the build instead of writing an event whose field is silently dropped. Error categories, tool outcomes, and argument-shape keys are declared once as `as const` tuples and reused by both the classifier and the sanitizer, so a category cannot be emitted and then rewritten to `unknown` on the way to disk. Values that bypass the types (older data, hand-edited files) are still coerced at write time.

## MCP telemetry analytics (opt-in)

Start Agent Dir with `--analytics` to expose the `telemetry_analytics` MCP tool. It reads persisted telemetry across all profiles and sessions on the host; this is separate from enabling collection. Keep the flag off unless the connected agent needs access to this history.

- `mode=summary` returns aggregate reliability, timing, and usage metrics.
- `mode=sessions` returns per-session tool counts and failure summaries.
- `mode=events` returns bounded event records, with runtime/project context reduced to coarse fields and legacy raw diagnostic tool details removed.
- Optional `profile`, `session`, `since`, and `until` filters narrow the dataset. `limit` and `maxBytes` bound the response; use filters rather than requesting the entire event stream.

Diagnostic-level telemetry can still include identifying runtime metadata, so only enable remote analytics on a connector you trust. The analytics tool is hidden by default and is registered only when the explicit flag is true.

### Guidance experiments

The guidance text that `initialize` and `server/discover` return has two variants, selected with `AGENT_DIR_GUIDANCE`:

- unset or `table` (default): the decision table.
- `terse`: a single paragraph with the same policy.

Each `initialize`/`discover` request records `guidanceVariant`, and `mode=summary` reports request counts per variant under `efficiency.guidanceVariants`. To compare, run the same workload under both variants and diff the `efficiency` block: calls per episode, `searchThenReadTransitions`, `argShape` usage, and tokens by tool. Nothing else in the response changes, so a difference is attributable to the guidance.

Keep one variant per host and window; switching mid-session mixes the samples.

## Retention and maintenance

Recorded telemetry is kept for at most **30 days or 100 MB, whichever limit is reached first**. Agent Dir enforces this when a persisting session starts and then at most every six hours, deleting the oldest session files first (the active session file is never deleted). `agent-dir telemetry prune` applies the policy immediately and also scrubs the legacy raw `diagnosticDetails` field that Agent Dir 1.2.x stored. `agent-dir telemetry status` shows the limits. Reading analytics (`telemetry_analytics`) never migrates, rewrites, or deletes data.

## Fingerprints and identity

Every hash (request, input and output fingerprints, path and content hashes) is an HMAC-SHA256 keyed by a per-installation secret stored in `~/.config/agent-dir/telemetry.key` (mode 600, created only when telemetry is enabled). Equal values hash equally on one machine, so duplicate calls stay detectable, but hashes cannot be confirmed by guessing common paths or queries and cannot be correlated between installations. Input fingerprints are canonical: argument key order and the output budget (`maxBytes`) do not change them. MCP requests record the protocol version (`mcpProtocolVersion`) and the client name/version, taken from `initialize` or from request `_meta` for stateless clients. Calls to unknown tools are recorded as failed `tool_call` events with the tool name `unknown` and error category `unknown_tool`. Errors for unavailable integrations (not installed, not indexed, not running) use `unavailable_integration`.

## Reading telemetry show

telemetry show is the raw event stream grouped by configuration and session. Use it when exact event order, timestamps, event fields, or individual failures matter.

## Reading telemetry summary

telemetry summary is an aggregation for humans and agents. Prefer its separate MCP/tool/command success rates and per-tool/per-command metrics for reliability analysis. Use the raw stream when investigating a specific request or reconstructing event order. Raw tool events currently provide the token-size, fingerprint, duplicate-output, and file-metadata signals described above; aggregated summary fields for those measurements have not yet been added.

## Data quality rules

Telemetry should be treated as measurement data, not as a complete audit log:

1. Session records are only emitted when a handler closes normally through Agent Dir shutdown.
2. An active session may therefore have no session event yet.
3. Legacy persisted session records without the current timing fields are identified separately and are not used as current session timing data.
4. Event counts include session records, because they are recorded telemetry events; success rates exclude session records because sessions are summaries, not operations.
5. MCP request and tool events are deliberately not combined into one reliability denominator.
