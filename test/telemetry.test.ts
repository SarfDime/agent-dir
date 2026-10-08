import assert from "node:assert/strict";
import test from "node:test";
import { summarizeTelemetry } from "../src/telemetry/aggregate.js";
import { createTelemetryEnvelope, sanitizeAnonymousEvent } from "../src/telemetry/privacy.js";
import { TelemetryRecorder } from "../src/telemetry/recorder.js";

test("telemetry defaults to no recorded events", () => {
  const recorder = new TelemetryRecorder({ level: "none" });
  recorder.record({
    event: "tool_call",
    tool: "read_files",
    success: true,
    durationMs: 10,
  });
  assert.equal(recorder.size, 0);
});

test("anonymous telemetry contains bounded usage data only", () => {
  const envelope = createTelemetryEnvelope(
    "anonymous",
    {
      event: "tool_call",
      tool: "read_files",
      success: true,
      durationMs: 42,
      outputBytes: 100,
      resultCount: 3,
      truncated: false,
    },
    {
      agentDirVersion: "0.3.0",
      nodeMajor: 24,
      os: "linux",
      arch: "x64",
      mcpClientName: "secret-user-agent",
      mcpClientVersion: "1.2.3",
    },
    {
      language: "typescript",
      framework: "nextjs",
      packageManager: "npm",
      hasGit: true,
      projectSize: "medium",
    },
  );

  assert.equal(envelope.schemaVersion, 1);
  assert.ok(!Number.isNaN(Date.parse(envelope.timestamp)));
  assert.equal(envelope.configId, "default");
  assert.equal(envelope.level, "anonymous");
  assert.deepEqual(envelope.event, {
    event: "tool_call",
    tool: "read_files",
    success: true,
    durationMs: 42,
    outputBytes: 100,
    resultCount: 3,
    truncated: false,
  });
  assert.equal("runtime" in envelope, false);
  assert.equal("project" in envelope, false);
});

test("basic telemetry adds bounded runtime context", () => {
  const envelope = createTelemetryEnvelope(
    "basic",
    {
      event: "command_call",
      commandFamily: "git",
      operation: "status",
      success: true,
      durationMs: 12,
    },
    {
      agentDirVersion: "0.3.0",
      nodeMajor: 24,
      os: "linux",
      arch: "x64",
      mcpClientName: "Claude Desktop",
      mcpClientVersion: "1.0.0",
    },
  );

  assert.ok(!Number.isNaN(Date.parse(envelope.timestamp)));
  assert.equal(envelope.configId, "default");
  assert.deepEqual(envelope.runtime, {
    agentDirVersion: "0.3.0",
    nodeMajor: 24,
    os: "linux",
    arch: "x64",
    mcpClientName: "Claude Desktop",
    mcpClientVersion: "1.0.0",
  });
  assert.equal("project" in envelope, false);
});

test("detailed telemetry adds only bounded project classification", () => {
  const envelope = createTelemetryEnvelope(
    "detailed",
    {
      event: "session",
      wallClockDurationMs: 1000,
      activeRequestDurationMs: 250,
      idleGapDurationMs: 750,
      requestCount: 10,
      toolCallCount: 7,
      commandCallCount: 2,
    },
    undefined,
    {
      language: "typescript",
      framework: "nextjs",
      packageManager: "npm",
      hasGit: true,
      hasCodegraph: true,
      projectSize: "large",
    },
  );

  assert.ok(!Number.isNaN(Date.parse(envelope.timestamp)));
  assert.equal(envelope.configId, "default");
  assert.deepEqual(envelope.project, {
    language: "typescript",
    framework: "nextjs",
    packageManager: "npm",
    hasGit: true,
    hasCodegraph: true,
    projectSize: "large",
  });
});

test("diagnostic telemetry explicitly includes bounded local troubleshooting metadata", () => {
  const envelope = createTelemetryEnvelope(
    "diagnostic",
    {
      event: "session",
      wallClockDurationMs: 100,
      activeRequestDurationMs: 50,
      idleGapDurationMs: 50,
      requestCount: 1,
      toolCallCount: 0,
      commandCallCount: 0,
    },
    {
      agentDirVersion: "0.3.1",
      nodeMajor: 24,
      os: "linux",
      arch: "x64",
      mcpClientName: "Claude Desktop",
      mcpClientVersion: "1.0.0",
      nodeVersion: "24.8.0",
      hostname: "workstation-01",
      username: "dime",
      processId: 1234,
      parentProcessId: 1000,
      processUptimeMs: 5000,
      memoryRssBytes: 50_000_000,
    },
    {
      projectRoot: "/home/dime/Documents/project",
      workingDirectory: "/home/dime/Documents/project",
      language: "typescript",
      framework: "nextjs",
      packageManager: "npm",
      hasGit: true,
      projectSize: "medium",
    },
  );

  assert.equal(envelope.level, "diagnostic");
  assert.equal(envelope.runtime?.hostname, "workstation-01");
  assert.equal(envelope.runtime?.username, "dime");
  assert.equal(envelope.runtime?.nodeVersion, "24.8.0");
  assert.equal(envelope.runtime?.processId, 1234);
  assert.equal(envelope.project?.projectRoot, "/home/dime/Documents/project");
  assert.equal(envelope.project?.workingDirectory, "/home/dime/Documents/project");
  assert.equal("token" in envelope, false);
  assert.equal("environment" in envelope, false);
});

