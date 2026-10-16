import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isAstGrepAvailable, runAstGrep } from "../src/tools/astgrep.js";

const isWindows = process.platform === "win32";

async function withFakeAstGrep(
  t: { skip: (message: string) => void },
  behavior: { output?: string; exitCode?: number; stderr?: string } = {},
  run: (directory: string, root: string, argsFile: string) => Promise<void>,
) {
  if (isWindows) {
    t.skip("Fake executable fixture currently requires a POSIX environment.");
    return;
  }

  const directory = await mkdtemp(path.join(tmpdir(), "agent-dir-astgrep-"));
  const root = path.join(directory, "project");
  const argsFile = path.join(directory, "args.json");
  const executable = path.join(directory, "ast-grep");
  await mkdir(root, { recursive: true });
  const output =
    behavior.output ??
    JSON.stringify([
      {
        text: "call()",
        range: { start: { line: 2, column: 1 }, end: { line: 2, column: 8 } },
        file: "src/example.ts",
      },
      {
        text: "call()",
        range: { start: { line: 5, column: 1 }, end: { line: 5, column: 8 } },
        file: "src/other.ts",
      },
    ]);
  const script = [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    "const args = process.argv.slice(2);",
    `fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));`,
    'if (args[0] === "--version") { process.stdout.write("ast-grep 0.51.0\\n"); process.exit(0); }',
    `process.stderr.write(${JSON.stringify(behavior.stderr ?? "")});`,
    `process.stdout.write(${JSON.stringify(output)});`,
    `process.exit(${behavior.exitCode ?? 0});`,
  ].join("\n");
  await writeFile(executable, script);
  await chmod(executable, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${directory}${path.delimiter}${previousPath ?? ""}`;
  try {
    await run(directory, root, argsFile);
  } finally {
    process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
}

test("ast-grep availability detects an executable on PATH", async (t) => {
  await withFakeAstGrep(t, {}, async () => {
    assert.equal(isAstGrepAvailable(), true);
  });
});

test("ast_grep_search passes structural search options and parses matches", async (t) => {
  await withFakeAstGrep(t, {}, async (_directory, root, argsFile) => {
    const result = await runAstGrep(root, {
      pattern: "call($A)",
      lang: "typescript",
      globs: ["src/**/*.ts"],
      context: 2,
      maxResults: 1,
    });

    assert.equal(result.count, 1);
    assert.equal(result.truncated, true);
    assert.equal(Array.isArray(result.matches), true);
    assert.deepEqual((result.matches as unknown[]).length, 1);
    const cliArgs = JSON.parse(await readFile(argsFile, "utf8")) as string[];
    assert.deepEqual(cliArgs, [
      "run",
      "--pattern",
      "call($A)",
      "--json=compact",
      "--color",
      "never",
      "--lang",
      "typescript",
      "--globs",
      "src/**/*.ts",
      "--context",
      "2",
      ".",
    ]);
  });
});

test("ast_grep_search validates unsafe or out-of-range arguments before execution", async (t) => {
  await withFakeAstGrep(t, {}, async (_directory, root) => {
    await assert.rejects(runAstGrep(root, { pattern: " " }), /non-empty/);
    await assert.rejects(
      runAstGrep(root, { pattern: "x", globs: ["../outside.ts"] }),
      /relative glob/,
    );
    await assert.rejects(
      runAstGrep(root, { pattern: "x", lang: "typescript; touch /tmp/pwned" }),
      /language identifier/,
    );
    await assert.rejects(runAstGrep(root, { pattern: "x", context: 6 }), /context/);
    await assert.rejects(runAstGrep(root, { pattern: "x", maxResults: 501 }), /maxResults/);
    await assert.rejects(runAstGrep(root, { pattern: "x", maxBytes: 100 }), /maxBytes/);
  });
});

test("ast_grep_search keeps oversized result previews within the requested byte budget", async (t) => {
  const output = JSON.stringify([{ text: "x".repeat(5_000), file: "large.ts" }]);
  await withFakeAstGrep(t, { output }, async (_directory, root) => {
    const result = await runAstGrep(root, { pattern: "large()", maxBytes: 1_024 });
    assert.equal(typeof result.preview, "string");
    assert.equal(Buffer.byteLength(result.preview as string, "utf8") <= 1_024, true);
    assert.equal(result.truncated, true);
  });
});

test("ast_grep_search rejects output beyond the hard process-output limit", async (t) => {
  const output = JSON.stringify([{ text: "x".repeat(66_000) }]);
  await withFakeAstGrep(t, { output }, async (_directory, root) => {
    await assert.rejects(runAstGrep(root, { pattern: "large()" }), /64 KB safety limit/);
  });
});

test("ast_grep_search surfaces CLI failures and bounded stderr", async (t) => {
  await withFakeAstGrep(
    t,
    { exitCode: 2, stderr: "invalid ast-grep pattern" },
    async (_directory, root) => {
      await assert.rejects(runAstGrep(root, { pattern: "not valid" }), /invalid ast-grep pattern/);
    },
  );
});
