import type { TelemetrySummary } from "./telemetry/aggregate.js";
import type { TelemetryEnvelope } from "./telemetry/types.js";
import { isRecord } from "./validation.js";

type AnalyticsConfigSummary = TelemetrySummary["configs"][string];

function compactClientSplit(clients: Record<string, number>) {
  const sorted = Object.entries(clients).sort(
    ([leftName, leftCount], [rightName, rightCount]) =>
      rightCount - leftCount || leftName.localeCompare(rightName),
  );
  const top = sorted.slice(0, 10).map(([client, requests]) => ({ client, requests }));
  const otherRequests = sorted.slice(10).reduce((total, [, requests]) => total + requests, 0);
  return { top, ...(otherRequests > 0 ? { otherRequests } : {}) };
}

export function compactAnalyticsConfig(config: AnalyticsConfigSummary) {
  const issues = [
    ...Object.entries(config.failuresByCategory.mcp).map(([issue, count]) => ({
      event: "mcp_request",
      issue,
      count,
    })),
    ...Object.entries(config.tools)
      .filter(([, tool]) => tool.failures > 0)
      .map(([issue, tool]) => ({ event: "tool_call", issue, count: tool.failures })),
    ...Object.entries(config.commands)
      .filter(([, command]) => command.failures > 0)
      .map(([issue, command]) => ({ event: "command_call", issue, count: command.failures })),
  ]
    .sort(
      (left, right) =>
        right.count - left.count ||
        left.event.localeCompare(right.event) ||
        left.issue.localeCompare(right.issue),
    )
    .slice(0, 5);
  return {
    eventCount: config.eventCount,
    httpRequests: config.httpRequests,
    httpAuthFailures: config.httpAuthFailures,
    httpErrors: config.httpErrors,
    mcpRequests: config.mcpRequests,
    mcpRequestsByMethod: config.mcpRequestsByMethod,
    toolCalls: config.toolCalls,
    commandCalls: config.commandCalls,
    tunnelEvents: config.tunnelEvents,
    tunnelFailures: config.tunnelFailures,
    successRates: {
      mcp: config.mcpSuccessRate,
      tools: config.toolSuccessRate,
      commands: config.commandSuccessRate,
    },
    topIssues: issues,
    clients: compactClientSplit(config.efficiency.clients),
    sessionCount: Object.keys(config.sessions).length,
    legacySessionEvents: config.legacySessionEvents,
    efficiency: {
      estimatedOutputTokens: config.efficiency.estimatedOutputTokens,
      duplicateOutputCalls: config.efficiency.duplicateOutputCalls,
      duplicateOutputBytes: config.efficiency.duplicateOutputBytes,
      duplicateInputCalls: config.efficiency.duplicateInputCalls,
      repeatedFileReadCalls: config.efficiency.repeatedFileReadCalls,
      searchThenReadTransitions: config.efficiency.searchThenReadTransitions,
      readSpans: config.efficiency.readSpans,
    },
  };
}

interface AnalyticsFailureGroup {
  event: string;
  tool?: string;
  commandFamily?: string;
  method?: string;
  category?: string;
  reason?: string;
  count: number;
  first: string;
  last: string;
}

export function sessionFailureGroups(events: TelemetryEnvelope[]): AnalyticsFailureGroup[] {
  const failures = new Map<string, AnalyticsFailureGroup>();
  for (const envelope of events) {
    const event = envelope.event;
    if (!("success" in event) || event.success) continue;
    const tool = "tool" in event ? event.tool : undefined;
    const commandFamily = "commandFamily" in event ? event.commandFamily : undefined;
    const method = "method" in event ? event.method : undefined;
    const category = "errorCategory" in event ? event.errorCategory : undefined;
    const reason = "errorReason" in event ? event.errorReason : undefined;
    const key = JSON.stringify([event.event, tool, commandFamily, method, category, reason]);
    const group = failures.get(key);
    if (group) {
      group.count += 1;
      group.last = envelope.timestamp;
    } else {
      failures.set(key, {
        event: event.event,
        ...(tool ? { tool } : {}),
        ...(commandFamily ? { commandFamily } : {}),
        ...(method ? { method } : {}),
        ...(category ? { category } : {}),
        ...(reason ? { reason } : {}),
        count: 1,
        first: envelope.timestamp,
        last: envelope.timestamp,
      });
    }
  }
  return [...failures.values()];
}

const ANALYTICS_TRUNCATION_NOTE =
  "Result exceeded maxBytes; narrow by profile/session/time range or lower limit.";

/**
 * Keeps analytics output valid structured data: trims arrays or detail keys, never cuts JSON text.
 * The budget is measured on the whole response envelope, because that is what the client pays for.
 */
export function fitAnalyticsResult(
  result: Record<string, unknown>,
  maxBytes: number,
  measureEnvelope: (value: Record<string, unknown>) => number,
): Record<string, unknown> {
  const size = measureEnvelope;
  if (size(result) <= maxBytes) return { ...result, truncated: false };
  for (const key of ["events", "sessions"] as const) {
    const items = result[key];
    if (!Array.isArray(items)) continue;
    let kept: unknown[] = items;
    const build = () => ({
      ...result,
      [key]: kept,
      truncated: true,
      returned: kept.length,
      note: ANALYTICS_TRUNCATION_NOTE,
    });
    while (kept.length > 0 && size(build()) > maxBytes)
      kept = kept.slice(Math.ceil(kept.length / 4));
    return build();
  }
  const configs = isRecord(result.configs) ? result.configs : {};
  const slim = Object.fromEntries(
    Object.entries(configs).map(([configId, config]) => [
      configId,
      isRecord(config)
        ? Object.fromEntries(
            Object.entries(config).filter(
              ([key]) => key !== "tools" && key !== "commands" && key !== "failuresByCategory",
            ),
          )
        : config,
    ]),
  );
  const reduced = { ...result, configs: slim, truncated: true, note: ANALYTICS_TRUNCATION_NOTE };
  if (size(reduced) <= maxBytes) return reduced;
  return {
    mode: result.mode,
    matchedEvents: result.matchedEvents,
    configs: Object.keys(configs),
    truncated: true,
    note: ANALYTICS_TRUNCATION_NOTE,
  };
}
