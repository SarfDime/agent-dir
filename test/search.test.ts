import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { findFiles, findReferences, findSymbol, searchCode } from "../src/tools/code.js";
import { detectSearchBackend } from "../src/tools/search.js";
import { invalidateProjectFiles } from "../src/tools/walk.js";

const RIPGREP = detectSearchBackend().backend === "ripgrep";

async function put(root: string, relative: string, content: string | Buffer): Promise<void> {
  const full = path.join(root, relative);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-search-"));
  await put(
    root,
    "src/a.ts",
    "export const needle = 1;\nconst other = needle + 1;\n// needle in a comment\n",
  );
  await put(root, "src/Case.ts", "const Needle = 2;\n");
  await put(root, "a/b/c/d/e/f/g/h/deep.ts", "export function deepFind() { return needle; }\n");
  await put(root, "docs/guide.md", "# Guide\nUse the needle option.\n");
  await put(root, "config.toml", '[tool]\nname = "needle"\n');
  await put(root, "package-lock.json", '{"needle": true}\n');
  await put(root, "vendor.min.js", "var needle=1;\n");
  await put(root, "node_modules/pkg/index.js", "needle\n");
  await put(
    root,
    "image.bin",
    Buffer.concat([Buffer.from("needle\n"), Buffer.from([0, 1, 2]), Buffer.from("\nneedle\n")]),
  );
  await put(root, "big.txt", `needle\n${"x".repeat(1_100_000)}\n`);
  return root;
}

const backends = RIPGREP ? (["builtin", "ripgrep"] as const) : (["builtin"] as const);

