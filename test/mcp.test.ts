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
      { npm: { allowedScripts: ["check"] }, commands: ["git"] },
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
            arguments: { commands: ["git status --short"] },
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
    assert.deepEqual((first.result as Record<string, unknown>).supportedVersions, ["2026-07-28"]);
    assert.deepEqual(
      ((first.result as Record<string, unknown>).capabilities as Record<string, unknown>)
        .extensions,
      { "io.modelcontextprotocol/skills": { directoryRead: true } },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("modern tools expose output schemas and structured content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-mcp-"));
  try {
    await fsWriteFile(path.join(root, "hello.txt"), "hello");
    const list = await request(root, 1, "tools/list");
    const tools = (list.result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
    const readTool = tools.find((tool) => tool.name === "read_files");
    assert.ok(readTool?.outputSchema);
    const call = await request(root, 2, "tools/call", {
      name: "read_files",
      arguments: { paths: ["hello.txt"] },
    });
    const result = call.result as Record<string, unknown>;
    assert.equal(result.resultType, "complete");
    assert.deepEqual(result.structuredContent, [{ path: "hello.txt", content: "hello" }]);
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
