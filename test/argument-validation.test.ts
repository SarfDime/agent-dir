import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createMcpHandler } from "../src/mcp.js";
import { validateToolArguments } from "../src/validation.js";

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" },
};
type Schema = Parameters<typeof validateToolArguments>[0];

async function call(
  root: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ result: Record<string, unknown> }> {
  const handler = createMcpHandler(root);
  try {
    const response = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": method,
          ...(method === "tools/call" ? { "mcp-name": String(params.name) } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: META } }),
      }),
    );
    return (await response.json()) as { result: Record<string, unknown> };
  } finally {
    handler.closeSubscriptions();
  }
}

/** The schema search_code really advertises, so the tests cannot drift from it. */
async function advertisedSearchSchema(root: string): Promise<Schema> {
  const listed = await call(root, "tools/list");
  const tools = listed.result.tools as Array<{ name: string; inputSchema: Schema }>;
  const found = tools.find((tool) => tool.name === "search_code");
  assert.ok(found, "search_code is advertised");
  return found.inputSchema;
}

test("properties declared next to an anyOf are still validated when a branch matches", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-anyof-"));
  try {
    const schema = await advertisedSearchSchema(root);
    assert.equal(validateToolArguments(schema, { query: "x" }), undefined);
    assert.equal(validateToolArguments(schema, { queries: ["a", "b"] }), undefined);
    assert.equal(validateToolArguments(schema, { queries: "a" }), undefined);
    assert.equal(validateToolArguments(schema, { query: "x", paths: "src" }), undefined);
    assert.equal(validateToolArguments(schema, { query: "x", globs: "*.ts" }), undefined);
    assert.deepEqual(validateToolArguments(schema, { query: "x", context: 6 }), {
      message: "'context' must be at most 5.",
      reason: "length_or_range",
    });
    assert.deepEqual(validateToolArguments(schema, { query: "x", maxResults: "5" }), {
      message: "'maxResults' must be an integer (got string).",
      reason: "type_mismatch",
      argumentName: "maxResults",
      receivedType: "string",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("when no anyOf branch matches, the error comes from the closest branch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-anyof-"));
  try {
    const schema = await advertisedSearchSchema(root);
    // queries is present but the wrong type: that is the problem, not a missing query.
    assert.deepEqual(validateToolArguments(schema, { queries: 42 }), {
      message: "'queries' must be an array (got number).",
      reason: "type_mismatch",
      argumentName: "queries",
      receivedType: "number",
    });
    // Neither key is present: name both alternatives once.
    assert.deepEqual(validateToolArguments(schema, { paths: ["src"] }), {
      message: "One of 'query' or 'queries' is required.",
      reason: "missing_required",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("type errors use the right article and name the received type", () => {
  const schema: Schema = {
    type: "object",
    properties: { list: { type: "array" }, map: { type: "object" }, flag: { type: "boolean" } },
    additionalProperties: false,
  };
  assert.equal(
    validateToolArguments(schema, { list: "x" })?.message,
    "'list' must be an array (got string).",
  );
  assert.equal(
    validateToolArguments(schema, { map: [] })?.message,
    "'map' must be an object (got array).",
  );
  assert.equal(
    validateToolArguments(schema, { flag: null })?.message,
    "'flag' must be a boolean (got null).",
  );
});

test("search_code reports a wrongly typed queries value instead of a missing query", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-anyof-"));
  try {
    const response = await call(root, "tools/call", {
      name: "search_code",
      arguments: { queries: 42 },
    });
    const text = (response.result.content as Array<{ text: string }>)[0]?.text ?? "";
    assert.equal(response.result.isError, true);
    assert.match(text, /'queries' must be an array \(got number\)/);
    assert.doesNotMatch(text, /'query' is required/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("search_code wraps single-string paths, globs and queries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-search-strings-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "src", "needle.ts"), "const needle = 1;\n");
    await writeFile(path.join(root, "src", "needle.md"), "needle in excluded file\n");
    await writeFile(path.join(root, "docs", "needle.ts"), "needle outside scope\n");
    const response = await call(root, "tools/call", {
      name: "search_code",
      arguments: { queries: "needle", paths: "src", globs: "*.ts" },
    });
    const text = (response.result.content as Array<{ text: string }>)[0]?.text ?? "";
    assert.equal(response.result.isError, undefined);
    assert.match(text, /src\/needle\.ts:1:/);
    assert.doesNotMatch(text, /needle\.md|docs\/needle\.ts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
