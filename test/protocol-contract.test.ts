import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../src/server.js";

/**
 * Protocol contract tests over a real HTTP socket. Legacy requests contain only what a
 * 2025-11-25 client sends (no Mcp-Method / _meta); modern requests use the 2026-07-28 shape.
 */
const TOKEN = "contract-token";
const LEGACY = "2025-11-25";
const MODERN = "2026-07-28";
const VERSIONS = [LEGACY, MODERN] as const;

type Version = (typeof VERSIONS)[number];
// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON-RPC test payloads
type Json = Record<string, any>;

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

function modernMeta(): Json {
  return {
    "io.modelcontextprotocol/protocolVersion": MODERN,
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": { name: "contract", version: "1.0.0" },
  };
}

function requestFor(
  version: Version,
  method: string,
  params: Json = {},
  id: number | undefined = 1,
): { headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${TOKEN}`,
  };
  if (method !== "initialize") headers["mcp-protocol-version"] = version;
  if (version === MODERN) {
    headers["mcp-method"] = method;
    if (method === "tools/call") headers["mcp-name"] = String(params.name);
  }
  const withMeta = version === MODERN ? { ...params, _meta: modernMeta() } : params;
  return {
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(id === undefined ? {} : { id }),
      method,
      params: withMeta,
    }),
  };
}

async function rpc(
  port: number,
  version: Version,
  method: string,
  params: Json = {},
): Promise<{ status: number; body: Json }> {
  const { headers, body } = requestFor(version, method, params);
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers, body });
  return { status: response.status, body: (await response.json()) as Json };
}

async function withServer(run: (port: number, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-contract-"));
  const port = await freePort();
  const server = await startServer({ root, port, token: TOKEN });
  try {
    await run(port, root);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}

function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} did not arrive within ${ms} ms`)), ms),
    ),
  ]);
}

test("initialize answers with the requested version when supported", async () => {
  await withServer(async (port) => {
    for (const version of VERSIONS) {
      const { status, body } = await rpc(port, LEGACY, "initialize", {
        protocolVersion: version,
        capabilities: {},
        clientInfo: { name: "contract", version: "1.0.0" },
      });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.result.protocolVersion, version);
      assert.equal(typeof body.result.instructions, "string");
    }
  });
});

test("initialize negotiates down instead of failing on an unknown version", async () => {
  await withServer(async (port) => {
    const { status, body } = await rpc(port, LEGACY, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "contract", version: "1.0.0" },
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.result.protocolVersion, LEGACY);
  });
});

test("initialize only advertises capabilities that are implemented", async () => {
  await withServer(async (port) => {
    const { body } = await rpc(port, LEGACY, "initialize", {
      protocolVersion: LEGACY,
      capabilities: {},
      clientInfo: { name: "contract", version: "1.0.0" },
    });
    assert.deepEqual(Object.keys(body.result.capabilities).sort(), ["resources", "tools"]);
    assert.equal(body.result.capabilities.tools.listChanged, undefined);
    assert.equal(body.result.capabilities.resources.subscribe, undefined);
  });
});

test("ping succeeds at both protocol versions", async () => {
  await withServer(async (port) => {
    for (const version of VERSIONS) {
      const { status, body } = await rpc(port, version, "ping");
      assert.equal(status, 200, `${version}: ${JSON.stringify(body)}`);
      assert.deepEqual(body.result, {});
    }
  });
});

test("server/discover advertises both supported protocol versions", async () => {
  await withServer(async (port) => {
    const { body } = await rpc(port, MODERN, "server/discover");
    assert.deepEqual([...body.result.supportedVersions].sort(), [LEGACY, MODERN]);
  });
});

test("tools/list is valid at both protocol versions", async () => {
  await withServer(async (port) => {
    for (const version of VERSIONS) {
      const { status, body } = await rpc(port, version, "tools/list");
      assert.equal(status, 200, `${version}: ${JSON.stringify(body)}`);
      assert.ok(Array.isArray(body.result.tools) && body.result.tools.length > 0);
      for (const tool of body.result.tools as Json[]) {
        assert.equal(typeof tool.name, "string");
        assert.equal(tool.inputSchema?.type, "object", `${tool.name} inputSchema`);
      }
    }
  });
});

test("tools/list output schemas are objects (required by 2025-11-25)", {
  skip: false,
}, async () => {
  await withServer(async (port) => {
    const { body } = await rpc(port, LEGACY, "tools/list");
    for (const tool of body.result.tools as Json[]) {
      if (tool.outputSchema) assert.equal(tool.outputSchema.type, "object", tool.name);
    }
  });
});

test("tools/call returns content and structured content at both protocol versions", async () => {
  await withServer(async (port) => {
    for (const version of VERSIONS) {
      const { status, body } = await rpc(port, version, "tools/call", {
        name: "project_context",
        arguments: {},
      });
      assert.equal(status, 200, `${version}: ${JSON.stringify(body)}`);
      assert.notEqual(body.result.isError, true);
      assert.equal(body.result.content[0].type, "text");
      assert.equal(typeof body.result.structuredContent, "object");
      if (version === MODERN) assert.equal(body.result.resultType, "complete");
    }
  });
});

test("subscriptions/listen streams correctly framed SSE events over HTTP", async () => {
  await withServer(async (port) => {
    const controller = new AbortController();
    const { headers, body } = requestFor(MODERN, "subscriptions/listen", {
      notifications: { resourcesListChanged: true },
    });
    const response = await within(
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      }),
      1000,
      "subscription response headers",
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = response.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();

    const first = decoder.decode((await within(reader.read(), 1000, "acknowledgement")).value);
    assert.ok(first.startsWith("data: "), first);
    assert.ok(first.endsWith("\n\n"), "event must end with a blank line");
    assert.ok(!first.includes("\\n"), "event must not contain literal backslash-n");
    JSON.parse(first.slice("data: ".length).trim());

    const write = requestFor(
      MODERN,
      "tools/call",
      {
        name: "apply_changes",
        arguments: {
          changes: [
            {
              kind: "write",
              path: "skills/demo/SKILL.md",
              content: "---\nname: demo\ndescription: Demo\n---\n",
            },
          ],
        },
      },
      2,
    );
    const writeResponse = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: write.headers,
      body: write.body,
    });
    assert.equal(writeResponse.status, 200);

    const second = decoder.decode((await within(reader.read(), 1000, "notification")).value);
    assert.ok(second.startsWith("data: ") && second.endsWith("\n\n"), second);
    JSON.parse(second.slice("data: ".length).trim());

    controller.abort();
  });
});