for (const backend of backends) {
  test(`search_code (${backend}) finds deep files, docs and config, skipping noise`, async () => {
    const root = await fixture();
    try {
      const result = await searchCode(root, "needle", { backend });
      const paths = [...new Set(result.items.map((item) => item.path))];
      assert.deepEqual(paths, [
        "a/b/c/d/e/f/g/h/deep.ts",
        "config.toml",
        "docs/guide.md",
        "src/Case.ts",
        "src/a.ts",
      ]);
      assert.equal(result.backend, backend);
      assert.equal(result.truncated, false);
      assert.equal(result.returned, result.items.length);

      const withGenerated = await searchCode(root, "needle", { backend, includeGenerated: true });
      const generated = withGenerated.items.map((item) => item.path);
      assert.ok(generated.includes("package-lock.json"));
      assert.ok(generated.includes("vendor.min.js"));
      assert.ok(!generated.includes("node_modules/pkg/index.js"));
      assert.ok(!generated.includes("image.bin"), "binary files are skipped");
      assert.ok(!generated.includes("big.txt"), "files over 1 MB are skipped");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`search_code (${backend}) supports scoping, globs, case and context`, async () => {
    const root = await fixture();
    try {
      const scoped = await searchCode(root, "needle", { backend, paths: ["src"] });
      assert.deepEqual(
        [...new Set(scoped.items.map((item) => item.path))],
        ["src/Case.ts", "src/a.ts"],
      );

      const globbed = await searchCode(root, "needle", { backend, globs: ["*.md", "*.toml"] });
      assert.deepEqual(
        globbed.items.map((item) => item.path),
        ["config.toml", "docs/guide.md"],
      );
      const excluded = await searchCode(root, "needle", {
        backend,
        paths: ["src"],
        globs: ["!Case.ts"],
      });
      assert.deepEqual([...new Set(excluded.items.map((item) => item.path))], ["src/a.ts"]);

      const sensitive = await searchCode(root, "Needle", { backend, caseSensitive: true });
      assert.deepEqual(
        sensitive.items.map((item) => [item.path, item.line]),
        [["src/Case.ts", 1]],
      );

      const context = await searchCode(root, "other", { backend, context: 1, paths: ["src/a.ts"] });
      assert.equal(context.items.length, 1);
      assert.deepEqual(context.items[0]?.before, ["export const needle = 1;"]);
      assert.deepEqual(context.items[0]?.after, ["// needle in a comment"]);

      const missing = await searchCode(root, "needle", { backend, paths: ["nope"] });
      assert.equal(missing.items.length, 0);
      assert.match(missing.notes?.[0] ?? "", /matched no project files/);
      await assert.rejects(
        searchCode(root, "needle", { backend, paths: ["../outside"] }),
        /escapes/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`search_code (${backend}) reports truncation and its reason`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-dir-search-trunc-"));
    try {
      await put(root, "many.txt", Array.from({ length: 50 }, (_, i) => `needle ${i}`).join("\n"));
      const capped = await searchCode(root, "needle", { backend, maxResults: 10 });
      assert.equal(capped.items.length, 10);
      assert.equal(capped.truncated, true);
      assert.equal(capped.truncationReason, "maxResults");

      const bytes = await searchCode(root, "needle", { backend, maxBytes: 1024 });
      assert.equal(bytes.truncated, true);
      assert.equal(bytes.truncationReason, "maxBytes");
      assert.ok(Buffer.byteLength(JSON.stringify(bytes), "utf8") <= 1024);

      const complete = await searchCode(root, "needle 49", { backend });
      assert.equal(complete.truncated, false);
      assert.equal(complete.truncationReason, undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`find_symbol and find_references (${backend}) cover several languages and identifiers`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-dir-symbols-"));
    try {
      await put(
        root,
        "go/server.go",
        "package main\n\nfunc (s *Server) Start() error {\n\treturn nil\n}\n",
      );
      await put(
        root,
        "java/src/main/java/com/acme/service/UserService.java",
        "public class UserService {\n  public void createUser(String name) {\n  }\n}\n",
      );
      await put(root, "py/app.py", "def handler(event):\n    return event\n");
      await put(
        root,
        "web/app.ts",
        "export class Widget {\n  render(): void {\n  }\n}\nconst $el = 1;\nuse($el);\nuse($elements);\n",
      );

      const go = await findSymbol(root, "Start", { backend });
      assert.deepEqual(
        go.items.map((item) => item.path),
        ["go/server.go"],
      );
      const java = await findSymbol(root, "createUser", { backend });
      assert.deepEqual(
        java.items.map((item) => [item.path, item.kind]),
        [["java/src/main/java/com/acme/service/UserService.java", "method"]],
      );
      const python = await findSymbol(root, "handler", { backend });
      assert.equal(python.items[0]?.kind, "function");
      const ts = await findSymbol(root, "render", { backend });
      assert.equal(ts.items[0]?.path, "web/app.ts");
      const widget = await findSymbol(root, "Widget", { backend });
      assert.equal(widget.items[0]?.kind, "class");
      assert.equal(
        (await findSymbol(root, "widget", { backend })).items.length,
        0,
        "case-sensitive",
      );

      const refs = await findReferences(root, "$el", { backend });
      assert.deepEqual(
        refs.items.map((item) => [item.path, item.line, item.column]),
        [
          ["web/app.ts", 5, 7],
          ["web/app.ts", 6, 5],
        ],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("the built-in backend rejects regexes with nested quantifiers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-redos-"));
  try {
    await put(root, "a.txt", `${"a".repeat(40)}!\n`);
    await assert.rejects(
      searchCode(root, "(a+)+$", { regex: true, backend: "builtin" }),
      /catastrophic backtracking/,
    );
    const ok = await searchCode(root, "a{3}", { regex: true, backend: "builtin" });
    assert.equal(ok.items.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("find_files matches bare names at any depth and reports truncation", async () => {
  const root = await fixture();
  try {
    assert.deepEqual((await findFiles(root, "deep.ts")).files, ["a/b/c/d/e/f/g/h/deep.ts"]);
    assert.deepEqual((await findFiles(root, "*.md")).files, ["docs/guide.md"]);
    assert.deepEqual((await findFiles(root, "src/*.ts")).files, ["src/Case.ts", "src/a.ts"]);
    const limited = await findFiles(root, "src/*.ts", 1);
    assert.equal(limited.files.length, 1);
    assert.equal(limited.truncated, true);
    assert.equal((await findFiles(root, "src/*.ts", 2)).truncated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inside a git repository the file list honors .gitignore and includes untracked files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-git-search-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    await put(root, ".gitignore", "ignored/\n*.secret\n");
    await put(root, "tracked.ts", "const needle = 1;\n");
    await put(root, "ignored/skip.ts", "const needle = 2;\n");
    await put(root, "token.secret", "needle\n");
    execFileSync("git", ["add", "tracked.ts", ".gitignore"], { cwd: root });
    await put(root, "untracked.ts", "const needle = 3;\n");
    invalidateProjectFiles(root);
    const result = await searchCode(root, "needle", { backend: "builtin" });
    assert.deepEqual(
      result.items.map((item) => item.path),
      ["tracked.ts", "untracked.ts"],
    );
    assert.deepEqual((await findFiles(root, "*.ts")).files, ["tracked.ts", "untracked.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ripgrep and the built-in backend return identical results", {
  skip: !RIPGREP && "ripgrep is not installed",
}, async () => {
  const root = await fixture();
  try {
    for (const options of [
      { query: "needle" },
      { query: "needle", context: 2 },
      { query: "Needle", caseSensitive: true },
      { query: "ne+dle", regex: true },
      { query: "needle", paths: ["src"], globs: ["!Case.ts"] },
      { query: "needle", includeGenerated: true },
      { query: "export const needle = 1;.*const other", regex: true, multiline: true },
    ]) {
      const { query, ...rest } = options;
      const builtin = await searchCode(root, query, { ...rest, backend: "builtin" });
      const ripgrep = await searchCode(root, query, { ...rest, backend: "ripgrep" });
      assert.deepEqual(
        { ...ripgrep, backend: "x" },
        { ...builtin, backend: "x" },
        JSON.stringify(options),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
