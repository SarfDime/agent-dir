import assert from "node:assert/strict";
import test from "node:test";
import { summarizeTelemetry } from "../src/telemetry/aggregate.js";
import type { TelemetryEnvelope } from "../src/telemetry/types.js";

const START = Date.parse("2026-10-18T10:00:00.000Z");

function call(
  offsetMs: number,
  tool: string,
  extra: Record<string, unknown> = {},
  session = "s1",
): TelemetryEnvelope {
  return {
    schemaVersion: 1,
    timestamp: new Date(START + offsetMs).toISOString(),
    configId: "p",
    sessionId: session,
    level: "basic",
    event: {
      event: "tool_call",
      tool,
      success: true,
      durationMs: 1,
      estimatedOutputTokens: 100,
      ...extra,
    },
  } as TelemetryEnvelope;
}

test("efficiency summary measures duplicates, truncation, search-then-read and episodes", () => {
  const summary = summarizeTelemetry([
    call(0, "search_code", { inputFingerprint: "f1", resultCount: 0 }),
    call(1_000, "read_range", {
      files: [{ pathHash: "p1", bytes: 10 }],
      estimatedOutputTokens: 300,
    }),
    call(2_000, "read_range", {
      files: [{ pathHash: "p1", bytes: 10 }],
      truncated: true,
      estimatedOutputTokens: 300,
      duplicateOutputBytes: 50,
    }),
    call(3_000, "search_code", { inputFingerprint: "f1", resultCount: 5 }),
    // More than ten minutes later: a new episode, not a transition.
    call(20 * 60_000, "read_range", { files: [{ pathHash: "p2", bytes: 10 }] }),
    call(21 * 60_000, "run_command_batch", { success: false, errorCategory: "timeout" }, "s2"),
  ]);
  const efficiency = summary.configs.p?.efficiency;
  assert.ok(efficiency);
  assert.equal(efficiency.estimatedOutputTokens, 1000);
  assert.equal(efficiency.duplicateInputCalls, 1);
  assert.equal(efficiency.repeatedFileReadCalls, 1);
  assert.equal(efficiency.duplicateOutputCalls, 1);
  assert.equal(efficiency.duplicateOutputBytes, 50);
  assert.equal(efficiency.searchThenReadTransitions, 1);
  assert.equal(efficiency.episodes.count, 3);
  assert.equal(efficiency.episodes.callsMax, 4);

  const reads = efficiency.tools.read_range;
  assert.equal(reads?.calls, 3);
  assert.equal(reads?.truncatedRatePercent, 33.3);
  assert.equal(reads?.outcomes.truncated, 1);
  assert.equal(efficiency.tools.search_code?.emptyRatePercent, 50);
  assert.equal(efficiency.tools.run_command_batch?.outcomes.error, 1);
  assert.equal(efficiency.tools.read_range?.tokenSharePercent, 70);
  assert.deepEqual(efficiency.topTransitions[0], {
    from: "search_code",
    to: "read_range",
    count: 1,
  });
});

test("efficiency summary reports client and protocol usage from MCP requests", () => {
  const request = (version: string, name: string): TelemetryEnvelope =>
    ({
      schemaVersion: 1,
      timestamp: new Date(START).toISOString(),
      configId: "p",
      sessionId: "s1",
      level: "basic",
      event: { event: "mcp_request", method: "server/discover", success: true, durationMs: 1 },
      runtime: {
        agentDirVersion: "1.3.0",
        nodeMajor: 24,
        os: "linux",
        arch: "x64",
        mcpClientName: name,
        mcpClientVersion: "1.0.0",
        mcpProtocolVersion: version,
      },
    }) as TelemetryEnvelope;
  const summary = summarizeTelemetry([
    request("2026-07-28", "Anthropic/ClaudeAI"),
    request("2026-07-28", "Anthropic/ClaudeAI"),
    request("2025-11-25", "other"),
  ]);
  assert.deepEqual(summary.configs.p?.efficiency.protocolVersions, {
    "2026-07-28": 2,
    "2025-11-25": 1,
  });
  assert.equal(summary.configs.p?.efficiency.clients["Anthropic/ClaudeAI@1.0.0"], 2);
});
