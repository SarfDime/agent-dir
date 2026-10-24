import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createMcpHandler } from "../src/mcp.js";
import { diagnostics, stripJsonc } from "../src/tools/diagnostics.js";

async function withRoot(
  files: Record<string, string | Buffer>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-validate-"));
  try {
    for (const [name, content] of Object.entries(files))
      await writeFile(path.join(root, name), content);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("diagnostics ignore markdown headings but flag real conflict blocks", async () => {
  await withRoot(
    {
      "README.md": "Title\n=======\n\ntext\n",
      "conflict.txt": "a\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> branch\nz\n",
    },
    async (root) => {
      const found = await diagnostics(root);
      assert.deepEqual(
        found
          .filter((item) => item.code === "MERGE_CONFLICT")
          .map((item) => [item.path, item.line]),
        [
          ["conflict.txt", 2],
          ["conflict.txt", 4],
          ["conflict.txt", 6],
        ],
      );
    },
  );
});

test("diagnostics accept JSON with comments in config files and warn elsewhere", async () => {
  await withRoot(
    {
      "tsconfig.json": '{\n  // comment\n  "a": 1,\n}\n',
      "data.json": '{ "a": 1, }',
      "broken.json": '{ "a": ',
      "url.json": '{ "u": "http://example.com//x" }',
      "package.json": '{ "scripts": {} }',
    },
    async (root) => {
      const found = await diagnostics(root);
      const byPath = Object.fromEntries(found.map((item) => [item.path, item.code]));
      assert.equal(byPath["tsconfig.json"], undefined);
      assert.equal(byPath["data.json"], "JSON_WITH_COMMENTS");
      assert.equal(byPath["broken.json"], "INVALID_JSON");
      assert.equal(byPath["url.json"], undefined);
    },
  );
  assert.equal(
    stripJsonc('{"a": "// not a comment", /* x */ "b": [1,],}'),
    '{"a": "// not a comment",  "b": [1]}',
  );
});

test("diagnostics skip binary and oversized files", async () => {
  await withRoot(
    {
      "image.bin": Buffer.from([60, 60, 60, 60, 60, 60, 60, 10, 0, 1]),
      "big.txt": `<<<<<<< x\n${"y".repeat(1_100_000)}`,
    },
    async (root) => {
      assert.deepEqual(await diagnostics(root), []);
    },
  );
});

interface ValidateData {
  ok: boolean;
  note?: string;
  scripts?: { items: Array<{ status: string }> };
  scriptsRequested: string[];
}

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "validate-test", version: "1.0.0" },
};

async function validate(
  handler: ReturnType<typeof createMcpHandler>,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; text: string; data: ValidateData }> {
  const response = await handler(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "validate", arguments: args, _meta: META },
      }),
    }),
  );
  const body = (await response.json()) as {
    result: {
      isError?: boolean;
      content: Array<{ text: string }>;
      structuredContent: ValidateData;
    };
  };
  return {
    ...(body.result.isError ? { isError: true } : {}),
    text: body.result.content[0]?.text ?? "",
    data: body.result.structuredContent,
  };
}

const PACKAGE = JSON.stringify({
  name: "fixture",
  scripts: { check: "node -e 0", typecheck: "node -e 0", lint: "node -e 1", test: "node -e 0" },
});

test("validate rejects unknown levels and explains the diagnostics-only limits", async () => {
  await withRoot({ "package.json": PACKAGE }, async (root) => {
    const handler = createMcpHandler(
      root,
      { scripts: { allowedScripts: ["check"] } },
      { level: "none" },
    );
    const bad = await validate(handler, { level: "everything" });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /level must be/);

    const ignored = await validate(handler, { scripts: ["check"] });
    assert.match(ignored.data.note ?? "", /scripts were ignored/);
    assert.equal(ignored.data.scripts, undefined);
    assert.equal(ignored.data.ok, true);
  });
});

test("validate level scripts picks the default scripts and reports statuses", async () => {
  await withRoot({ "package.json": PACKAGE }, async (root) => {
    const handler = createMcpHandler(
      root,
      { scripts: { allowedScripts: ["typecheck", "lint", "test"] } },
      { level: "none" },
    );
    // No `check` script is allowed: typecheck and lint run, and lint fails.
    const result = await validate(handler, { level: "scripts" });
    assert.equal(result.data.ok, false);
    assert.deepEqual(result.data.scriptsRequested, ["typecheck", "lint"]);
    assert.deepEqual(
      (result.data.scripts?.items ?? []).map((item) => item.status),
      ["success", "failure"],
    );
    assert.match(result.data.note ?? "", /ran typecheck, lint/);

    const full = await validate(handler, { level: "full" });
    assert.deepEqual(full.data.scriptsRequested, ["test"]);
    assert.equal(full.data.ok, true);
  });
});

test("validate level scripts fails clearly when no default script is allowed", async () => {
  await withRoot({ "package.json": PACKAGE }, async (root) => {
    const handler = createMcpHandler(
      root,
      { scripts: { allowedScripts: ["test"] } },
      { level: "none" },
    );
    const result = await validate(handler, { level: "scripts" });
    assert.equal(result.isError, true);
    assert.match(
      result.text,
      /none of check, typecheck or lint is allowed\. Allowed scripts: test/,
    );
  });
});
