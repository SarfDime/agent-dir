import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "../src/server.js";

/**
 * Conformance against the official MCP TypeScript SDK client (task 1.07). The hand-rolled suite in
 * `protocol-contract.test.ts` pins the wire format; this one proves a real client can drive a full
 * session, so an SDK upgrade that changes expectations fails here first.
 */
const TOKEN = "sdk-contract-token";

async function freePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const { port } = address;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function withClient(run: (client: Client, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-sdk-"));
  const port = await freePort();
  const server = await startServer({ root, port, token: TOKEN });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
  });
  const client = new Client({ name: "agent-dir-sdk-contract", version: "0.0.0" });
  try {
    await client.connect(transport);
    await run(client, root);
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("official SDK client completes a session", async () => {
  await withClient(async (client) => {
    assert.ok(client.getServerVersion()?.name);
    assert.deepEqual(await client.ping(), {});

    const listed = await client.listTools();
    assert.ok(listed.tools.length > 0, "no tools advertised");
    for (const tool of listed.tools) {
      assert.equal(typeof tool.name, "string");
      assert.equal(tool.inputSchema?.type, "object", `${tool.name} input schema`);
      assert.equal(
        tool.outputSchema,
        undefined,
        `${tool.name} should not advertise an output schema`,
      );
    }
  });
});

test("official SDK client calls a tool and reads the single payload", async () => {
  await withClient(async (client, root) => {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "notes.txt"), "needle one\nneedle two\n", "utf8");

    const search = await client.callTool({
      name: "search_code",
      arguments: { query: "needle", maxResults: 5 },
    });
    assert.notEqual(search.isError, true);
    const content = search.content as Array<{ type: string; text?: string }>;
    assert.equal(content[0]?.type, "text");
    // Default rendering is grep-style: a summary line, then `path:line:col text`.
    const lines = String(content[0]?.text).split("\n");
    assert.match(lines[0] ?? "", /^2 matches in 1 file \(/);
    assert.equal(lines[1], "notes.txt:1:1 needle one");
    assert.equal(lines[2], "notes.txt:2:1 needle two");
    assert.equal(search.structuredContent, undefined);

    const missing = await client.callTool({
      name: "read_range",
      arguments: { path: "nope.txt", startLine: 1, endLine: 2 },
    });
    assert.equal(missing.isError, true);
  });
});
