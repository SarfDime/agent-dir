import type { TelemetryEnvelope } from "./types.js";

export interface TelemetrySummary {
  configCount: number;
  totalEvents: number;
  configs: Record<
    string,
    {
      eventCount: number;
      httpRequests: number;
      httpAuthFailures: number;
      httpErrors: number;
      mcpRequests: number;
      toolCalls: number;
      commandCalls: number;
      tunnelEvents: number;
      tunnelDisconnects: number;
      tunnelReconnects: number;
      tunnelFailures: number;
      mcpSuccessRate: number | null;
      toolSuccessRate: number | null;
      commandSuccessRate: number | null;
      failuresByCategory: {
        mcp: Record<string, number>;
        tool: Record<string, number>;
        command: Record<string, number>;
      };
      tools: Record<
        string,
        {
          calls: number;
          successes: number;
          failures: number;
          successRate: number;
          avgDurationMs: number;
          p95DurationMs: number;
        }
      >;
      commands: Record<
        string,
        {
          calls: number;
          successes: number;
          failures: number;
          successRate: number;
          avgDurationMs: number;
          p95DurationMs: number;
        }
      >;
      legacySessionEvents: number;
      efficiency: TelemetryEfficiency;
      sessions: Record<
        string,
        {
          eventCount: number;
          mcpRequests: number;
          toolCalls: number;
          commandCalls: number;
          mcpSuccessRate: number | null;
          toolSuccessRate: number | null;
          commandSuccessRate: number | null;
          failuresByCategory: {
            mcp: Record<string, number>;
            tool: Record<string, number>;
            command: Record<string, number>;
          };
          wallClockDurationMs?: number;
          activeRequestDurationMs?: number;
          idleGapDurationMs?: number;
          requestCount?: number;
          toolCallCount?: number;
          commandCallCount?: number;
        }
      >;
    }
  >;
}

type Bucket = {
  eventCount: number;
  successes: number;
  failures: number;
  durations: number[];
  failuresByCategory: Record<string, number>;
};

