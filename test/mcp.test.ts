import assert from "node:assert/strict";
import { writeFile as fsWriteFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createMcpHandler } from "../src/mcp.js";

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" },
};

async function request(
  root: string,
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const handler = createMcpHandler(root);
  const response = await handler(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...(method === "tools/call" || method === "resources/read"
          ? { "mcp-name": method === "tools/call" ? String(params.name) : String(params.uri) }
          : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: META } }),
    }),
  );
  return (await response.json()) as Record<string, unknown>;
}

test("every advertised tool rejects unknown arguments and names the valid ones", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-args-"));
  try {
    const list = await request(root, 1, "tools/list");
    const tools = (list.result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
    assert.ok(tools.length > 0);

    for (const tool of tools) {
      const name = String(tool.name);
      const call = await request(root, 2, "tools/call", {
        name,
        arguments: { definitelyNotAnArgument: true },
      });
      const result = call.result as Record<string, unknown>;
      assert.equal(result.isError, true, `${name} should reject an unknown argument`);
      const text = String((result.content as Array<{ text: string }>)[0]?.text);
      assert.match(text, /Unknown argument 'definitelyNotAnArgument'/, `${name}: ${text}`);
      assert.match(text, /Valid arguments:|takes no arguments/, `${name}: ${text}`);

      if (!tool.inputSchema || typeof tool.inputSchema !== "object") continue;
      const required = (tool.inputSchema as Record<string, unknown>).required;
      if (!Array.isArray(required) || required.length === 0) continue;
      const missing = await request(root, 3, "tools/call", { name, arguments: {} });
      const missingText = String(
        ((missing.result as Record<string, unknown>).content as Array<{ text: string }>)[0]?.text,
      );
      assert.match(missingText, /is required/, `${name} should name a missing required argument`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("telemetry analytics is only exposed when explicitly enabled", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-analytics-"));
  try {
    for (const enabled of [false, true]) {
      const handler = createMcpHandler(root, {}, { level: "none" }, undefined, enabled);
      const response = await handler(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: { _meta: META },
          }),
        }),
      );
      const body = (await response.json()) as { result?: { tools?: Array<{ name: string }> } };
      const names = body.result?.tools?.map((item) => item.name) ?? [];
      assert.equal(names.includes("telemetry_analytics"), enabled);
      if (enabled) {
        const analyticsResponse = await handler(
          new Request("http://localhost/mcp", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "mcp-protocol-version": "2026-07-28",
              "mcp-method": "tools/call",
              "mcp-name": "telemetry_analytics",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: {
                name: "telemetry_analytics",
                arguments: { mode: "summary", maxBytes: 8000 },
                _meta: META,
              },
            }),
          }),
        );
        const analyticsBody = (await analyticsResponse.json()) as {
          result?: {
            isError?: boolean;
            resultType?: string;
            content?: Array<{ type: string; text: string }>;
          };
        };
        const analyticsResult = analyticsBody.result;
        assert.equal(analyticsResult?.isError, undefined, JSON.stringify(analyticsBody));
        assert.equal(analyticsResult?.resultType, "complete");
        assert.equal(analyticsResult?.content?.[0]?.type, "text");
        const analyticsPayload = JSON.parse(analyticsResult?.content?.[0]?.text ?? "{}") as {
          mode?: string;
          matchedEvents?: number;
          truncated?: boolean;
        };
        assert.equal(analyticsPayload.mode, "summary");
        assert.equal(typeof analyticsPayload.matchedEvents, "number");
        for (const mode of ["summary", "sessions", "events"]) {
          const small = await handler(
            new Request("http://localhost/mcp", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                "mcp-protocol-version": "2026-07-28",
                "mcp-method": "tools/call",
                "mcp-name": "telemetry_analytics",
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 3,
                method: "tools/call",
                params: {
                  name: "telemetry_analytics",
                  arguments: { mode, maxBytes: 1024 },
                  _meta: META,
                },
              }),
            }),
          );
          const smallBody = (await small.json()) as {
            result?: {
              content?: Array<{ text: string }>;
            };
          };
          const smallPayload = JSON.parse(smallBody.result?.content?.[0]?.text ?? "{}") as {
            mode?: string;
            preview?: unknown;
            truncated?: boolean;
          };
          assert.equal(smallPayload.mode, mode);
          assert.equal(smallPayload.preview, undefined);
          assert.equal(typeof smallPayload.truncated, "boolean");
        }
      }
      handler.closeSubscriptions();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP protocol requests are recorded separately from tool calls", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-mcp-"));
  try {
    const configId = `test-mcp-${process.pid}-${Date.now()}`;
    const handler = createMcpHandler(root, {}, { level: "anonymous", configId });
    await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "server/discover",
          params: { _meta: META },
        }),
      }),
    );
    await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: { _meta: META },
        }),
      }),
    );
    const events = handler.telemetrySnapshot().filter((event) => event.configId === configId);
    assert.deepEqual(
      events.map((envelope) => envelope.event.event),
      ["mcp_request", "mcp_request"],
    );
    assert.deepEqual(
      events.map((envelope) =>
        envelope.event.event === "mcp_request" ? envelope.event.method : "",
      ),
      ["server/discover", "tools/list"],
    );
    assert.ok(
      events.every((envelope) => envelope.event.event !== "mcp_request" || envelope.event.success),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP telemetry records command, session, and detailed project context", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-telemetry-"));
  try {
    await fsWriteFile(path.join(root, "package.json"), JSON.stringify({ name: "telemetry-test" }));
    const configId = `test-mcp-commands-${process.pid}-${Date.now()}`;
    const handler = createMcpHandler(
      root,
      { scripts: { allowedScripts: ["check"] }, commands: ["git"] },
      { level: "detailed", configId },
    );

    await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "run_command_batch",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "run_command_batch",
            arguments: { commands: [{ command: "git", args: ["status", "--short"] }] },
            _meta: META,
          },
        }),
      }),
    );
    handler.closeSubscriptions();

    const events = handler.telemetrySnapshot().filter((event) => event.configId === configId);
    const command = events.find((event) => event.event.event === "command_call");
    const session = events.find((event) => event.event.event === "session");
    const tool = events.find((event) => event.event.event === "tool_call");
    assert.ok(command);
    assert.equal(command?.event.event, "command_call");
    if (command?.event.event === "command_call") {
      assert.equal(command.event.commandFamily, "command");
      assert.equal(command.event.operation, "batch");
    }
    assert.ok(tool);
    assert.ok(session);
    if (tool?.event.event === "tool_call") {
      assert.equal(tool.event.requestIdHash?.length, 64);
      assert.ok((tool.event.estimatedInputTokens ?? 0) > 0);
      if (tool.event.success) {
        assert.ok((tool.event.estimatedOutputTokens ?? 0) > 0);
        assert.ok((tool.event.cumulativeOutputBytes ?? 0) > 0);
        assert.ok((tool.event.cumulativeEstimatedOutputTokens ?? 0) > 0);
      }
      assert.equal("commands" in tool.event, false);
    }
    if (session?.event.event === "session") {
      assert.equal(session.event.requestCount, 1);
      assert.equal(session.event.toolCallCount, 1);
      assert.equal(session.event.commandCallCount, 1);
    }
    assert.ok(events.some((event) => event.project?.projectSize === "small"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP telemetry records malformed requests as invalid input", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-mcp-"));
  try {
    const configId = `test-mcp-invalid-${process.pid}-${Date.now()}`;
    const handler = createMcpHandler(root, {}, { level: "anonymous", configId });
    const response = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "null",
      }),
    );

    assert.equal(response.status, 400);
    assert.deepEqual(
      handler
        .telemetrySnapshot()
        .filter((event) => event.configId === configId)
        .map((event) => event.event),
      [
        {
          event: "mcp_request",
          method: "unknown",
          success: false,
          durationMs: (handler.telemetrySnapshot()[0]?.event as { durationMs: number })?.durationMs,
          errorCategory: "invalid_input",
        },
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("modern MCP discovery is stateless and advertises skills", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-mcp-"));
  try {
    await mkdir(path.join(root, "skills", "demo"), { recursive: true });
    await fsWriteFile(
      path.join(root, "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demo skill\n---\n# Demo\n",
    );
    const first = await request(root, 1, "server/discover");
    const second = await request(root, 2, "server/discover");
    assert.deepEqual(first.result, second.result);
    assert.deepEqual((first.result as Record<string, unknown>).supportedVersions, [
      "2026-07-28",
      "2025-11-25",
    ]);
    assert.deepEqual(
      ((first.result as Record<string, unknown>).capabilities as Record<string, unknown>)
        .extensions,
      { "io.modelcontextprotocol/skills": { directoryRead: true } },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("modern tools send one payload and no redundant schema metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-mcp-"));
  try {
    await fsWriteFile(path.join(root, "hello.txt"), "hello");
    const list = await request(root, 1, "tools/list");
    const tools = (list.result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
    const readTool = tools.find((tool) => tool.name === "read_range");
    assert.equal(readTool?.outputSchema, undefined);
    assert.equal(readTool?.title, undefined);
    const call = await request(root, 2, "tools/call", {
      name: "read_range",
      arguments: { path: "hello.txt", startLine: 1, endLine: 1 },
    });
    const result = call.result as Record<string, unknown>;
    assert.equal(result.resultType, "complete");
    assert.equal(result.structuredContent, undefined);
    const content = result.content as Array<{ type: string; text: string }>;
    assert.equal(content[0]?.type, "text");
    assert.match(content[0]?.text ?? "", /hello/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skills/list and resources/read expose project skills", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-mcp-"));
  try {
    await mkdir(path.join(root, "skills", "demo"), { recursive: true });
    await fsWriteFile(
      path.join(root, "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demo skill\nauthor: team\n---\n# Demo\n",
    );
    const listed = await request(root, 1, "skills/list");
    const skills = (listed.result as Record<string, unknown>).skills as Array<
      Record<string, unknown>
    >;
    assert.equal(skills.length, 1);
    assert.equal((skills[0] as Record<string, unknown>).uri, "skill://demo/SKILL.md");
    assert.equal(
      ((skills[0] as Record<string, unknown>).frontmatter as Record<string, unknown>).author,
      "team",
    );
    const resource = await request(root, 2, "resources/read", {
      uri: "skill://demo/SKILL.md",
    });
    const contents = (resource.result as Record<string, unknown>).contents as Array<
      Record<string, unknown>
    >;
    assert.equal(
      (contents[0] as Record<string, unknown>).text,
      "---\nname: demo\ndescription: Demo skill\nauthor: team\n---\n# Demo\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("argument rejections record a reason, sanitized keys and an input fingerprint", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-reason-"));
  try {
    const configId = `test-mcp-reason-${process.pid}-${Date.now()}`;
    const handler = createMcpHandler(root, {}, { level: "anonymous", configId });
    const call = (id: number, name: string, args: Record<string, unknown>) =>
      handler(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": "tools/call",
            "mcp-name": name,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name, arguments: args, _meta: META },
          }),
        }),
      );

    // An invented encoding wrapper: the message has to correct the belief, the event records why.
    const base64 = await call(1, "apply_changes", { base64Args: "e30=" });
    const base64Text = String(
      (
        ((await base64.json()) as Record<string, unknown>).result as {
          content: Array<{ text: string }>;
        }
      ).content[0]?.text,
    );
    assert.match(base64Text, /Unknown argument 'base64Args'/);
    assert.match(base64Text, /There is no base64 option/);
    assert.match(base64Text, /escape quotes and newlines/);

    const typed = await call(2, "apply_changes", { changes: "not-an-array" });
    assert.equal(((await typed.json()) as { result: { isError: boolean } }).result.isError, true);

    const missing = await call(3, "apply_changes", {});
    assert.equal(((await missing.json()) as { result: { isError: boolean } }).result.isError, true);

    const badEnum = await call(4, "validate", { level: "nonsense" });
    assert.equal(((await badEnum.json()) as { result: { isError: boolean } }).result.isError, true);

    const badRange = await call(5, "read_range", {
      path: "x.ts",
      startLine: 1,
      endLine: 2,
      maxBytes: 1,
    });
    assert.equal(
      ((await badRange.json()) as { result: { isError: boolean } }).result.isError,
      true,
    );

    const rejections = handler
      .telemetrySnapshot()
      .filter((envelope) => envelope.configId === configId)
      .map((envelope) => envelope.event)
      .filter((event) => event.event === "tool_call");
    const reasons = rejections.map((event) =>
      event.event === "tool_call" ? event.errorReason : undefined,
    );
    assert.deepEqual(reasons, [
      "unknown_argument",
      "type_mismatch",
      "missing_required",
      "enum_mismatch",
      "length_or_range",
    ]);
    for (const event of rejections) {
      if (event.event !== "tool_call") continue;
      assert.equal(event.errorCategory, "invalid_input");
      assert.equal(event.success, false);
      assert.equal(event.inputFingerprint?.length, 64);
    }
    assert.deepEqual(
      rejections.map((event) => (event.event === "tool_call" ? event.argumentKeys : undefined)),
      [
        // An invented key is recorded by name: it is the diagnostic signal, and the sanitizer
        // already drops anything that is not identifier-shaped.
        ["base64Args"],
        ["changes"],
        undefined,
        ["level"],
        ["path", "startLine", "endLine", "maxBytes"],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("client identity from initialize is attached to later events", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-client-"));
  try {
    const configId = `test-mcp-client-${process.pid}-${Date.now()}`;
    const handler = createMcpHandler(root, {}, { level: "basic", configId });
    const send = (id: number, method: string, params: Record<string, unknown>) =>
      handler(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2024-11-05",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        }),
      );
    await send(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "better-deepseek", version: "0.1.15" },
    });
    // A later request from the same client carries no clientInfo of its own.
    await send(2, "tools/call", { name: "find_files", arguments: { pattern: "*.md" } });

    const clientNames = handler
      .telemetrySnapshot()
      .filter((envelope) => envelope.configId === configId)
      .map((envelope) => envelope.runtime?.mcpClientName);
    assert.ok(clientNames.length >= 2);
    assert.deepEqual([...new Set(clientNames)], ["better-deepseek"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two clients in one process keep their own identity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-mixed-"));
  try {
    const configId = `test-mcp-mixed-${process.pid}-${Date.now()}`;
    const handler = createMcpHandler(root, {}, { level: "basic", configId });
    const send = (id: number, method: string, params: Record<string, unknown>, sessionId: string) =>
      handler(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-11-25",
            "mcp-session-id": sessionId,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        }),
      );

    await send(
      1,
      "initialize",
      {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "first-client", version: "1.0.0" },
      },
      "session-a",
    );
    await send(
      2,
      "initialize",
      {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "second-client", version: "2.0.0" },
      },
      "session-b",
    );
    // Neither follow-up request carries clientInfo: attribution must come from its own session.
    await send(
      3,
      "tools/call",
      { name: "find_files", arguments: { pattern: "*.md" } },
      "session-a",
    );
    await send(
      4,
      "tools/call",
      { name: "find_files", arguments: { pattern: "*.md" } },
      "session-b",
    );

    const toolClients = handler
      .telemetrySnapshot()
      .filter((envelope) => envelope.configId === configId)
      .flatMap((envelope) =>
        envelope.event.event === "tool_call" ? [envelope.runtime?.mcpClientName] : [],
      );
    assert.deepEqual(toolClients, ["first-client", "second-client"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
