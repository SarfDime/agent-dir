import assert from "node:assert/strict";
import { writeFile as fsWriteFile, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { authenticate } from "../src/auth.js";
import { searchCode, searchFiles } from "../src/tools/code.js";
import {
  deleteFile,
  listDir,
  listDirs,
  listFiles,
  patchFiles,
  readFile,
  writeFile as writeProjectFile,
} from "../src/tools/files.js";

test("authentication accepts Bearer and query tokens on all endpoints", () => {
  const bearer = new Request("https://example.test/mcp", {
    headers: { authorization: "Bearer secret" },
  });
  const query = new Request("https://example.test/mcp?token=secret");
  const wrong = new Request("https://example.test/mcp?token=wrong");
  const wrongLength = new Request("https://example.test/mcp?token=x");
  const rest = new Request("https://example.test/__tree?token=secret");

  assert.equal(authenticate(bearer, "secret"), true);
  assert.equal(authenticate(query, "secret"), true);
  assert.equal(authenticate(wrong, "secret"), false);
  assert.equal(authenticate(wrongLength, "secret"), false);
  assert.equal(authenticate(rest, "secret"), true);
});

test("filesystem tools stay inside project root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-"));
  try {
    await fsWriteFile(path.join(root, "hello.txt"), "hello");
    await writeProjectFile(root, "nested/second.txt", "second");
    await writeProjectFile(root, "nested/deep/new.txt", "new");
    assert.equal(await readFile(root, "hello.txt"), "hello");
    assert.deepEqual(
      (await listDir(root, "nested")).map((item) => item.path),
      ["nested/deep", "nested/second.txt"],
    );
    assert.deepEqual(
      (await listDirs(root, [".", "nested"])).map((item) => [item.path, item.entries.length]),
      [
        [".", 2],
        ["nested", 2],
      ],
    );
    await patchFiles(root, [
      {
        path: "hello.txt",
        patches: [{ search: "hello", replace: "updated" }],
      },
      {
        path: "nested/second.txt",
        patches: [{ search: "second", replace: "changed" }],
      },
    ]);
    assert.equal(await readFile(root, "hello.txt"), "updated");
    assert.equal(await readFile(root, "nested/second.txt"), "changed");
    await writeProjectFile(root, "nested/test.txt", "test");
    assert.ok((await listFiles(root)).some((item) => item.path === "nested/test.txt"));
    await deleteFile(root, "nested/test.txt");
    await assert.rejects(async () => {
      await readFile(root, "../outside.txt");
    }, /Path escapes the exposed project directory\./);
    const outside = await mkdtemp(path.join(tmpdir(), "agent-dir-outside-"));
    try {
      await fsWriteFile(path.join(outside, "secret.txt"), "secret");
      const link = path.join(root, "escape");
      await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(
        () => readFile(root, "escape/secret.txt"),
        /Path escapes the exposed project directory\./,
      );
      await assert.rejects(
        () => writeProjectFile(root, "escape/new.txt", "blocked"),
        /Path escapes the exposed project directory\./,
      );
      await fsWriteFile(path.join(outside, "secret.ts"), "const outsideSecret = true;");
      assert.deepEqual(await searchCode(root, "outsideSecret"), []);
      assert.deepEqual(await searchFiles(root, "outsideSecret"), []);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
