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
