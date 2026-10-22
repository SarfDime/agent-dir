import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyFileChanges } from "../src/tools/files.js";
import { protectedPathProblem } from "../src/tools/protected-paths.js";

test("default protected paths cover git internals, env files and registry credentials", () => {
  for (const protectedPath of [
    ".git/hooks/pre-commit",
    ".git/config",
    "vendor/lib/.git/config",
    ".env",
    ".env.local",
    "packages/app/.env.production",
    ".npmrc",
    "packages/app/.npmrc",
  ]) {
    assert.match(protectedPathProblem(protectedPath) ?? "", /protected path/, protectedPath);
  }
  for (const editable of [
    "src/app.ts",
    ".gitignore",
    ".github/workflows/ci.yml",
    ".env.example",
    "apps/web/.env.sample",
    "docs/git.md",
  ]) {
    assert.equal(protectedPathProblem(editable), undefined, editable);
  }
});

test("profiles can extend and relax protected paths", () => {
  assert.match(
    protectedPathProblem(".github/workflows/publish.yml", { extra: [".github/workflows/**"] }) ??
      "",
    /protected path/,
  );
  assert.equal(
    protectedPathProblem(".github/workflows/ci.yml", {
      extra: [".github/workflows/**"],
      allow: [".github/workflows/ci.yml"],
    }),
    undefined,
  );
  assert.equal(protectedPathProblem(".env", { allow: [".env"] }), undefined);
});

test("apply_changes rejects protected paths before changing anything, including dry runs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-protected-"));
  try {
    await mkdir(path.join(root, ".git", "hooks"), { recursive: true });
    await writeFile(path.join(root, "safe.txt"), "original");
    const changes = [
      { kind: "write" as const, path: "safe.txt", content: "changed" },
      { kind: "write" as const, path: ".git/hooks/pre-commit", content: "#!/bin/sh\nexit 0\n" },
    ];
    await assert.rejects(applyFileChanges(root, changes), /protected path/);
    await assert.rejects(applyFileChanges(root, changes, true), /protected path/);
    assert.equal(await readFile(path.join(root, "safe.txt"), "utf8"), "original");
    await assert.rejects(
      applyFileChanges(root, [{ kind: "write", path: ".env", content: "SECRET=1" }]),
      /protected path/,
    );
    await applyFileChanges(root, [{ kind: "write", path: ".env.example", content: "KEY=" }]);
    assert.equal(await readFile(path.join(root, ".env.example"), "utf8"), "KEY=");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
