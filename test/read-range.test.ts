import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createMcpHandler } from "../src/mcp.js";
import { formatRangeText, readRange } from "../src/tools/read.js";

async function withFile(
  content: string | Buffer,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-read-"));
  try {
    await writeFile(path.join(root, "f.txt"), content);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const LINES = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");

test("readRange reports end of file, total lines and the continuation point", async () => {
  await withFile(`${LINES}\n`, async (root) => {
    const middle = await readRange(root, "f.txt", 3, 5);
    assert.deepEqual(
      {
        eof: middle.eof,
        total: middle.totalLines,
        next: middle.nextStartLine,
        end: middle.endLine,
      },
      { eof: false, total: 10, next: 6, end: 5 },
    );
    assert.equal(middle.truncated, false);
    assert.equal(middle.content, "line 3\nline 4\nline 5");

    const tail = await readRange(root, "f.txt", 8, 50);
    assert.equal(tail.eof, true);
    assert.equal(tail.nextStartLine, undefined);
    assert.equal(tail.endLine, 10);
    assert.equal(tail.content, "line 8\nline 9\nline 10");
  });
});

test("readRange past the end returns an explicit empty result", async () => {
  await withFile(LINES, async (root) => {
    const past = await readRange(root, "f.txt", 99, 120);
    assert.deepEqual(
      { content: past.content, eof: past.eof, total: past.totalLines, end: past.endLine },
      { content: "", eof: true, total: 10, end: 98 },
    );
    assert.match(formatRangeText(past), /of 10 \(end of file\)/);
  });
});

test("readRange continues after a byte-budget cut without losing lines", async () => {
  await withFile(LINES, async (root) => {
    const first = await readRange(root, "f.txt", 1, 10, 30);
    assert.equal(first.truncated, true);
    assert.ok(first.nextStartLine && first.nextStartLine > 1);
    assert.ok(Buffer.byteLength(first.content, "utf8") <= 30);
    const rest = await readRange(root, "f.txt", first.nextStartLine ?? 1, 10, 1000);
    assert.equal(`${first.content}\n${rest.content}`, LINES);
    assert.match(formatRangeText(first), /continue with startLine=/);
  });
});

test("readRange rejects binary files and oversized ranges", async () => {
  await withFile(Buffer.from([65, 0, 66]), async (root) => {
    await assert.rejects(readRange(root, "f.txt", 1, 1), /binary/);
  });
  await withFile(LINES, async (root) => {
    await assert.rejects(readRange(root, "f.txt", 1, 5000), /at most 2000 lines/);
    await assert.rejects(readRange(root, "f.txt", 5, 2), /startLine and endLine/);
  });
});

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "read-test", version: "1.0.0" },
};

test("read_range returns plain text, structured data and supports several ranges", async () => {
  await withFile(LINES, async (root) => {
    const handler = createMcpHandler(root, {}, { level: "none" });
    const call = async (args: Record<string, unknown>) => {
      const response = await handler(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "read_range", arguments: args, _meta: META },
          }),
        }),
      );
      return (await response.json()) as {
        result: {
          isError?: boolean;
          content: Array<{ text: string }>;
        };
      };
    };

    const single = await call({ path: "f.txt", startLine: 2, endLine: 3 });
    assert.equal(
      single.result.content[0]?.text,
      "f.txt lines 2-3 of 10\nline 2\nline 3\n[continue with startLine=4]",
    );

    const multi = await call({
      path: "f.txt",
      ranges: [
        { startLine: 1, endLine: 2 },
        { startLine: 9, endLine: 10 },
      ],
    });
    assert.match(
      multi.result.content[0]?.text ?? "",
      /lines 1-2 of 10[\s\S]*line 1\nline 2[\s\S]*lines 9-10 of 10 \(end of file\)[\s\S]*line 9\nline 10/,
    );
    assert.doesNotMatch(multi.result.content[0]?.text ?? "", /\{"items"/);

    const missing = await call({ path: "f.txt" });
    assert.equal(missing.result.isError, true);
    assert.match(missing.result.content[0]?.text ?? "", /startLine and endLine are required/);
  });
});
