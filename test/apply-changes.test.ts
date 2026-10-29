import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyFileChanges } from "../src/tools/files.js";

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-apply-"));
  try {
    await run(root);
  } finally {
    await chmod(path.join(root, "ro"), 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

const SOURCE = "const alpha = 1;\nconst beta = 2;\nconst alpha2 = alpha;\nreturn beta;\n";

test("a patch that matches several places is rejected with the line numbers", async () => {
  await withRoot(async (root) => {
    await writeFile(path.join(root, "a.ts"), "x = 1;\ny = 2;\nx = 1;\n");
    await assert.rejects(
      applyFileChanges(root, [
        { kind: "patch", path: "a.ts", patches: [{ search: "x = 1;", replace: "x = 9;" }] },
      ]),
      /occurs 2 times in 'a\.ts' \(lines 1, 3\)/,
    );
    assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "x = 1;\ny = 2;\nx = 1;\n");
    // An explicit count is an explicit choice.
    await applyFileChanges(root, [
      { kind: "patch", path: "a.ts", patches: [{ search: "x = 1;", replace: "x = 9;", count: 1 }] },
    ]);
    assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "x = 9;\ny = 2;\nx = 1;\n");
  });
});

test("a patch that is not found suggests the closest lines", async () => {
  await withRoot(async (root) => {
    await writeFile(path.join(root, "b.ts"), SOURCE);
    await assert.rejects(
      applyFileChanges(root, [
        {
          kind: "patch",
          path: "b.ts",
          patches: [{ search: "const  beta = 3;", replace: "const beta = 4;" }],
        },
      ]),
      (error: Error) => {
        assert.match(error.message, /Patch text was not found in 'b\.ts'/);
        assert.match(error.message, /Closest lines: line 2: const beta = 2;/);
        assert.match(error.message, /read_range/);
        return true;
      },
    );
  });
});

test("changes to missing files report a clean error without absolute paths", async () => {
  await withRoot(async (root) => {
    for (const change of [
      { kind: "patch" as const, path: "missing.ts", patches: [{ search: "a", replace: "b" }] },
      { kind: "delete" as const, path: "missing.ts" },
    ]) {
      await assert.rejects(applyFileChanges(root, [change]), (error: Error) => {
        assert.equal(error.message, "'missing.ts' does not exist.");
        return true;
      });
    }
    await assert.rejects(
      applyFileChanges(root, [{ kind: "write", path: "", content: "x" }]),
      /non-empty string path/,
    );
  });
});

test("writes go through a temporary file, keep the file mode and leave nothing behind", async () => {
  await withRoot(async (root) => {
    const script = path.join(root, "run.sh");
    await writeFile(script, "#!/bin/sh\necho old\n");
    await chmod(script, 0o755);
    await applyFileChanges(root, [
      { kind: "write", path: "run.sh", content: "#!/bin/sh\necho new\n" },
    ]);
    assert.equal(await readFile(script, "utf8"), "#!/bin/sh\necho new\n");
    assert.equal((await stat(script)).mode & 0o777, 0o755);
    assert.deepEqual(await readdir(root), ["run.sh"]);
  });
});

test("patching a binary file is refused", async () => {
  await withRoot(async (root) => {
    await writeFile(path.join(root, "image.bin"), Buffer.from([1, 0, 2]));
    await assert.rejects(
      applyFileChanges(root, [
        { kind: "patch", path: "image.bin", patches: [{ search: "a", replace: "b" }] },
      ]),
      /binary/,
    );
  });
});

test("a failure while applying rolls back earlier changes, including binary files", {
  skip: process.getuid?.() === 0 && "running as root: permission errors cannot be provoked",
}, async () => {
  await withRoot(async (root) => {
    const bytes = Buffer.from([0, 255, 1, 2, 3, 128]);
    await writeFile(path.join(root, "a.txt"), "original");
    await writeFile(path.join(root, "b.bin"), bytes);
    await mkdir(path.join(root, "ro"));
    await chmod(path.join(root, "ro"), 0o555);
    await assert.rejects(
      applyFileChanges(root, [
        { kind: "write", path: "a.txt", content: "changed" },
        { kind: "write", path: "b.bin", content: "now text" },
        { kind: "write", path: "ro/new.txt", content: "cannot be written" },
      ]),
      /rolled back/,
    );
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "original");
    assert.ok((await readFile(path.join(root, "b.bin"))).equals(bytes));
    assert.deepEqual((await readdir(root)).sort(), ["a.txt", "b.bin", "ro"]);
  });
});