function bucket(): Bucket {
  return { eventCount: 0, successes: 0, failures: 0, durations: [], failuresByCategory: {} };
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function rate(successes: number, total: number): number {
  return total === 0 ? 0 : Math.round((successes / total) * 1000) / 10;
}

function rateForEvents(
  events: TelemetryEnvelope[],
  kind: "mcp_request" | "tool_call" | "command_call",
): number | null {
  const matching = events.filter((item) => item.event.event === kind);
  return matching.length === 0
    ? null
    : rate(
        matching.filter((item) => "success" in item.event && item.event.success).length,
        matching.length,
      );
}

function collectFailures(
  events: TelemetryEnvelope[],
  kind: "mcp_request" | "tool_call" | "command_call",
): Record<string, number> {
  const failures: Record<string, number> = {};
  for (const envelope of events) {
    if (
      envelope.event.event !== kind ||
      !("success" in envelope.event) ||
      envelope.event.success ||
      !envelope.event.errorCategory
    )
      continue;
    failures[envelope.event.errorCategory] = (failures[envelope.event.errorCategory] ?? 0) + 1;
  }
  return failures;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export interface TelemetryEfficiency {
  estimatedOutputTokens: number;
  /** Calls whose output was identical to an earlier output in the same process. */
  duplicateOutputCalls: number;
  duplicateOutputBytes: number;
  /** Calls repeating an earlier call (same tool and canonical arguments) in the same session. */
  duplicateInputCalls: number;
  /** read_range calls on a file already read earlier in the same session. */
  repeatedFileReadCalls: number;
  searchThenReadTransitions: number;
  /** Calls grouped into episodes separated by an idle gap; sessions are process lifetimes. */
  episodes: { count: number; callsMedian: number; callsMax: number; idleGapMinutes: number };
  tools: Record<
    string,
    {
      calls: number;
      estimatedOutputTokens: number;
      tokenSharePercent: number;
      avgOutputTokens: number;
      outcomes: Record<string, number>;
      truncatedRatePercent: number;
      emptyRatePercent: number;
      duplicateOutputCalls: number;
    }
  >;
  topTransitions: Array<{ from: string; to: string; count: number }>;
  clients: Record<string, number>;
  protocolVersions: Record<string, number>;
}

const EPISODE_IDLE_GAP_MS = 10 * 60 * 1000;
const SEARCH_TOOLS = new Set([
  "search_code",
  "find_symbol",
  "find_references",
  "ast_grep_search",
  "codegraph_explore",
  "serena_search_for_pattern",
  "serena_find_symbol",
  "serena_find_referencing_symbols",
]);

type ToolCallEvent = Extract<TelemetryEnvelope["event"], { event: "tool_call" }>;

function outcomeOf(event: ToolCallEvent): string {
  if (event.outcome) return event.outcome;
  if (!event.success) return "error";
  if (event.truncated) return "truncated";
  if (event.resultCount === 0) return "empty";
  return "ok";
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Efficiency metrics derived only from recorded events; never invents unmeasured values. */
function summarizeEfficiency(group: TelemetryEnvelope[]): TelemetryEfficiency {
  const calls = group
    .flatMap((envelope) =>
      envelope.event.event === "tool_call" ? [{ envelope, event: envelope.event }] : [],
    )
    .sort((a, b) => a.envelope.timestamp.localeCompare(b.envelope.timestamp));

  const tools = new Map<
    string,
    {
      calls: number;
      tokens: number;
      outcomes: Record<string, number>;
      duplicates: number;
    }
  >();
  const transitions = new Map<string, number>();
  const lastBySession = new Map<string, { tool: string; time: number; episodeCalls: number }>();
  const seenInputs = new Set<string>();
  const readPaths = new Set<string>();
  const episodeCalls: number[] = [];
  let totalTokens = 0;
  let duplicateOutputCalls = 0;
  let duplicateOutputBytes = 0;
  let duplicateInputCalls = 0;
  let repeatedFileReadCalls = 0;
  let searchThenReadTransitions = 0;

  for (const { envelope, event } of calls) {
    const tokens = event.estimatedOutputTokens ?? 0;
    totalTokens += tokens;
    const item = tools.get(event.tool) ?? { calls: 0, tokens: 0, outcomes: {}, duplicates: 0 };
    item.calls += 1;
    item.tokens += tokens;
    const outcome = outcomeOf(event);
    item.outcomes[outcome] = (item.outcomes[outcome] ?? 0) + 1;
    if ((event.duplicateOutputBytes ?? 0) > 0) {
      item.duplicates += 1;
      duplicateOutputCalls += 1;
      duplicateOutputBytes += event.duplicateOutputBytes ?? 0;
    }
    tools.set(event.tool, item);

    const sessionKey = envelope.sessionId;
    if (event.inputFingerprint) {
      const key = `${sessionKey}|${event.inputFingerprint}`;
      if (seenInputs.has(key)) duplicateInputCalls += 1;
      seenInputs.add(key);
    }
    if (event.tool === "read_range" && event.files?.[0]) {
      const key = `${sessionKey}|${event.files[0].pathHash}`;
      if (readPaths.has(key)) repeatedFileReadCalls += 1;
      readPaths.add(key);
    }

    const time = Date.parse(envelope.timestamp);
    const previous = lastBySession.get(sessionKey);
    if (previous && time - previous.time <= EPISODE_IDLE_GAP_MS) {
      const key = `${previous.tool}>${event.tool}`;
      transitions.set(key, (transitions.get(key) ?? 0) + 1);
      if (SEARCH_TOOLS.has(previous.tool) && event.tool === "read_range")
        searchThenReadTransitions += 1;
    }
    if (previous && time - previous.time <= EPISODE_IDLE_GAP_MS) {
      lastBySession.set(sessionKey, {
        tool: event.tool,
        time,
        episodeCalls: previous.episodeCalls + 1,
      });
    } else {
      if (previous) episodeCalls.push(previous.episodeCalls);
      lastBySession.set(sessionKey, { tool: event.tool, time, episodeCalls: 1 });
    }
  }
  for (const last of lastBySession.values()) episodeCalls.push(last.episodeCalls);

  const clients: Record<string, number> = {};
  const protocolVersions: Record<string, number> = {};
  for (const envelope of group) {
    if (envelope.event.event !== "mcp_request" || !envelope.runtime) continue;
    const name = envelope.runtime.mcpClientName;
    if (name) {
      const label = `${name}@${envelope.runtime.mcpClientVersion ?? "?"}`;
      clients[label] = (clients[label] ?? 0) + 1;
    }
    const version = envelope.runtime.mcpProtocolVersion;
    if (version) protocolVersions[version] = (protocolVersions[version] ?? 0) + 1;
  }

  return {
    estimatedOutputTokens: totalTokens,
    duplicateOutputCalls,
    duplicateOutputBytes,
    duplicateInputCalls,
    repeatedFileReadCalls,
    searchThenReadTransitions,
    episodes: {
      count: episodeCalls.length,
      callsMedian: median(episodeCalls),
      callsMax: episodeCalls.length ? Math.max(...episodeCalls) : 0,
      idleGapMinutes: EPISODE_IDLE_GAP_MS / 60000,
    },
    tools: Object.fromEntries(
      [...tools.entries()]
        .sort((a, b) => b[1].tokens - a[1].tokens)
        .map(([name, item]) => [
          name,
          {
            calls: item.calls,
            estimatedOutputTokens: item.tokens,
            tokenSharePercent: rate(item.tokens, totalTokens),
            avgOutputTokens: Math.round(item.tokens / (item.calls || 1)),
            outcomes: item.outcomes,
            truncatedRatePercent: rate(item.outcomes.truncated ?? 0, item.calls),
            emptyRatePercent: rate(item.outcomes.empty ?? 0, item.calls),
            duplicateOutputCalls: item.duplicates,
          },
        ]),
    ),
    topTransitions: [...transitions.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([key, count]) => {
        const [from = "", to = ""] = key.split(">");
        return { from, to, count };
      }),
    clients,
    protocolVersions,
  };
}

export function summarizeTelemetry(events: TelemetryEnvelope[]): TelemetrySummary {
  const groups = new Map<string, TelemetryEnvelope[]>();

  for (const event of events) {
    const configId = event.configId || "unknown";
    const group = groups.get(configId) ?? [];
    group.push(event);
    groups.set(configId, group);
  }

  const configs: TelemetrySummary["configs"] = {};

  for (const [configId, group] of groups) {
    const tools = new Map<string, Bucket>();
    const commands = new Map<string, Bucket>();
    const sessions = new Map<
      string,
      {
        eventCount: number;
        mcpRequests: number;
        toolCalls: number;
        commandCalls: number;
        successes: number;
        failures: number;
        failuresByCategory: {
          mcp: Record<string, number>;
          tool: Record<string, number>;
          command: Record<string, number>;
        };
        wallClockDurationMs?: number;
        activeRequestDurationMs?: number;
        idleGapDurationMs?: number;
        requestCount?: number;
        toolCallCount?: number;
        commandCallCount?: number;
      }
    >();
    let legacySessionEvents = 0;
    let httpRequests = 0;
    let httpAuthFailures = 0;
    let httpErrors = 0;
    let mcpRequests = 0;
    let toolCalls = 0;
    let commandCalls = 0;
    let tunnelEvents = 0;
    let tunnelDisconnects = 0;
    let tunnelReconnects = 0;
    let tunnelFailures = 0;

    for (const envelope of group) {
      const event = envelope.event;
      const session = sessions.get(envelope.sessionId) ?? {
        eventCount: 0,
        mcpRequests: 0,
        toolCalls: 0,
        commandCalls: 0,
        successes: 0,
        failures: 0,
        failuresByCategory: { mcp: {}, tool: {}, command: {} },
      };
      session.eventCount += 1;
      if (event.event === "http_request") {
        httpRequests += 1;
        if (event.status === 401) httpAuthFailures += 1;
        if (event.status >= 400) httpErrors += 1;
        sessions.set(envelope.sessionId, session);
        continue;
      }
      if (event.event === "tunnel") {
        tunnelEvents += 1;
        if (event.state === "disconnected") tunnelDisconnects += 1;
        if (event.state === "reconnected") tunnelReconnects += 1;
        if (event.state === "failed") tunnelFailures += 1;
        sessions.set(envelope.sessionId, session);
        continue;
      }
      if (event.event === "session") {
        if (
          Number.isFinite(event.wallClockDurationMs) &&
          Number.isFinite(event.activeRequestDurationMs) &&
          Number.isFinite(event.idleGapDurationMs)
        ) {
          session.wallClockDurationMs = event.wallClockDurationMs;
          session.activeRequestDurationMs = event.activeRequestDurationMs;
          session.idleGapDurationMs = event.idleGapDurationMs;
          session.requestCount = event.requestCount;
          session.toolCallCount = event.toolCallCount;
          session.commandCallCount = event.commandCallCount;
        } else legacySessionEvents += 1;
        sessions.set(envelope.sessionId, session);
        continue;
      }
      session.successes += event.success ? 1 : 0;
      session.failures += event.success ? 0 : 1;
      if (!event.success && event.errorCategory) {
        const kind =
          event.event === "mcp_request" ? "mcp" : event.event === "tool_call" ? "tool" : "command";
        session.failuresByCategory[kind][event.errorCategory] =
          (session.failuresByCategory[kind][event.errorCategory] ?? 0) + 1;
      }
      if (event.event === "mcp_request") session.mcpRequests += 1;
      if (event.event === "tool_call") session.toolCalls += 1;
      if (event.event === "command_call") session.commandCalls += 1;
      sessions.set(envelope.sessionId, session);

      if (event.event === "mcp_request") {
        mcpRequests += 1;
      } else if (event.event === "tool_call") {
        toolCalls += 1;
        const item = tools.get(event.tool) ?? bucket();
        item.eventCount += 1;
        item.successes += event.success ? 1 : 0;
        item.failures += event.success ? 0 : 1;
        item.durations.push(event.durationMs);
        if (!event.success && event.errorCategory) {
          item.failuresByCategory[event.errorCategory] =
            (item.failuresByCategory[event.errorCategory] ?? 0) + 1;
        }
        tools.set(event.tool, item);
      } else if (event.event === "command_call") {
        commandCalls += 1;
        const key = event.operation
          ? `${event.commandFamily}:${event.operation}`
          : event.commandFamily;
        const item = commands.get(key) ?? bucket();
        item.eventCount += 1;
        item.successes += event.success ? 1 : 0;
        item.failures += event.success ? 0 : 1;
        item.durations.push(event.durationMs);
        if (!event.success && event.errorCategory) {
          item.failuresByCategory[event.errorCategory] =
            (item.failuresByCategory[event.errorCategory] ?? 0) + 1;
        }
        commands.set(key, item);
      }
    }

    const mapBucket = (item: Bucket) => ({
      calls: item.eventCount,
      successes: item.successes,
      failures: item.failures,
      successRate: rate(item.successes, item.eventCount),
      avgDurationMs: round(
        item.durations.reduce((sum, value) => sum + value, 0) / (item.durations.length || 1),
      ),
      p95DurationMs: round(p95(item.durations)),
    });

    configs[configId] = {
      eventCount: group.length,
      httpRequests,
      httpAuthFailures,
      httpErrors,
      mcpRequests,
      toolCalls,
      commandCalls,
      tunnelEvents,
      tunnelDisconnects,
      tunnelReconnects,
      tunnelFailures,
      mcpSuccessRate: rateForEvents(group, "mcp_request"),
      toolSuccessRate: rateForEvents(group, "tool_call"),
      commandSuccessRate: rateForEvents(group, "command_call"),
      failuresByCategory: {
        mcp: collectFailures(group, "mcp_request"),
        tool: collectFailures(group, "tool_call"),
        command: collectFailures(group, "command_call"),
      },
      tools: Object.fromEntries(
        [...tools.entries()].map(([name, item]) => [name, mapBucket(item)]),
      ),
      commands: Object.fromEntries(
        [...commands.entries()].map(([name, item]) => [name, mapBucket(item)]),
      ),
      legacySessionEvents,
      efficiency: summarizeEfficiency(group),
      sessions: Object.fromEntries(
        [...sessions.entries()].map(([sessionId, session]) => [
          sessionId,
          {
            eventCount: session.eventCount,
            mcpRequests: session.mcpRequests,
            toolCalls: session.toolCalls,
            commandCalls: session.commandCalls,
            mcpSuccessRate: rateForEvents(
              group.filter((item) => item.sessionId === sessionId),
              "mcp_request",
            ),
            toolSuccessRate: rateForEvents(
              group.filter((item) => item.sessionId === sessionId),
              "tool_call",
            ),
            commandSuccessRate: rateForEvents(
              group.filter((item) => item.sessionId === sessionId),
              "command_call",
            ),
            failuresByCategory: session.failuresByCategory,
            ...(session.wallClockDurationMs === undefined
              ? {}
              : { wallClockDurationMs: session.wallClockDurationMs }),
            ...(session.activeRequestDurationMs === undefined
              ? {}
              : { activeRequestDurationMs: session.activeRequestDurationMs }),
            ...(session.idleGapDurationMs === undefined
              ? {}
              : { idleGapDurationMs: session.idleGapDurationMs }),
            ...(session.requestCount === undefined ? {} : { requestCount: session.requestCount }),
            ...(session.toolCallCount === undefined
              ? {}
              : { toolCallCount: session.toolCallCount }),
            ...(session.commandCallCount === undefined
              ? {}
              : { commandCallCount: session.commandCallCount }),
          },
        ]),
      ),
    };
  }

  return {
    configCount: groups.size,
    totalEvents: events.length,
    configs,
  };
}
