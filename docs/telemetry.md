# Telemetry interpretation

Agent Dir telemetry is a local operational record of MCP activity. It describes what the server handled, how long it took, and where failures occurred without recording project contents, command arguments, tokens, environment variables, or project paths.

## Data hierarchy

Telemetry is organized as:

configuration → session → event

- **Configuration** identifies the Agent Dir configuration that produced the event. Named profiles use the profile name; direct CLI configurations use a stable hash of the effective share configuration.
- **Session** identifies one MCP handler lifetime. A session starts with its first MCP request and is finalized when the server closes the handler.
- **Event** is one recorded operation or one session-finalization record.

## Event types

### mcp_request

One MCP/JSON-RPC request handled by Agent Dir. Its duration covers the request from entry through response/error handling.

### tool_call

One Agent Dir tool execution inside an MCP request. Tool metrics are the best measure of individual Agent Dir capability reliability.

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

Telemetry is persisted locally only when enabled. Persistence failures must never affect MCP request handling.

## Reading telemetry show

telemetry show is the raw event stream grouped by configuration and session. Use it when exact event order, timestamps, event fields, or individual failures matter.

## Reading telemetry summary

telemetry summary is an aggregation for humans and agents. Prefer its separate MCP/tool/command success rates and per-tool/per-command metrics for reliability analysis. Use the raw stream when investigating a specific request or reconstructing event order.

## Data quality rules

Telemetry should be treated as measurement data, not as a complete audit log:

1. Session records are only emitted when a handler closes normally through Agent Dir shutdown.
2. An active session may therefore have no session event yet.
3. Legacy persisted session records without the current timing fields are identified separately and are not used as current session timing data.
4. Event counts include session records, because they are recorded telemetry events; success rates exclude session records because sessions are summaries, not operations.
5. MCP request and tool events are deliberately not combined into one reliability denominator.