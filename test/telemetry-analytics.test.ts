import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createMcpHandler } from "../src/mcp.js";
import type { TelemetryEnvelope } from "../src/telemetry/types.js";

const TELEMETRY_DIRECTORY = path.join(homedir(), ".config", "agent-dir", "telemetry");
const BASE_TIME = Date.parse("2026-11-06T00:00:00.000Z");
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "analytics-test", version: "1.0.0" },
};

function envelope(
  configId: string,
  sessionId: string,
  offsetMs: number,
  event: TelemetryEnvelope["event"],
  client: string,
): TelemetryEnvelope {
  return {
    schemaVersion: 1,
    timestamp: new Date(BASE_TIME + offsetMs).toISOString(),
    configId,
    sessionId,
    level: "anonymous",
    event,
    runtime: {
      agentDirVersion: "3.0.0",
      nodeMajor: 22,
      os: "linux",
      arch: "x64",
      mcpClientName: client,
      mcpClientVersion: "1.0.0",
    },
  };
}

async function writeFixture(profile: string): Promise<void> {
  const profileDirectory = path.join(TELEMETRY_DIRECTORY, profile);
  await mkdir(profileDirectory, { recursive: false, mode: 0o700 });
  const sessions = new Map<string, TelemetryEnvelope[]>();
  const add = (event: TelemetryEnvelope) => {
    const group = sessions.get(event.sessionId) ?? [];
    group.push(event);
    sessions.set(event.sessionId, group);
  };

  for (let index = 0; index < 30; index += 1) {
    const sessionId = `session-${index}`;
    const client = `client-${String(index).padStart(2, "0")}`;
    add(
      envelope(
        profile,
        sessionId,
        index * 2,
        {
          event: "mcp_request",
          method: "tools/call",
          success: true,
          durationMs: 2,
        },
        client,
      ),
    );
    add(
      envelope(
        profile,
        sessionId,
        index * 2 + 1,
        {
          event: "tool_call",
          tool: `tool-${index}`,
          success: false,
          durationMs: 10,
          errorCategory: "execution",
          errorReason: "other",
        },
        client,
      ),
    );
  }

  for (let index = 0; index < 3; index += 1) {
    add(
      envelope(
        profile,
        "repeat-session",
        1000 + index,
        {
          event: "tool_call",
          tool: "repeated-tool",
          success: false,
          durationMs: 10,
          errorCategory: "execution",
          errorReason: "other",
        },
        "client-00",
      ),
    );
  }
  add(
    envelope(
      profile,
      "repeat-session",
      1003,
      {
        event: "tool_call",
        tool: "different-tool",
        success: false,
        durationMs: 10,
        errorCategory: "timeout",
        errorReason: "other",
      },
      "client-00",
    ),
  );

  await Promise.all(
    [...sessions.entries()].map(([sessionId, events]) =>
      writeFile(
        path.join(profileDirectory, `session-${sessionId}.jsonl`),
        `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
        { mode: 0o600 },
      ),
    ),
  );
}

async function analytics(
  handler: ReturnType<typeof createMcpHandler>,
  argumentsValue: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await handler(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "telemetry_analytics", arguments: argumentsValue, _meta: META },
      }),
    }),
  );
  const body = (await response.json()) as {
    result?: { isError?: boolean; content?: Array<{ text: string }> };
  };
  const text = body.result?.content?.[0]?.text ?? "{}";
  assert.equal(body.result?.isError, undefined, text);
  return JSON.parse(text) as Record<string, unknown>;
}

test("telemetry analytics defaults to a compact summary with clients and top issues", async () => {
  const profile = `p08-test-${randomUUID()}`;
  const profileDirectory = path.join(TELEMETRY_DIRECTORY, profile);
  await mkdir(TELEMETRY_DIRECTORY, { recursive: true, mode: 0o700 });
  const handler = createMcpHandler(process.cwd(), {}, { level: "none" }, undefined, true);
  try {
    await writeFixture(profile);
    const compact = await analytics(handler, { profile });
    const serialized = JSON.stringify(compact);
    assert.equal(compact.mode, "summary");
    assert.equal(compact.view, "compact");
    assert.equal(compact.truncated, false);
    assert.ok(Buffer.byteLength(serialized, "utf8") <= 8_000);
    assert.ok(Math.ceil(Buffer.byteLength(serialized, "utf8") / 4) <= 2_000);

    const configs = compact.configs as Record<string, Record<string, unknown>>;
    const config = configs[profile];
    assert.ok(config);
    assert.deepEqual(config.mcpRequestsByMethod, { "tools/call": 30 });
    assert.equal((config.topIssues as unknown[]).length, 5);
    assert.equal(config.tools, undefined);
    const clients = config.clients as {
      top: Array<{ client: string; requests: number }>;
      otherRequests?: number;
    };
    assert.equal(clients.top.length, 10);
    assert.ok((clients.otherRequests ?? 0) > 0);

    const full = await analytics(handler, { profile, view: "full", maxBytes: 64_000 });
    const fullConfigs = full.configs as Record<string, Record<string, unknown>>;
    assert.equal(full.view, "full");
    assert.equal(Object.keys(fullConfigs[profile]?.tools as object).length, 32);

    const excluded = await analytics(handler, {
      profile,
      excludeClients: ["client-00", "client-01"],
    });
    assert.equal(excluded.matchedEvents, (compact.matchedEvents as number) - 8);
    const filteredConfig = (excluded.configs as Record<string, Record<string, unknown>>)[profile];
    const filteredClients = filteredConfig?.clients as {
      top: Array<{ client: string; requests: number }>;
    };
    assert.ok(filteredClients.top.every(({ client }) => !client.startsWith("client-00@")));
    assert.ok(filteredClients.top.every(({ client }) => !client.startsWith("client-01@")));

    const sessions = await analytics(handler, {
      mode: "sessions",
      profile,
      session: "repeat-session",
    });
    const session = (sessions.sessions as Array<Record<string, unknown>>)[0];
    const failures = session?.failures as Array<Record<string, unknown>>;
    const repeated = failures.find((failure) => failure.tool === "repeated-tool");
    assert.equal(repeated?.event, "tool_call");
    assert.equal(repeated?.count, 3);
    assert.equal(repeated?.first, new Date(BASE_TIME + 1000).toISOString());
    assert.equal(repeated?.last, new Date(BASE_TIME + 1002).toISOString());
    assert.equal(failures.length, 2);
  } finally {
    handler.closeSubscriptions();
    await rm(profileDirectory, { recursive: true, force: true });
  }
});