test("privacy sanitizer rejects raw command arguments and identifying values", () => {
  const event = sanitizeAnonymousEvent({
    event: "command_call",
    commandFamily: "git",
    operation: 'commit -m "secret commit message"',
    success: true,
    durationMs: Number.POSITIVE_INFINITY,
  });

  assert.equal(event.event, "command_call");
  assert.equal(event.commandFamily, "git");
  assert.equal(event.operation, "unknown");
  assert.equal(event.durationMs, 0);
  assert.equal("args" in event, false);
});

test("recorder does not persist unless explicitly enabled", () => {
  const path = `/tmp/agent-dir-telemetry-default-${process.pid}.jsonl`;
  const recorder = new TelemetryRecorder({ level: "anonymous", persistPath: path });
  recorder.record({ event: "tool_call", tool: "read_files", success: true, durationMs: 5 });
  assert.equal(recorder.size, 1);
  const reloaded = new TelemetryRecorder({ level: "anonymous", persistPath: path });
  assert.equal(reloaded.size, 0);
});

test("recorder persists events and reloads them", () => {
  const path = `/tmp/agent-dir-telemetry-${process.pid}.jsonl`;
  const first = new TelemetryRecorder({ level: "anonymous", persist: true, persistPath: path });
  first.clear();
  first.record({ event: "tool_call", tool: "read_files", success: true, durationMs: 5 });
  const firstEvent = first.snapshot()[0];
  assert.ok(firstEvent);
  assert.ok(!Number.isNaN(Date.parse(firstEvent.timestamp)));
  assert.equal(firstEvent.configId, "default");
  assert.equal(firstEvent.sessionId, "default");
  const second = new TelemetryRecorder({ level: "anonymous", persist: true, persistPath: path });
  assert.equal(second.size, 1);
  second.clear();
});

test("recorder isolates persisted events by configuration identifier", () => {
  const path = `/tmp/agent-dir-telemetry-config-${process.pid}.jsonl`;
  const first = new TelemetryRecorder({
    level: "anonymous",
    configId: "config-a",
    persist: true,
    persistPath: path,
  });
  const second = new TelemetryRecorder({
    level: "anonymous",
    configId: "config-b",
    persist: true,
    persistPath: path,
  });

  first.clear();
  first.record({ event: "tool_call", tool: "read_files", success: true, durationMs: 1 });
  second.record({ event: "tool_call", tool: "read_files", success: true, durationMs: 2 });

  const reloadedFirst = new TelemetryRecorder({
    level: "anonymous",
    configId: "config-a",
    persist: true,
    persistPath: path,
  });
  const reloadedSecond = new TelemetryRecorder({
    level: "anonymous",
    configId: "config-b",
    persist: true,
    persistPath: path,
  });

  assert.equal(reloadedFirst.size, 1);
  assert.equal(reloadedFirst.snapshot()[0]?.configId, "config-a");
  assert.equal(reloadedSecond.size, 1);
  assert.equal(reloadedSecond.snapshot()[0]?.configId, "config-b");

  reloadedFirst.clear();
});

