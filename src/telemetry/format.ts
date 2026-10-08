import type { TelemetrySummary } from "./aggregate.js";

function duration(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function rate(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function line(char = "─", width = 66): string {
  return char.repeat(width);
}

function metric(label: string, value: string | number): string {
  return `  ${label.padEnd(24)}${value}`;
}

function formatTable(
  entries: Array<{
    name: string;
    calls: number;
    successRate: number;
    avgDurationMs: number;
    p95DurationMs: number;
  }>,
): string[] {
  if (entries.length === 0) return ["  None recorded."];

  const sorted = [...entries].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  const nameWidth = Math.min(28, Math.max(4, ...sorted.map((entry) => entry.name.length)));

  return [
    `  ${"Name".padEnd(nameWidth)}  Calls  Success  Avg       P95`,
    `  ${"─".repeat(nameWidth)}  ─────  ───────  ───────  ───────`,
    ...sorted.map(
      (entry) =>
        `  ${entry.name.padEnd(nameWidth)}  ${String(entry.calls).padStart(5)}  ${rate(entry.successRate).padStart(7)}  ${duration(entry.avgDurationMs).padStart(7)}  ${duration(entry.p95DurationMs).padStart(7)}`,
    ),
  ];
}

export function formatTelemetrySummary(summary: TelemetrySummary, level: string): string {
  const output: string[] = [
    "",
    "  AGENT-DIR TELEMETRY SUMMARY",
    `  ${line()}`,
    metric("Telemetry level", level),
    metric("Configurations", summary.configCount),
    metric("Recorded events", summary.totalEvents),
  ];

  if (summary.configCount === 0) {
    output.push("", "  No telemetry events recorded.", "");
    return output.join("\n");
  }

  for (const [configId, config] of Object.entries(summary.configs)) {
    output.push(
      "",
      `  CONFIGURATION  ${configId}`,
      `  ${line("─", 66)}`,
      metric("Events", config.eventCount),
      metric("HTTP requests", config.httpRequests),
      metric("HTTP auth failures", config.httpAuthFailures),
      metric("HTTP errors", config.httpErrors),
      metric("MCP requests", config.mcpRequests),
      metric("Tool calls", config.toolCalls),
      metric("Command calls", config.commandCalls),
      metric("Tunnel events", config.tunnelEvents),
      metric("Tunnel disconnects", config.tunnelDisconnects),
      metric("Tunnel reconnects", config.tunnelReconnects),
      metric("Tunnel failures", config.tunnelFailures),
      metric("MCP success", rate(config.mcpSuccessRate)),
      metric("Tool success", rate(config.toolSuccessRate)),
      metric("Command success", rate(config.commandSuccessRate)),
      "",
      "  SESSIONS",
      metric("Sessions", Object.keys(config.sessions).length),
    );

    if (config.legacySessionEvents > 0) {
      output.push(
        metric("Legacy sessions", config.legacySessionEvents),
        "  Legacy session records are excluded from session averages.",
      );
    }

    const sessionEntries = Object.entries(config.sessions);
    if (sessionEntries.length > 0) {
      output.push("", "  SESSION DETAILS");
      for (const [sessionId, session] of sessionEntries) {
        output.push(`  ${sessionId}`);
        output.push(
          metric("Events", session.eventCount),
          metric("MCP requests", session.mcpRequests),
          metric("Tool calls", session.toolCalls),
          metric("Command calls", session.commandCalls),
          metric("MCP success", rate(session.mcpSuccessRate)),
          metric("Tool success", rate(session.toolSuccessRate)),
          metric("Command success", rate(session.commandSuccessRate)),
        );
        if (session.wallClockDurationMs !== undefined)
          output.push(
            metric("Wall-clock", duration(session.wallClockDurationMs)),
            metric("Active requests", duration(session.activeRequestDurationMs ?? 0)),
            metric("Idle gaps", duration(session.idleGapDurationMs ?? 0)),
            metric("Requests/session", session.requestCount ?? 0),
            metric("Tools/session", session.toolCallCount ?? 0),
            metric("Commands/session", session.commandCallCount ?? 0),
          );
      }
    }
    output.push(
      "",
      "  SUCCESS RATES",
      "  MCP requests, tool calls, and command calls are measured separately.",
      "  Do not combine them into one overall success rate.",
      "",
      "  TOOL USAGE",
      ...formatTable(Object.entries(config.tools).map(([name, item]) => ({ name, ...item }))),
      "",
      "  COMMAND USAGE",
      ...formatTable(Object.entries(config.commands).map(([name, item]) => ({ name, ...item }))),
    );

    output.push("", "  FAILURES");
    const failureGroups = [
      ["MCP", config.failuresByCategory.mcp],
      ["TOOLS", config.failuresByCategory.tool],
      ["COMMANDS", config.failuresByCategory.command],
    ] as const;
    let hasFailures = false;
    for (const [label, failures] of failureGroups) {
      const entries = Object.entries(failures).sort(([, a], [, b]) => b - a);
      if (entries.length === 0) continue;
      hasFailures = true;
      output.push(`  ${label}`);
      for (const [category, count] of entries) output.push(`  ${category.padEnd(28)}${count}`);
    }
    if (!hasFailures) output.push("  None recorded.");
  }

  output.push(
    "",
    `  ${line()}`,
    "  Success rates are per event type; MCP and tool events are related but distinct.",
    "  Use 'telemetry show' for the raw event stream.",
    "",
  );
  return output.join("\n");
}
