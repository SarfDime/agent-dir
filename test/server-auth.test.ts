import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../src/server.js";

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

test("unauthenticated requests are rejected before the body is processed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-auth-"));
  const port = await freePort();
  const server = await startServer({ root, port, token: "secret-token" });
  try {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
      params: {},
      pad: "x".repeat(65_536),
    });
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const anonymous = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers,
      body,
    });
    assert.equal(anonymous.status, 401);
    const wrong = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { ...headers, authorization: "Bearer wrong" },
      body,
    });
    assert.equal(wrong.status, 401);
    const allowed = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { ...headers, authorization: "Bearer secret-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping", params: {} }),
    });
    assert.equal(allowed.status, 200);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
