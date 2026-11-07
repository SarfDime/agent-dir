import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
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

test("read_range notes overlaps, skips opted-in repeats per session, and invalidates after edits", async () => {
  await withFile("line 1\nline 2\nline 3", async (root) => {
    const handler = createMcpHandler(root, {}, { level: "anonymous" });
    let id = 0;
    const call = async (
      name: string,
      args: Record<string, unknown>,
      session = "session-a",
    ): Promise<string> => {
      const response = await handler(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "mcp-session-id": session,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: ++id,
            method: "tools/call",
            params: { name, arguments: args, _meta: META },
          }),
        }),
      );
      const body = (await response.json()) as {
        result?: { content?: Array<{ text: string }> };
      };
      return body.result?.content?.[0]?.text ?? "";
    };

    try {
      const first = await call("read_range", { path: "f.txt", startLine: 1, endLine: 2 });
      assert.match(first, /line 1\nline 2/);

      const multiRange = {
        path: "f.txt",
        ranges: [
          { startLine: 1, endLine: 1 },
          { startLine: 3, endLine: 3 },
        ],
      };
      const multi = await call("read_range", multiRange);
      assert.match(multi, /line 1/);
      assert.match(multi, /line 3/);
      assert.equal((multi.match(/\[note:/g) ?? []).length, 1);
      const repeatedMulti = await call("read_range", {
        ...multiRange,
        skipIfUnchanged: true,
      });
      assert.equal((repeatedMulti.match(/unchanged range skipped/g) ?? []).length, 2);

      const otherSession = await call(
        "read_range",
        { path: "f.txt", startLine: 1, endLine: 2, skipIfUnchanged: true },
        "session-b",
      );
      assert.match(otherSession, /line 1\nline 2/);
      assert.doesNotMatch(otherSession, /unchanged range skipped/);

      const overlap = await call("read_range", { path: "f.txt", startLine: 2, endLine: 3 });
      assert.match(overlap, /line 2\nline 3/);
      assert.match(overlap, /overlaps lines already read/);

      const repeated = await call("read_range", {
        path: "f.txt",
        startLine: 2,
        endLine: 3,
        skipIfUnchanged: true,
      });
      assert.match(repeated, /unchanged range skipped/);
      assert.doesNotMatch(repeated, /line 2\nline 3/);

      await call("apply_changes", {
        changes: [{ kind: "write", path: "f.txt", content: "line 1\nupdated 2\nupdated 3" }],
      });
      const afterEdit = await call("read_range", {
        path: "f.txt",
        startLine: 2,
        endLine: 3,
        skipIfUnchanged: true,
      });
      assert.match(afterEdit, /updated 2\nupdated 3/);
      assert.doesNotMatch(afterEdit, /unchanged range skipped/);

      await writeFile(
        path.join(root, "f.txt"),
        "line 1\nexternal change line 2\nexternal change line 3",
      );
      const afterExternalEdit = await call("read_range", {
        path: "f.txt",
        startLine: 2,
        endLine: 3,
        skipIfUnchanged: true,
      });
      assert.match(afterExternalEdit, /external change line 2\nexternal change line 3/);
      assert.doesNotMatch(afterExternalEdit, /unchanged range skipped/);

      await writeFile(path.join(root, "large.txt"), "x".repeat(2000));
      const truncated = await call("read_range", {
        path: "large.txt",
        startLine: 1,
        endLine: 1,
        maxBytes: 1024,
      });
      assert.match(truncated, /cut by byte budget/);
      const truncatedRepeat = await call("read_range", {
        path: "large.txt",
        startLine: 1,
        endLine: 1,
        maxBytes: 1024,
        skipIfUnchanged: true,
      });
      assert.match(truncatedRepeat, /cut by byte budget/);
      assert.doesNotMatch(truncatedRepeat, /unchanged range skipped/);
      assert.doesNotMatch(JSON.stringify(handler.telemetrySnapshot()), /f\.txt/);
    } finally {
      handler.closeSubscriptions();
    }
  });
});

test("read_range failures record a typed reason and invalid-input category", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-read-errors-"));
  const configId = `test-read-errors-${process.pid}-${Date.now()}`;
  const handler = createMcpHandler(root, {}, { level: "anonymous", configId });
  try {
    await mkdir(path.join(root, "directory"));
    await writeFile(path.join(root, "binary.bin"), Buffer.from([65, 0, 66]));
    await writeFile(path.join(root, "large.txt"), "");
    await truncate(path.join(root, "large.txt"), 20 * 1024 * 1024 + 1);
    await writeFile(path.join(root, "f.txt"), LINES);

    const cases = [
      { path: "f.txt", startLine: 1, endLine: 2001, reason: "range_too_large" },
      { path: "directory", startLine: 1, endLine: 1, reason: "not_a_file" },
      { path: "binary.bin", startLine: 1, endLine: 1, reason: "binary_file" },
      { path: "large.txt", startLine: 1, endLine: 1, reason: "file_too_large" },
    ] as const;

    for (const [index, { reason, ...args }] of cases.entries()) {
      const response = await handler(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: index + 1,
            method: "tools/call",
            params: { name: "read_range", arguments: args, _meta: META },
          }),
        }),
      );
      const body = (await response.json()) as {
        result: { isError?: boolean };
      };
      assert.equal(body.result.isError, true);

      const event = handler
        .telemetrySnapshot()
        .filter(
          (envelope) => envelope.configId === configId && envelope.event.event === "tool_call",
        )
        .at(-1)?.event;
      assert.ok(event?.event === "tool_call");
      assert.equal(event.errorCategory, "invalid_input");
      assert.equal(event.errorReason, reason);
    }
  } finally {
    handler.closeSubscriptions();
    await rm(root, { recursive: true, force: true });
  }
});