test("telemetry aggregation separates configs and summarizes tool performance", () => {
  const base = {
    schemaVersion: 1 as const,
    timestamp: new Date().toISOString(),
    level: "anonymous" as const,
  };
  const summary = summarizeTelemetry([
    {
      ...base,
      configId: "scriptr",
      sessionId: "session-a",
      event: { event: "tool_call", tool: "search_code", success: true, durationMs: 10 },
    },
    {
      ...base,
      configId: "scriptr",
      sessionId: "session-a",
      event: {
        event: "tool_call",
        tool: "search_code",
        success: false,
        durationMs: 20,
        errorCategory: "execution",
      },
    },
    {
      ...base,
      configId: "other",
      sessionId: "session-b",
      event: { event: "tool_call", tool: "read_files", success: true, durationMs: 5 },
    },
    {
      ...base,
      configId: "scriptr",
      sessionId: "session-a",
      event: {
        event: "session",
        wallClockDurationMs: 100,
        activeRequestDurationMs: 20,
        idleGapDurationMs: 80,
        requestCount: 4,
        toolCallCount: 2,
        commandCallCount: 1,
      },
    },
  ]);
  assert.equal(summary.configCount, 2);
  const scriptr = summary.configs.scriptr;
  const other = summary.configs.other;
  assert.ok(scriptr);
  assert.ok(other);
  assert.equal(scriptr.toolCalls, 2);
  assert.equal(scriptr.mcpSuccessRate, null);
  assert.equal(scriptr.toolSuccessRate, 50);
  assert.equal(scriptr.commandSuccessRate, null);
  assert.deepEqual(scriptr.failuresByCategory.tool, { execution: 1 });
  const search = scriptr.tools.search_code;
  assert.ok(search);
  assert.equal(search.failures, 1);
  assert.equal(search.p95DurationMs, 20);
  assert.equal(scriptr.sessions["session-a"]?.idleGapDurationMs, 80);
  assert.equal(other.toolCalls, 1);
  assert.equal(Object.keys(scriptr.sessions).length, 1);
  assert.equal(scriptr.sessions["session-a"]?.toolCalls, 2);
  assert.equal(scriptr.sessions["session-a"]?.commandCallCount, 1);
  assert.equal(scriptr.sessions["session-a"]?.toolSuccessRate, 50);
  assert.equal(scriptr.sessions["session-a"]?.mcpSuccessRate, null);
});

test("tunnel telemetry records lifecycle states without raw failure details", () => {
  const event = sanitizeAnonymousEvent({
    event: "tunnel",
    state: "disconnected",
    attempt: 2,
    reasonCategory: "public endpoint failed",
  });
  assert.deepEqual(event, {
    event: "tunnel",
    state: "disconnected",
    attempt: 2,
    reasonCategory: "unknown",
  });
});

test("health telemetry records state transitions without request metadata", () => {
  const envelope = createTelemetryEnvelope("diagnostic", {
    event: "tunnel",
    state: "health",
    healthState: "degraded",
  });
  assert.deepEqual(envelope.event, {
    event: "tunnel",
    state: "health",
    healthState: "degraded",
  });
});

test("telemetry aggregation counts tunnel lifecycle events separately", () => {
  const base = {
    schemaVersion: 1 as const,
    timestamp: new Date().toISOString(),
    level: "anonymous" as const,
    configId: "scriptr",
    sessionId: "tunnel-test",
  };
  const summary = summarizeTelemetry([
    { ...base, event: { event: "tunnel", state: "online", attempt: 0 } },
    { ...base, event: { event: "tunnel", state: "disconnected", reasonCategory: "timeout" } },
    {
      ...base,
      event: { event: "tunnel", state: "reconnecting", attempt: 1, reasonCategory: "timeout" },
    },
    { ...base, event: { event: "tunnel", state: "reconnected", attempt: 1 } },
    {
      ...base,
      event: { event: "tunnel", state: "failed", attempts: 5, reasonCategory: "execution" },
    },
  ]);
  const config = summary.configs.scriptr;
  assert.ok(config);
  assert.equal(config.tunnelEvents, 5);
  assert.equal(config.tunnelDisconnects, 1);
  assert.equal(config.tunnelReconnects, 1);
  assert.equal(config.tunnelFailures, 1);
  assert.equal(config.mcpRequests, 0);
  assert.equal(config.toolCalls, 0);
});

test("recorder is bounded and returns isolated snapshots", () => {
  const recorder = new TelemetryRecorder({ level: "anonymous", maxEvents: 2, persist: false });
  recorder.record({
    event: "session",
    wallClockDurationMs: 1,
    activeRequestDurationMs: 1,
    idleGapDurationMs: 0,
    requestCount: 1,
    toolCallCount: 1,
    commandCallCount: 0,
  });
  recorder.record({
    event: "session",
    wallClockDurationMs: 2,
    activeRequestDurationMs: 1,
    idleGapDurationMs: 1,
    requestCount: 2,
    toolCallCount: 2,
    commandCallCount: 0,
  });
  recorder.record({
    event: "session",
    wallClockDurationMs: 3,
    activeRequestDurationMs: 1,
    idleGapDurationMs: 2,
    requestCount: 3,
    toolCallCount: 3,
    commandCallCount: 0,
  });

  assert.equal(recorder.size, 2);
  const snapshot = recorder.snapshot();
  assert.ok(snapshot[0]);
  assert.equal((snapshot[0].event as { wallClockDurationMs: number }).wallClockDurationMs, 2);
  snapshot.pop();
  assert.equal(recorder.size, 2);
});
