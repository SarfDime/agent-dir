import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createMcpHandler } from "../src/mcp.js";
import {
  canonicalJson,
  fingerprintInput,
  resetTelemetryKeyForTests,
  telemetryHmac,
  usePersistentTelemetryKey,
} from "../src/telemetry/fingerprint.js";
import { createTelemetryEnvelope } from "../src/telemetry/privacy.js";

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "fingerprint-test", version: "2.3.4" },
};

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("canonical JSON and input fingerprints ignore key order and the output budget", () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: 2, c: 3 } }),
    canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
  );
  const first = fingerprintInput("read_range", { path: "a.ts", startLine: 1, maxBytes: 4000 });
  const second = fingerprintInput("read_range", { maxBytes: 16000, startLine: 1, path: "a.ts" });
  assert.equal(first, second);
  assert.notEqual(first, fingerprintInput("read_range", { path: "a.ts", startLine: 2 }));
  assert.notEqual(first, fingerprintInput("read_file", { path: "a.ts", startLine: 1 }));
});

test("telemetry hashes are keyed per installation and the key file is private", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-dir-key-"));
  const keyFile = path.join(directory, "nested", "telemetry.key");
  try {
    resetTelemetryKeyForTests();
    usePersistentTelemetryKey(keyFile);
    const first = telemetryHmac("src/mcp.ts");
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
    assert.match((await readFile(keyFile, "utf8")).trim(), /^[a-f0-9]{64}$/);

    // The same key is reused after a restart, so duplicates stay detectable across sessions.
    resetTelemetryKeyForTests();
    usePersistentTelemetryKey(keyFile);
    assert.equal(telemetryHmac("src/mcp.ts"), first);

    // A different installation produces unrelated hashes for the same input.
    resetTelemetryKeyForTests();
    usePersistentTelemetryKey(path.join(directory, "other.key"));
    assert.notEqual(telemetryHmac("src/mcp.ts"), first);
  } finally {
    resetTelemetryKeyForTests();
    await rm(directory, { recursive: true, force: true });
  }
});

test("telemetry records protocol version and client identity for both protocol styles", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-identity-"));
  try {
    const configId = `test-identity-${process.pid}-${Date.now()}`;
    const handler = createMcpHandler(root, {}, { level: "basic", configId });
    await handler(
      post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legacy-client", version: "1.0.0" },
        },
      }),
    );
    await handler(
      post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: MODERN_META } }),
    );
    await handler(
      post(
        { jsonrpc: "2.0", id: 3, method: "ping", params: {} },
        { "mcp-protocol-version": "2025-11-25" },
      ),
    );
    const runtimes = handler
      .telemetrySnapshot()
      .filter((event) => event.configId === configId && event.event.event === "mcp_request")
      .map((event) => event.runtime);
    assert.equal(runtimes.length, 3, "successful initialize must be recorded");
    assert.deepEqual(
      [runtimes[0]?.mcpClientName, runtimes[0]?.mcpProtocolVersion],
      ["legacy-client", "2025-11-25"],
    );
    assert.deepEqual(
      [runtimes[1]?.mcpClientName, runtimes[1]?.mcpClientVersion, runtimes[1]?.mcpProtocolVersion],
      ["fingerprint-test", "2.3.4", "2026-07-28"],
    );
    assert.equal(runtimes[2]?.mcpProtocolVersion, "2025-11-25");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown tools are recorded as failed tool calls with their own category", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-unknown-"));
  try {
    const configId = `test-unknown-${process.pid}-${Date.now()}`;
    const handler = createMcpHandler(root, {}, { level: "basic", configId });
    await handler(
      post({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "no_such_tool", arguments: {}, _meta: MODERN_META },
      }),
    );
    const calls = handler
      .telemetrySnapshot()
      .filter((event) => event.configId === configId && event.event.event === "tool_call");
    assert.equal(calls.length, 1);
    const event = calls[0]?.event;
    assert.ok(event && event.event === "tool_call");
    assert.equal(event.tool, "unknown");
    assert.equal(event.success, false);
    assert.equal(event.errorCategory, "unknown_tool");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("identical read calls with different budgets or key order share one input fingerprint", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-duplicates-"));
  try {
    await writeFile(path.join(root, "a.txt"), "one\ntwo\nthree\n");
    const configId = `test-duplicates-${process.pid}-${Date.now()}`;
    const handler = createMcpHandler(root, {}, { level: "detailed", configId });
    const call = (id: number, args: Record<string, unknown>) =>
      handler(
        post({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "read_range", arguments: args, _meta: MODERN_META },
        }),
      );
    await call(1, { path: "a.txt", startLine: 1, endLine: 2 });
    await call(2, { maxBytes: 16000, endLine: 2, startLine: 1, path: "a.txt" });
    const fingerprints = handler
      .telemetrySnapshot()
      .filter((event) => event.configId === configId && event.event.event === "tool_call")
      .map((event) =>
        event.event.event === "tool_call" ? event.event.inputFingerprint : undefined,
      );
    assert.equal(fingerprints.length, 2);
    assert.ok(fingerprints[0]);
    assert.equal(fingerprints[0], fingerprints[1]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("client names with a vendor/product shape are kept, unsafe ones are not", () => {
  const event = { event: "tool_call", tool: "read_range", success: true, durationMs: 1 } as const;
  const runtime = (name: string) => ({
    agentDirVersion: "1.3.0",
    nodeMajor: 24,
    os: "linux" as const,
    arch: "x64",
    mcpClientName: name,
    mcpClientVersion: "1.0.0",
    mcpProtocolVersion: "2026-07-28",
  });
  const kept = createTelemetryEnvelope("basic", event, runtime("Anthropic/ClaudeAI"));
  assert.equal(kept.runtime?.mcpClientName, "Anthropic/ClaudeAI");
  assert.equal(kept.runtime?.mcpProtocolVersion, "2026-07-28");
  const unsafe = createTelemetryEnvelope("basic", event, runtime("/home/user/secret\nname"));
  assert.equal(unsafe.runtime?.mcpClientName, "unknown");
});
