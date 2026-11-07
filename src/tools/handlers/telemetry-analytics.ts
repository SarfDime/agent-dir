import {
  compactAnalyticsConfig,
  fitAnalyticsResult,
  sessionFailureGroups,
} from "../../analytics-format.js";
import { summarizeTelemetry } from "../../telemetry/aggregate.js";
import { readTelemetryEvents } from "../../telemetry/storage.js";
import type { TelemetryEnvelope } from "../../telemetry/types.js";
import { outputBytesArg } from "./arguments.js";
import type { ToolCallOutput } from "./types.js";

function matchesClient(event: TelemetryEnvelope, filter: string): boolean {
  const name = event.runtime?.mcpClientName?.toLowerCase();
  if (!name) return false;
  if (name === filter) return true;
  const version = event.runtime?.mcpClientVersion?.toLowerCase();
  if (version !== undefined && `${name}@${version}` === filter) return true;
  return name.startsWith(`${filter}@`) || name.startsWith(filter);
}

function sessionClient(events: TelemetryEnvelope[]): string | undefined {
  const counts = new Map<string, number>();
  for (const event of events) {
    const name = event.runtime?.mcpClientName;
    if (!name) continue;
    const label = `${name}@${event.runtime?.mcpClientVersion ?? "?"}`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export async function handleTelemetryAnalytics(
  args: Record<string, unknown>,
  enabled: boolean,
  measureEnvelope: (value: Record<string, unknown>) => number,
): Promise<ToolCallOutput> {
  if (!enabled)
    throw new Error("Telemetry analytics is disabled; start Agent Dir with --analytics.");
  const mode = typeof args.mode === "string" ? args.mode : "summary";
  if (!["summary", "sessions", "events"].includes(mode))
    throw new Error("mode must be summary, sessions, or events.");
  const limit = Math.max(1, Math.min(500, Number.isInteger(args.limit) ? Number(args.limit) : 100));
  const since = typeof args.since === "string" ? Date.parse(args.since) : Number.NEGATIVE_INFINITY;
  const until = typeof args.until === "string" ? Date.parse(args.until) : Number.POSITIVE_INFINITY;
  if (Number.isNaN(since) || Number.isNaN(until))
    throw new Error("since and until must be valid ISO timestamps.");
  const clientFilter =
    typeof args.client === "string" && args.client.trim()
      ? args.client.trim().toLowerCase()
      : undefined;
  const excludedClientFilters: string[] = [];
  if (args.excludeClients !== undefined) {
    if (!Array.isArray(args.excludeClients) || args.excludeClients.length > 20)
      throw new Error("excludeClients must be an array of at most 20 client names.");
    for (const client of args.excludeClients) {
      if (typeof client !== "string" || client.length > 100)
        throw new Error("excludeClients must contain strings of at most 100 characters.");
      if (client.trim()) excludedClientFilters.push(client.trim().toLowerCase());
    }
  }
  const all = readTelemetryEvents({
    ...(typeof args.profile === "string" && args.profile ? { profile: args.profile } : {}),
    ...(typeof args.session === "string" && args.session ? { session: args.session } : {}),
    ...(Number.isFinite(since) ? { sinceMs: since } : {}),
  }).filter(
    (event) =>
      (!args.profile || event.configId === args.profile) &&
      (!args.session || event.sessionId === args.session) &&
      (!clientFilter || matchesClient(event, clientFilter)) &&
      !excludedClientFilters.some((filter) => matchesClient(event, filter)) &&
      Date.parse(event.timestamp) >= since &&
      Date.parse(event.timestamp) <= until,
  );
  let result: Record<string, unknown>;
  if (mode === "summary") {
    const view = typeof args.view === "string" ? args.view : "compact";
    if (!["compact", "full"].includes(view)) throw new Error("view must be compact or full.");
    const summary = summarizeTelemetry(all);
    result = {
      mode,
      view,
      matchedEvents: all.length,
      configCount: summary.configCount,
      totalEvents: summary.totalEvents,
      configs: Object.fromEntries(
        Object.entries(summary.configs).map(([configId, config]) => [
          configId,
          view === "full"
            ? {
                eventCount: config.eventCount,
                httpRequests: config.httpRequests,
                httpAuthFailures: config.httpAuthFailures,
                httpErrors: config.httpErrors,
                mcpRequests: config.mcpRequests,
                mcpRequestsByMethod: config.mcpRequestsByMethod,
                toolCalls: config.toolCalls,
                commandCalls: config.commandCalls,
                tunnelEvents: config.tunnelEvents,
                tunnelDisconnects: config.tunnelDisconnects,
                tunnelReconnects: config.tunnelReconnects,
                tunnelFailures: config.tunnelFailures,
                mcpSuccessRate: config.mcpSuccessRate,
                toolSuccessRate: config.toolSuccessRate,
                commandSuccessRate: config.commandSuccessRate,
                failuresByCategory: config.failuresByCategory,
                tools: config.tools,
                commands: config.commands,
                sessionCount: Object.keys(config.sessions).length,
                legacySessionEvents: config.legacySessionEvents,
                efficiency: config.efficiency,
              }
            : compactAnalyticsConfig(config),
        ]),
      ),
    };
  } else if (mode === "sessions") {
    const groups = new Map<string, typeof all>();
    for (const event of all) {
      const key = `${event.configId}/${event.sessionId}`;
      const group = groups.get(key) ?? [];
      group.push(event);
      groups.set(key, group);
    }
    result = {
      mode,
      matchedEvents: all.length,
      sessions: [...groups.entries()].slice(-limit).map(([key, events]) => ({
        key,
        client: sessionClient(events),
        eventCount: events.length,
        start: events[0]?.timestamp,
        end: events.at(-1)?.timestamp,
        tools: events
          .filter((event) => event.event.event === "tool_call")
          .reduce<Record<string, number>>((counts, event) => {
            if (event.event.event === "tool_call")
              counts[event.event.tool] = (counts[event.event.tool] ?? 0) + 1;
            return counts;
          }, {}),
        failures: sessionFailureGroups(events),
      })),
    };
  } else {
    result = {
      mode,
      matchedEvents: all.length,
      events: all.slice(-limit).map((item) => ({
        timestamp: item.timestamp,
        configId: item.configId,
        sessionId: item.sessionId,
        level: item.level,
        event:
          item.event.event === "tool_call"
            ? Object.fromEntries(
                Object.entries(item.event).filter(([key]) => key !== "diagnosticDetails"),
              )
            : item.event,
        runtime: item.runtime
          ? {
              agentDirVersion: item.runtime.agentDirVersion,
              nodeMajor: item.runtime.nodeMajor,
              os: item.runtime.os,
              arch: item.runtime.arch,
              mcpClientName: item.runtime.mcpClientName,
              mcpClientVersion: item.runtime.mcpClientVersion,
              mcpProtocolVersion: item.runtime.mcpProtocolVersion,
            }
          : undefined,
        project: item.project
          ? {
              language: item.project.language,
              framework: item.project.framework,
              packageManager: item.project.packageManager,
              hasGit: item.project.hasGit,
              hasCodegraph: item.project.hasCodegraph,
              projectSize: item.project.projectSize,
            }
          : undefined,
      })),
    };
  }
  return {
    payload: fitAnalyticsResult(result, outputBytesArg(args.maxBytes), measureEnvelope),
  };
}
