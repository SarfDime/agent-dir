import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CodeGraphIntegration } from "../src/codegraph.js";

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};

async function makeFakeCodeGraph(): Promise<{ bin: string; restore: () => void }> {
  const bin = await mkdtemp(path.join(tmpdir(), "agent-dir-codegraph-bin-"));
  const executable = path.join(bin, "codegraph");
  const script = [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    "const args = process.argv.slice(2);",
    'if (args[0] === "--version") { process.stdout.write("1.6.0\\n"); process.exit(0); }',
    'if (args[0] !== "serve" || args[1] !== "--mcp") process.exit(2);',
    'const i = args.indexOf("--path"); const root = i === -1 ? process.cwd() : args[i + 1];',
    'const fail = fs.existsSync(path.join(root, ".codegraph", "startup-fail"));',
    'const runtimeFail = fs.existsSync(path.join(root, ".codegraph", "runtime-fail")); let calls = 0; let buffer = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", chunk => { buffer += chunk; while (true) { const n = buffer.indexOf("\\n"); if (n < 0) return; const line = buffer.slice(0, n).trim(); buffer = buffer.slice(n + 1); if (!line) continue; const m = JSON.parse(line);',
    'if (m.method === "initialize") { if (fail) process.exit(7); process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{protocolVersion:"2025-11-25",capabilities:{tools:{}},serverInfo:{name:"codegraph",version:"1.6.0"}}})+"\\n"); }',
    'else if (m.method === "tools/list") process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{tools:[{name:"codegraph_explore",inputSchema:{type:"object"}}]}})+"\\n");',
    'else if (m.method === "tools/call") { calls++; const r={calls,root,arguments:m.params.arguments}; process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{content:[{type:"text",text:JSON.stringify(r)}],structuredContent:r}})+"\\n"); if (runtimeFail) setImmediate(() => process.exit(9)); } } });',
  ].join("\n");
  await writeFile(executable, script, "utf8");
  await chmod(executable, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + (originalPath ?? "");
  return {
    bin,
    restore: () => {
      process.env.PATH = originalPath;
    },
  };
}

async function writeIndex(root: string, marker?: string): Promise<void> {
  await mkdir(path.join(root, ".codegraph"), { recursive: true });
  await writeFile(path.join(root, ".codegraph", "codegraph.db"), "fake-index");
  if (marker) await writeFile(path.join(root, ".codegraph", marker), "1");
}

test("CodeGraph reports not indexed without starting a server", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-codegraph-"));
  const fake = await makeFakeCodeGraph();
  try {
    const integration = new CodeGraphIntegration(root);
    assert.equal((await integration.capability()).status, "not_indexed");
    await integration.close();
  } finally {
    fake.restore();
    await rm(fake.bin, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("CodeGraph reports not installed when an index exists", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-codegraph-"));
  const originalPath = process.env.PATH;
  try {
    await writeIndex(root);
    process.env.PATH = "";
    const integration = new CodeGraphIntegration(root);
    assert.deepEqual(await integration.capability(), {
      status: "not_installed",
      installed: false,
      indexed: true,
      tool: null,
    });
    await integration.close();
  } finally {
    process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("CodeGraph forwards explore calls and reuses one process", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-codegraph-"));
  const fake = await makeFakeCodeGraph();
  try {
    await writeIndex(root);
    const integration = new CodeGraphIntegration(root);
    assert.equal((await integration.capability()).status, "available");
    const first = await integration.explore("find entry", 3);
    const second = await integration.explore("trace handler");
    assert.deepEqual(first.structuredContent, {
      calls: 1,
      root: path.resolve(root),
      arguments: { query: "find entry", maxFiles: 3 },
    });
    assert.deepEqual(second.structuredContent, {
      calls: 2,
      root: path.resolve(root),
      arguments: { query: "trace handler" },
    });
    await integration.close();
  } finally {
    fake.restore();
    await rm(fake.bin, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("CodeGraph startup failure stays isolated", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-codegraph-"));
  const fake = await makeFakeCodeGraph();
  try {
    await writeIndex(root, "startup-fail");
    const integration = new CodeGraphIntegration(root);
    await assert.rejects(() => integration.explore("anything"), /CodeGraph startup failed/);
    assert.equal((await integration.capability()).status, "startup_failed");
    await integration.close();
  } finally {
    fake.restore();
    await rm(fake.bin, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("Agent Dir conditionally exposes codegraph_explore", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-codegraph-"));
  const fake = await makeFakeCodeGraph();
  try {
    await writeIndex(root);
    const { createMcpHandler } = await import("../src/mcp.js");
    const handler = createMcpHandler(root);
    const response = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/list",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: { _meta: META },
        }),
      }),
    );
    const body = (await response.json()) as { result: { tools: Array<{ name: string }> } };
    assert.equal(
      body.result.tools.some((tool) => tool.name === "codegraph_explore"),
      true,
    );
    handler.closeSubscriptions();
  } finally {
    fake.restore();
    await rm(fake.bin, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("Agent Dir hides codegraph_explore without an index", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-codegraph-"));
  const fake = await makeFakeCodeGraph();
  try {
    const { createMcpHandler } = await import("../src/mcp.js");
    const handler = createMcpHandler(root);
    const response = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/list",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: { _meta: META },
        }),
      }),
    );
    const body = (await response.json()) as { result: { tools: Array<{ name: string }> } };
    assert.equal(
      body.result.tools.some((tool) => tool.name === "codegraph_explore"),
      false,
    );
    handler.closeSubscriptions();
  } finally {
    fake.restore();
    await rm(fake.bin, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("CodeGraph runtime failure is surfaced after process exit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-codegraph-"));
  const fake = await makeFakeCodeGraph();
  try {
    await writeIndex(root, "runtime-fail");
    const integration = new CodeGraphIntegration(root);
    await integration.explore("first");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await assert.rejects(() => integration.explore("second"), /CodeGraph/);
    assert.equal((await integration.capability()).status, "runtime_failed");
    await integration.close();
  } finally {
    fake.restore();
    await rm(fake.bin, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
