import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { findReferences } from "../src/tools/code.js";

test("find_references preserves later call sites when an earlier match has a long line", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-reference-budget-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "src", "a-definition.ts"),
      `export function target(value: string) { return value } // ${"x".repeat(4000)}\n`,
    );
    await writeFile(
      path.join(root, "src", "z-caller.ts"),
      'import { target } from "./a-definition";\nexport const result = target("ok");\n',
    );

    const result = await findReferences(root, "target", { maxResults: 20, maxBytes: 1024 });
    assert.ok(
      result.items.some((match) => match.path === "src/z-caller.ts"),
      JSON.stringify(result),
    );
    assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
