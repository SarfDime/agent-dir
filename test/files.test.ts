import assert from "node:assert/strict";
import { writeFile as fsWriteFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { authenticate } from "../src/auth.js";
import { searchCode } from "../src/tools/code.js";
import { applyFileChanges, listFiles, readFile } from "../src/tools/files.js";
import { readRange } from "../src/tools/read.js";

test("MCP authentication accepts Bearer and query-string tokens", () => {
  const bearer = new Request("https://example.test/mcp", {
    headers: { authorization: "Bearer secret" },
  });
  const query = new Request("https://example.test/mcp?token=secret");
  const wrong = new Request("https://example.test/mcp?token=wrong");
  const wrongLength = new Request("https://example.test/mcp?token=x");

  assert.equal(authenticate(bearer, "secret"), true);
  assert.equal(authenticate(query, "secret"), true);
  assert.equal(authenticate(wrong, "secret"), false);
  assert.equal(authenticate(wrongLength, "secret"), false);
});

test("read_range bounds file output and reports truncation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-bounded-read-"));
  try {
    await fsWriteFile(path.join(root, "large.txt"), `${"a".repeat(200_000)}\\nsecond\\nthird`);
    const range = await readRange(root, "large.txt", 1, 1, 128);
    assert.equal(range.truncated, true);
    assert.ok(range.content.endsWith("[truncated]"));

    await fsWriteFile(
      path.join(root, "lines.txt"),
      ["first", "second", "third"].join(String.fromCharCode(10)),
    );
    const lineRange = await readRange(root, "lines.txt", 2, 3, 128);
    assert.equal(lineRange.truncated, false);
    assert.deepEqual(lineRange.content.split(String.fromCharCode(10)), ["second", "third"]);

    const hugeLine = await readRange(root, "large.txt", 1, 1, 128);
    assert.equal(hugeLine.truncated, true);
    assert.ok(Buffer.byteLength(hugeLine.content, "utf8") <= 128);
    assert.ok(hugeLine.content.endsWith("[truncated]"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem access and code search stay inside project root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-"));
  try {
    await fsWriteFile(path.join(root, "hello.txt"), "hello");
    await fsWriteFile(path.join(root, "sample.ts"), "export const insideSecret = true;");
    await mkdir(path.join(root, "nested", "deep"), { recursive: true });
    await fsWriteFile(path.join(root, "nested", "second.txt"), "second");
    await fsWriteFile(path.join(root, "nested", "deep", "new.txt"), "new");

    assert.equal(await readFile(root, "hello.txt"), "hello");
    assert.ok((await listFiles(root)).some((item) => item.path === "nested/deep/new.txt"));
    assert.deepEqual((await searchCode(root, "insideSecret")).items, [
      { path: "sample.ts", line: 1, column: 14, text: "export const insideSecret = true;" },
    ]);
    await assert.rejects(
      () => readFile(root, "../outside.txt"),
      /Path escapes the exposed project directory\./,
    );

    const outside = await mkdtemp(path.join(tmpdir(), "agent-dir-outside-"));
    try {
      await fsWriteFile(path.join(outside, "secret.txt"), "secret");
      await fsWriteFile(path.join(outside, "secret.ts"), "const outsideSecret = true;");
      const link = path.join(root, "escape");
      await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(
        () => readFile(root, "escape/secret.txt"),
        /Path escapes the exposed project directory\./,
      );
      await assert.rejects(
        () =>
          applyFileChanges(root, [{ kind: "write", path: "escape/new.txt", content: "blocked" }]),
        /Path escapes the exposed project directory\./,
      );
      assert.deepEqual((await searchCode(root, "outsideSecret")).items, []);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
