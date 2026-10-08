import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createMcpHandler, validateMcpParamHeaders } from "../src/mcp.js";
import { getMcpLog, validateMcpHeaders } from "../src/server.js";

test("CLI reports its package version", () => {
  const output = execFileSync(process.execPath, ["dist/bin/agent-dir.js", "--version"], {
    encoding: "utf8",
  });
  assert.equal(output.trim(), "0.3.0");
});

test("CLI exposes blacklist configuration", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "agent-dir-config-blacklist-"));
  try {
    const configDir = path.join(home, ".config", "agent-dir");
    await mkdir(configDir, { recursive: true });
    const configFile = path.join(configDir, "config.json");
    const output = execFileSync(
      process.execPath,
      [
        "dist/bin/agent-dir.js",
        "config",
        "add",
        "demo",
        "--directory",
        home,
        "--command",
        "git,rg",
        "--blacklist",
        "git commit,git push --force",
        "--git",
      ],
      { encoding: "utf8", env: { ...process.env, HOME: home } },
    );
    assert.match(output, /Saved profile 'demo'/);
    const saved = JSON.parse(await readFile(configFile, "utf8")) as {
      profiles: Record<
        string,
        { commands?: string[]; blacklistedCommands?: string[]; git?: boolean }
      >;
    };
    const profile = saved.profiles.demo;
    assert.ok(profile);
    assert.deepEqual(profile.commands, ["git", "rg"]);
    assert.deepEqual(profile.blacklistedCommands, ["git commit", "git push --force"]);
    assert.equal(profile.git, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("CLI retrieves and rotates profile authentication tokens", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "agent-dir-config-token-"));
  try {
    const configDir = path.join(home, ".config", "agent-dir");
    await mkdir(configDir, { recursive: true });
    const configFile = path.join(configDir, "config.json");
    await writeFile(
      configFile,
      JSON.stringify({
        version: 1,
        profiles: {
          demo: { directory: home, port: 3002, tunnel: "none", token: "original-token" },
        },
      }),
    );

    const retrieved = execFileSync(
      process.execPath,
      ["dist/bin/agent-dir.js", "config", "token", "demo"],
      { encoding: "utf8", env: { ...process.env, HOME: home } },
    );
    assert.equal(retrieved.trim(), "original-token");

    const rotated = execFileSync(
      process.execPath,
      ["dist/bin/agent-dir.js", "config", "token", "demo", "--rotate"],
      { encoding: "utf8", env: { ...process.env, HOME: home } },
    );
    const rotatedToken = rotated.trim().split("\n").at(-1);
    assert.ok(rotatedToken);
    assert.notEqual(rotatedToken, "original-token");
    const saved = JSON.parse(await readFile(configFile, "utf8")) as {
      profiles: Record<string, { token?: string }>;
    };
    assert.equal(saved.profiles.demo?.token, rotatedToken);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("CLI deletes a named config profile with --yes", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "agent-dir-config-delete-"));
  try {
    const configDir = path.join(home, ".config", "agent-dir");
    await mkdir(configDir, { recursive: true });
    const configFile = path.join(configDir, "config.json");
    await writeFile(
      configFile,
      JSON.stringify({
        version: 1,
        profiles: {
          demo: {
            directory: home,
            port: 3002,
            tunnel: "none",
            token: "token",
          },
        },
      }),
    );

    const output = execFileSync(
      process.execPath,
      ["dist/bin/agent-dir.js", "config", "delete", "demo", "--yes"],
      { encoding: "utf8", env: { ...process.env, HOME: home }, input: "y\n" },
    );
    assert.match(output, /Deleted profile 'demo'/);
    const saved = JSON.parse(await readFile(configFile, "utf8")) as {
      profiles: Record<string, unknown>;
    };
    assert.deepEqual(saved.profiles, {});
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("CLI deletes all config profiles with --yes", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "agent-dir-config-delete-all-"));
  try {
    const configDir = path.join(home, ".config", "agent-dir");
    await mkdir(configDir, { recursive: true });
    const configFile = path.join(configDir, "config.json");
    await writeFile(
      configFile,
      JSON.stringify({
        version: 1,
        profiles: {
          one: { directory: home, port: 3002, tunnel: "none", token: "one" },
          two: { directory: home, port: 3003, tunnel: "none", token: "two" },
        },
      }),
    );

    const output = execFileSync(
      process.execPath,
      ["dist/bin/agent-dir.js", "config", "delete", "--all", "--yes"],
      { encoding: "utf8", env: { ...process.env, HOME: home }, input: "y\n" },
    );
    assert.match(output, /Deleted 2 profiles/);
    const saved = JSON.parse(await readFile(configFile, "utf8")) as {
      profiles: Record<string, unknown>;
    };
    assert.deepEqual(saved.profiles, {});
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("CLI cancels config deletion when confirmation is declined", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "agent-dir-config-cancel-"));
  try {
    const configDir = path.join(home, ".config", "agent-dir");
    await mkdir(configDir, { recursive: true });
    const configFile = path.join(configDir, "config.json");
    await writeFile(
      configFile,
      JSON.stringify({
        version: 1,
        profiles: {
          demo: { directory: home, port: 3002, tunnel: "none", token: "token" },
        },
      }),
    );

    const output = execFileSync(
      process.execPath,
      ["dist/bin/agent-dir.js", "config", "delete", "demo"],
      { encoding: "utf8", env: { ...process.env, HOME: home }, input: "n\n" },
    );
    assert.match(output, /Deletion cancelled/);
    const saved = JSON.parse(await readFile(configFile, "utf8")) as {
      profiles: Record<string, unknown>;
    };
    assert.ok(saved.profiles.demo);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};

function requestFor(id: number, method: string, params: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(method === "tools/call" || method === "resources/read"
        ? { "mcp-name": method === "tools/call" ? String(params.name) : String(params.uri) }
        : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: META } }),
  });
}

test("GitHub MCP tools are capability-gated", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-github-gating-"));
  try {
    const disabled = createMcpHandler(root);
    const disabledList = await disabled(requestFor(1, "tools/list"));
    const disabledBody = (await disabledList.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    assert.equal(
      disabledBody.result.tools.some((tool) => tool.name === "gh_pr_create"),
      false,
    );

    const enabled = createMcpHandler(root, { github: true });
    const enabledList = await enabled(requestFor(2, "tools/list"));
    const enabledBody = (await enabledList.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    assert.equal(
      enabledBody.result.tools.some((tool) => tool.name === "gh_pr_create"),
      true,
    );
    assert.equal(
      enabledBody.result.tools.some((tool) => tool.name === "gh_pr_view"),
      true,
    );

    const direct = await disabled(
      requestFor(3, "tools/call", {
        name: "gh_pr_view",
        arguments: { number: 1 },
      }),
    );
    const directBody = (await direct.json()) as {
      result: { isError?: boolean; structuredContent?: { error?: string } };
    };
    assert.equal(directBody.result.isError, true);
    assert.match(directBody.result.structuredContent?.error ?? "", /Unknown tool: gh_pr_view/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Git MCP tools are capability-gated", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-git-gating-"));
  try {
    const disabled = createMcpHandler(root);
    const disabledList = await disabled(requestFor(1, "tools/list"));
    const disabledBody = (await disabledList.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    assert.equal(
      disabledBody.result.tools.some((tool) => tool.name === "git_push"),
      false,
    );

    const enabled = createMcpHandler(root, { git: true });
    const enabledList = await enabled(requestFor(2, "tools/list"));
    const enabledBody = (await enabledList.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    assert.equal(
      enabledBody.result.tools.some((tool) => tool.name === "git_push"),
      true,
    );

    const direct = await disabled(
      requestFor(3, "tools/call", {
        name: "git_status",
        arguments: {},
      }),
    );
    const directBody = (await direct.json()) as {
      result: { isError?: boolean; structuredContent?: { error?: string } };
    };
    assert.equal(directBody.result.isError, true);
    assert.match(directBody.result.structuredContent?.error ?? "", /Unknown tool: git_status/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP protocol requests are included in telemetry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-mcp-telemetry-"));
  try {
    const handler = createMcpHandler(root, {}, { level: "anonymous", configId: "telemetry-test" });
    const before = handler.telemetrySnapshot().length;
    await handler(requestFor(1, "server/discover"));
    await handler(requestFor(2, "tools/list"));
    await handler(requestFor(3, "resources/list"));
    const notification = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    const notificationResponse = await handler(notification);
    assert.equal(notificationResponse.status, 202);

    const events = handler
      .telemetrySnapshot()
      .slice(before)
      .map((item) => item.event);
    assert.deepEqual(
      events.map((event) => event.event === "mcp_request" && [event.method, event.success]),
      [
        ["server/discover", true],
        ["tools/list", true],
        ["resources/list", true],
        ["notifications/initialized", true],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("apply_changes preflights and atomically applies related file edits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    await writeFile(path.join(root, "one.txt"), "one\n");
    await writeFile(path.join(root, "two.txt"), "two\n");
    const handler = createMcpHandler(root);

    const failed = await handler(
      requestFor(1, "tools/call", {
        name: "apply_changes",
        arguments: {
          changes: [
            { kind: "write", path: "created.txt", content: "created\n" },
            { kind: "patch", path: "two.txt", patches: [{ search: "missing", replace: "x" }] },
          ],
        },
      }),
    );
    const failedBody = (await failed.json()) as {
      result: { isError?: boolean; structuredContent?: { error?: string } };
    };
    assert.equal(failedBody.result.isError, true);
    await assert.rejects(() => access(path.join(root, "created.txt")));
    assert.equal(await readFile(path.join(root, "two.txt"), "utf8"), "two\n");

    const duplicate = await handler(
      requestFor(3, "tools/call", {
        name: "apply_changes",
        arguments: {
          changes: [
            { kind: "write", path: "nested/../duplicate.txt", content: "one" },
            { kind: "write", path: "duplicate.txt", content: "two" },
          ],
        },
      }),
    );
    const duplicateBody = (await duplicate.json()) as {
      result: { isError?: boolean; structuredContent?: { error?: string } };
    };
    assert.equal(duplicateBody.result.isError, true);
    assert.match(duplicateBody.result.structuredContent?.error ?? "", /Duplicate change path/);

    const preview = await handler(
      requestFor(2, "tools/call", {
        name: "apply_changes",
        arguments: {
          dryRun: true,
          changes: [
            { kind: "write", path: "created.txt", content: "created\n" },
            { kind: "patch", path: "two.txt", patches: [{ search: "two", replace: "updated" }] },
            { kind: "delete", path: "one.txt" },
          ],
        },
      }),
    );
    const previewBody = (await preview.json()) as {
      result: { structuredContent: Array<{ path: string; changed: boolean; dryRun?: boolean }> };
    };
    assert.deepEqual(
      previewBody.result.structuredContent.map((item) => [item.path, item.changed, item.dryRun]),
      [
        ["created.txt", true, true],
        ["two.txt", true, true],
        ["one.txt", true, true],
      ],
    );
    await assert.rejects(() => access(path.join(root, "created.txt")));
    assert.equal(await readFile(path.join(root, "two.txt"), "utf8"), "two\n");

    const applied = await handler(
      requestFor(3, "tools/call", {
        name: "apply_changes",
        arguments: {
          changes: [
            { kind: "write", path: "created.txt", content: "created\n" },
            { kind: "patch", path: "two.txt", patches: [{ search: "two", replace: "updated" }] },
            { kind: "delete", path: "one.txt" },
          ],
        },
      }),
    );
    const appliedBody = (await applied.json()) as {
      result: { structuredContent: Array<{ path: string; changed: boolean }> };
    };
    assert.equal(
      appliedBody.result.structuredContent.every((item) => item.changed),
      true,
    );
    assert.equal(await readFile(path.join(root, "created.txt"), "utf8"), "created\n");
    assert.equal(await readFile(path.join(root, "two.txt"), "utf8"), "updated\n");
    await assert.rejects(() => access(path.join(root, "one.txt")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("LLM-oriented output budgets bound high-volume results", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-budget-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        writeFile(
          path.join(root, "src", `file-${index}.ts`),
          `export const target${index} = "${"x".repeat(100)}";\\n`,
        ),
      ),
    );
    const handler = createMcpHandler(root, { commands: ["node"] });
    const batchResponse = await handler(
      requestFor(4, "tools/call", {
        name: "run_command_batch",
        arguments: {
          commands: Array.from({ length: 3 }, () => ({
            command: "node",
            args: ["-e", "process.stdout.write('x'.repeat(5000))"],
          })),
          maxBytes: 1024,
        },
      }),
    );
    const batchBody = (await batchResponse.json()) as { result: { structuredContent: unknown } };
    assert.ok(
      Buffer.byteLength(JSON.stringify(batchBody.result.structuredContent), "utf8") <= 1024,
    );

    const locateResponse = await handler(
      requestFor(1, "tools/call", {
        name: "locate",
        arguments: { query: "target", kind: "code", maxResults: 20, maxBytes: 1024 },
      }),
    );
    const locateBody = (await locateResponse.json()) as {
      result: { structuredContent: { truncated: boolean; items: unknown[] } };
    };
    assert.equal(locateBody.result.structuredContent.truncated, true);
    assert.ok(locateBody.result.structuredContent.items.length < 20);

    const relevantResponse = await handler(
      requestFor(2, "tools/call", {
        name: "read_relevant",
        arguments: { query: "target", maxResults: 20, contextLines: 3, maxBytes: 1024 },
      }),
    );
    const relevantBody = (await relevantResponse.json()) as {
      result: { structuredContent: { truncated: boolean; matches: unknown[] } };
    };
    assert.equal(relevantBody.result.structuredContent.truncated, true);
    assert.ok(relevantBody.result.structuredContent.matches.length < 20);

    const contextResponse = await handler(
      requestFor(3, "tools/call", {
        name: "project_context",
        arguments: { maxBytes: 1024 },
      }),
    );
    const contextBody = (await contextResponse.json()) as {
      result: { structuredContent: unknown };
    };
    assert.ok(
      Buffer.byteLength(JSON.stringify(contextBody.result.structuredContent), "utf8") <= 1024,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discovery search outputs honor maxBytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-discovery-budget-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    const long = "x".repeat(5000);
    await writeFile(
      path.join(root, "src", "demo.ts"),
      `import { ${long} } from "module";\\nexport const target = "${long}";\\nfunction targetFn() { return target; }\\n`,
    );
    await writeFile(path.join(root, "src", "other.ts"), `export const target2 = "${long}";\\n`);

    const handler = createMcpHandler(root);
    const calls = [
      ["search_files", { query: "target", maxResults: 20, maxBytes: 1024 }],
      ["search_code", { query: "target", maxResults: 20, maxBytes: 1024 }],
      ["find_symbol", { symbol: "target", maxResults: 20, maxBytes: 1024 }],
      ["find_definition", { symbol: "target", maxResults: 20, maxBytes: 1024 }],
      ["find_references", { symbol: "target", maxResults: 20, maxBytes: 1024 }],
      ["find_imports", { maxResults: 20, maxBytes: 1024 }],
      ["find_exports", { maxResults: 20, maxBytes: 1024 }],
    ] as const;

    for (const [index, [name, argumentsValue]] of calls.entries()) {
      const response = await handler(
        requestFor(index + 1, "tools/call", { name, arguments: argumentsValue }),
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as { result: { structuredContent: unknown } };
      assert.ok(
        Buffer.byteLength(JSON.stringify(body.result.structuredContent), "utf8") <= 1024,
        name,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("low-level read and command outputs honor maxBytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-output-budget-"));
  try {
    await writeFile(path.join(root, "one.txt"), "x".repeat(5000));
    await writeFile(path.join(root, "two.txt"), "y".repeat(5000));
    await writeFile(path.join(root, "patch.txt"), `before\n${"z".repeat(5000)}`);

    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { check: "node -e 'console.log(\"x\".repeat(5000))'" } }),
    );
    const handler = createMcpHandler(root, {
      npm: { allowedScripts: ["check"] },
    });

    const range = await handler(
      requestFor(1, "tools/call", {
        name: "read_range",
        arguments: { path: "one.txt", startLine: 1, endLine: 1, maxBytes: 1024 },
      }),
    );
    const rangeBody = (await range.json()) as {
      result: { structuredContent: { content: string } };
    };
    assert.ok(Buffer.byteLength(rangeBody.result.structuredContent.content, "utf8") <= 1024);

    const files = await handler(
      requestFor(2, "tools/call", {
        name: "read_files",
        arguments: { paths: ["one.txt", "two.txt"], maxBytes: 1024 },
      }),
    );
    const filesBody = (await files.json()) as {
      result: { structuredContent: Array<{ content: string }> };
    };
    assert.equal(filesBody.result.structuredContent.length, 1);
    assert.ok(
      Buffer.byteLength(filesBody.result.structuredContent[0]?.content ?? "", "utf8") <= 1024,
    );

    const patched = await handler(
      requestFor(3, "tools/call", {
        name: "patch_files",
        arguments: {
          dryRun: true,
          files: [{ path: "patch.txt", patches: [{ search: "before", replace: "after" }] }],
          maxBytes: 1024,
        },
      }),
    );
    const patchedBody = (await patched.json()) as {
      result: { structuredContent: Array<{ content: string }> };
    };
    assert.ok(
      Buffer.byteLength(patchedBody.result.structuredContent[0]?.content ?? "", "utf8") <= 1024,
    );

    const command = await handler(
      requestFor(4, "tools/call", {
        name: "run_npm_batch",
        arguments: { scripts: ["check"], maxBytes: 1024 },
      }),
    );
    const commandBody = (await command.json()) as {
      result: { structuredContent: Array<{ stdout: string; stderr: string }> };
    };
    const commandResult = commandBody.result.structuredContent[0];
    assert.ok(commandResult);
    assert.ok(Buffer.byteLength(JSON.stringify(commandResult), "utf8") <= 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspect unifies file, symbol, and code context with bounded output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-inspect-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "src", "sample.ts"),
      [
        "export function greet(name: string) {",
        "  const message = `Hello " + "$" + "{name}" + "`;",
        "  return message;",
        "}",
        "",
        'export const other = greet("world");',
      ].join("\\n"),
    );
    const handler = createMcpHandler(root);

    const fileResponse = await handler(
      requestFor(1, "tools/call", {
        name: "inspect",
        arguments: { target: "src/sample.ts", kind: "file", maxBytes: 1024 },
      }),
    );
    const fileBody = (await fileResponse.json()) as {
      result: {
        structuredContent: { kind: string; path: string; content: string; truncated: boolean };
      };
    };
    assert.equal(fileBody.result.structuredContent.kind, "file");
    assert.equal(fileBody.result.structuredContent.path, "src/sample.ts");
    assert.match(fileBody.result.structuredContent.content, /greet/);
    assert.equal(fileBody.result.structuredContent.truncated, false);

    const symbolResponse = await handler(
      requestFor(2, "tools/call", {
        name: "inspect",
        arguments: { target: "greet", kind: "symbol", includeReferences: true, contextLines: 1 },
      }),
    );
    const symbolBody = (await symbolResponse.json()) as {
      result: {
        structuredContent: { kind: string; definitions: unknown[]; references: unknown[] };
      };
    };
    assert.equal(symbolBody.result.structuredContent.kind, "symbol");
    assert.equal(symbolBody.result.structuredContent.definitions.length, 1);
    assert.equal(symbolBody.result.structuredContent.references.length, 1);

    const codeResponse = await handler(
      requestFor(3, "tools/call", {
        name: "inspect",
        arguments: { target: "return message", kind: "code", contextLines: 1 },
      }),
    );
    const codeBody = (await codeResponse.json()) as {
      result: { structuredContent: { kind: string; matches: Array<{ context: string }> } };
    };
    assert.equal(codeBody.result.structuredContent.kind, "code");
    assert.equal(codeBody.result.structuredContent.matches.length, 1);
    assert.match(codeBody.result.structuredContent.matches[0]?.context ?? "", /return message/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validate composes diagnostics with explicitly allowed npm scripts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { check: "node -e 'process.exit(0)'" } }),
    );
    const handler = createMcpHandler(root, { npm: { allowedScripts: ["check"] } });
    const response = await handler(
      requestFor(4, "tools/call", {
        name: "validate",
        arguments: { level: "scripts", scripts: ["check"] },
      }),
    );
    const body = (await response.json()) as {
      result: {
        structuredContent: {
          ok: boolean;
          checks: Array<{ kind: string; script?: string; ok: boolean }>;
        };
      };
    };
    assert.equal(body.result.structuredContent.ok, true);
    assert.deepEqual(
      body.result.structuredContent.checks.map((check) => [check.kind, check.script, check.ok]),
      [
        ["diagnostics", undefined, true],
        ["npm", "check", true],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("request logs redact command arguments and Git secrets", async () => {
  assert.match(
    getMcpLog(
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "run_command_batch",
            arguments: {
              commands: [{ command: "git", args: ["commit", "-m", "secret commit message"] }],
            },
          },
        }),
      ),
    )?.detail ?? "",
    /git \(args: 3\)/,
  );
  assert.doesNotMatch(
    getMcpLog(
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "git_commit",
            arguments: { message: "super secret commit message" },
          },
        }),
      ),
    )?.detail ?? "",
    /super secret commit message/,
  );
});

test("allowed_commands reports the active command policy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root, {
      npm: { allowedScripts: ["check", "test"] },
      commands: ["git", "node", "npm"],
      blacklistedCommands: ["git commit"],
    });
    const response = await handler(
      requestFor(1, "tools/call", {
        name: "allowed_commands",
        arguments: {},
      }),
    );
    assert.equal(response.status, 200);
    const result = (await response.json()) as {
      result: { structuredContent: { npmScripts: string[]; commands: string[] } };
    };
    assert.deepEqual(result.result.structuredContent, {
      npmScripts: ["check", "test"],
      commands: ["git", "node", "npm"],
      blacklistedCommands: ["git commit"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allowed_commands defaults to empty policy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root);
    const response = await handler(
      requestFor(1, "tools/call", {
        name: "allowed_commands",
        arguments: {},
      }),
    );
    const result = (await response.json()) as {
      result: { structuredContent: { npmScripts: string[]; commands: string[] } };
    };
    assert.deepEqual(result.result.structuredContent, {
      npmScripts: [],
      commands: [],
      blacklistedCommands: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP request logging describes initialize and non-tool methods", () => {
  const legacy = getMcpLog(
    Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: { roots: {}, sampling: {} },
          clientInfo: { name: "Test Client", version: "1.2.3" },
        },
      }),
    ),
  );
  assert.deepEqual(legacy, {
    name: "initialize",
    detail: "protocol: 2025-11-25 • client: Test Client v1.2.3 • capabilities: roots, sampling",
  });

  const modern = getMcpLog(
    Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          },
          capabilities: { roots: {} },
          clientInfo: { name: "Modern Client" },
        },
      }),
    ),
  );
  assert.deepEqual(modern, {
    name: "initialize",
    detail: "protocol: 2026-07-28 • client: Modern Client • capabilities: roots",
  });

  assert.deepEqual(
    getMcpLog(
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/list",
          params: {},
        }),
      ),
    ),
    { name: "tools/list", detail: "list tools" },
  );

  assert.deepEqual(
    getMcpLog(
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "subscriptions/listen",
          params: {
            notifications: {
              resourcesListChanged: true,
              resourceSubscriptions: ["skill://demo/SKILL.md", "skill://demo/README.md"],
            },
          },
        }),
      ),
    ),
    {
      name: "subscriptions/listen",
      detail: "resources list changes • 2 resource subscriptions",
    },
  );
});

test("Mcp-Param headers validate annotated arguments", () => {
  const schema = {
    type: "object",
    properties: {
      region: { type: "string", "x-mcp-header": "Region" },
      count: { type: "integer", "x-mcp-header": "Count" },
      enabled: { type: "boolean", "x-mcp-header": "Enabled" },
    },
  };

  const headers = new Headers({
    "Mcp-Param-Region": "Europe",
    "Mcp-Param-Count": "3",
    "Mcp-Param-Enabled": "true",
  });
  assert.equal(
    validateMcpParamHeaders(schema, { region: "Europe", count: 3, enabled: true }, headers),
    undefined,
  );

  assert.match(
    validateMcpParamHeaders(schema, { region: "Europe", count: 4, enabled: true }, headers) ?? "",
    /Mcp-Param-Count/,
  );
  assert.match(
    validateMcpParamHeaders(schema, { region: "Europe", count: 3, enabled: true }, new Headers()) ??
      "",
    /required/,
  );

  const encoded = new Headers({
    "Mcp-Param-Region": "=?base64?UsO8ZA==?=",
    "Mcp-Param-Count": "03",
    "Mcp-Param-Enabled": "true",
  });
  assert.equal(
    validateMcpParamHeaders(schema, { region: "Rüd", count: 3, enabled: true }, encoded),
    undefined,
  );
});

test("legacy initialize handshake is accepted without modern metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root);
    const response = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "claude", version: "1.0.0" },
          },
        }),
      }),
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { result: Record<string, unknown> };
    assert.equal(body.result.protocolVersion, "2025-11-25");
    assert.deepEqual(body.result.capabilities, {
      tools: { listChanged: true },
      resources: { listChanged: true, subscribe: true },
      extensions: { "io.modelcontextprotocol/skills": { directoryRead: true } },
    });
    assert.deepEqual(body.result.serverInfo, { name: "agent-dir", version: "0.3.0" });
    assert.match(String(body.result.instructions), /minimum necessary tool calls/);
    assert.match(String(body.result.instructions), /Allowed npm scripts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy initialize rejects a conflicting protocol header", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root);
    const response = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "claude", version: "1.0.0" },
          },
        }),
      }),
    );
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: { code: number } }).error.code, -32020);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy requests can use the negotiated protocol without modern metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root);
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
        "mcp-method": "tools/list",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    const response = await handler(request);
    assert.equal(response.status, 200);
    const result = (await response.json()) as { result: { tools: Array<{ name: string }> } };
    assert.ok(result.result.tools.some((tool) => tool.name === "read_files"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing protocol version metadata returns invalid params", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root);
    const response = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "server/discover",
          params: { _meta: { "io.modelcontextprotocol/clientCapabilities": {} } },
        }),
      }),
    );
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: { code: number } }).error.code, -32602);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported protocol versions negotiate with -32022", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root);
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
        "mcp-method": "server/discover",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2025-11-25",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    const response = await handler(request);
    assert.equal(response.status, 400);
    const result = (await response.json()) as {
      error: { code: number; data: { supported: string[]; requested: string } };
    };
    assert.equal(result.error.code, -32022);
    assert.deepEqual(result.error.data.supported, ["2026-07-28"]);
    assert.equal(result.error.data.requested, "2025-11-25");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP protocol header must agree with request metadata", async () => {
  const request = new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "server/discover",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2025-11-25" } },
    }),
  });
  const response = validateMcpHeaders(
    request,
    JSON.parse(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2025-11-25" } },
      }),
    ) as Record<string, unknown>,
  );
  assert.equal(response?.status, 400);
  assert.match(await response?.text(), /does not match/);
});

test("standard Streamable HTTP requests do not require optional MCP headers", () => {
  const request = new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
    }),
  });
  const response = validateMcpHeaders(request, {
    jsonrpc: "2.0",
    id: 1,
    method: "server/discover",
    params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
  });
  assert.equal(response, undefined);
});

test("modern notification POSTs do not require standard MCP headers", async () => {
  const request = new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/test", params: {} }),
  });
  const response = validateMcpHeaders(
    request,
    JSON.parse(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/test", params: {} }),
    ) as Record<string, unknown>,
  );
  assert.equal(response, undefined);

  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root);
    const accepted = await handler(request);
    assert.equal(accepted.status, 202);
    assert.equal(await accepted.text(), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("method parameters reject malformed tools and resource arguments", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root);
    const missingName = await handler(requestFor(1, "tools/call", {}));
    assert.equal(missingName.status, 400);
    assert.equal(((await missingName.json()) as { error: { code: number } }).error.code, -32602);

    const badArguments = await handler(
      requestFor(2, "tools/call", {
        name: "read_files",
        arguments: [] as unknown as Record<string, unknown>,
      }),
    );
    assert.equal(badArguments.status, 400);
    assert.equal(((await badArguments.json()) as { error: { code: number } }).error.code, -32602);

    const missingUri = await handler(requestFor(3, "resources/read", {}));
    assert.equal(missingUri.status, 400);
    assert.equal(((await missingUri.json()) as { error: { code: number } }).error.code, -32602);

    const badUri = await handler(requestFor(4, "resources/read", { uri: 42 as unknown as string }));
    assert.equal(badUri.status, 400);
    assert.equal(((await badUri.json()) as { error: { code: number } }).error.code, -32602);

    const missingSkillUri = await handler(requestFor(5, "skills/get", {}));
    assert.equal(missingSkillUri.status, 400);
    assert.equal(
      ((await missingSkillUri.json()) as { error: { code: number } }).error.code,
      -32602,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid JSON-RPC request envelopes are rejected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root);
    const response = await handler(requestFor(1, "server/discover"));
    assert.equal(response.status, 200);

    const invalid = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          method: "server/discover",
          params: { _meta: META },
        }),
      }),
    );
    assert.equal(invalid.status, 400);
    const result = (await invalid.json()) as { error: { code: number } };
    assert.equal(result.error.code, -32600);

    const invalidId = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: true,
          method: "server/discover",
          params: { _meta: META },
        }),
      }),
    );
    assert.equal(invalidId.status, 400);
    assert.equal(((await invalidId.json()) as { error: { code: number } }).error.code, -32600);

    const invalidCapabilities = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "server/discover",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": [],
            },
          },
        }),
      }),
    );
    assert.equal(invalidCapabilities.status, 400);
    assert.equal(
      ((await invalidCapabilities.json()) as { error: { code: number } }).error.code,
      -32602,
    );

    const invalidParams = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "server/discover",
          params: "invalid",
        }),
      }),
    );
    assert.equal(invalidParams.status, 400);
    assert.equal(((await invalidParams.json()) as { error: { code: number } }).error.code, -32602);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("modern HTTP accepts URI-mirroring methods without optional Mcp-Name", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    for (const method of ["skills/get", "resources/directory/read"]) {
      const request = requestFor(1, method, { uri: "skill://demo" });
      request.headers.delete("mcp-name");
      const response = validateMcpHeaders(
        request,
        JSON.parse(await request.clone().text()) as Record<string, unknown>,
      );
      assert.equal(response, undefined);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("modern HTTP accepts Base64-sentinel Mcp-Name values", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "resources/read",
        "mcp-name": `=?base64?${Buffer.from("skill://demo/SKILL.md").toString("base64")}?=`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: {
          uri: "skill://demo/SKILL.md",
          _meta: META,
        },
      }),
    });
    const response = validateMcpHeaders(
      request,
      JSON.parse(await request.clone().text()) as Record<string, unknown>,
    );
    assert.equal(response, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid x-mcp-header annotations are rejected", () => {
  assert.throws(
    () =>
      validateMcpParamHeaders(
        {
          type: "object",
          properties: {
            value: { type: "array", "x-mcp-header": "Value" },
          },
        },
        { value: ["x"] },
        new Headers(),
      ),
    /Invalid x-mcp-header type/,
  );

  assert.throws(
    () =>
      validateMcpParamHeaders(
        {
          type: "object",
          properties: {
            first: { type: "string", "x-mcp-header": "Value" },
            second: { type: "string", "x-mcp-header": "value" },
          },
        },
        { first: "a", second: "b" },
        new Headers(),
      ),
    /Duplicate x-mcp-header/,
  );
});

test("Agent Dir instruction resources reflect the active execution policy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root, {
      npm: { allowedScripts: ["check", "test"] },
      commands: ["git", "rg"],
    });
    const listed = await handler(requestFor(1, "resources/list"));
    const listedResult = (await listed.json()) as { result: { resources: Array<{ uri: string }> } };
    assert.ok(
      listedResult.result.resources.some((resource) => resource.uri === "agent-dir://instructions"),
    );
    assert.ok(
      listedResult.result.resources.some((resource) => resource.uri === "agent-dir://capabilities"),
    );

    const instructions = await handler(
      requestFor(2, "resources/read", { uri: "agent-dir://instructions" }),
    );
    const instructionsResult = (await instructions.json()) as {
      result: { contents: Array<{ text: string }> };
    };
    const instructionText = instructionsResult.result.contents[0]?.text;
    assert.ok(instructionText);
    assert.match(instructionText, /minimum necessary tool calls/);
    assert.ok(instructionText.includes("- check\n- test"));
    assert.ok(instructionText.includes("- git\n- rg"));

    const capabilities = await handler(
      requestFor(3, "resources/read", { uri: "agent-dir://capabilities" }),
    );
    const capabilitiesResult = (await capabilities.json()) as {
      result: { contents: Array<{ text: string }> };
    };
    const capabilityText = capabilitiesResult.result.contents[0]?.text;
    assert.ok(capabilityText);
    const capabilityDocument = JSON.parse(capabilityText) as {
      execution: {
        npmScripts: string[];
        commands: string[];
        blacklistedCommands: string[];
        git: boolean;
        github: boolean;
      };
      efficiency: { preferred: { orientation: string } };
    };
    assert.deepEqual(capabilityDocument.execution, {
      npmScripts: ["check", "test"],
      commands: ["git", "rg"],
      blacklistedCommands: [],
      git: true,
      github: false,
    });
    assert.equal(capabilityDocument.efficiency.preferred.orientation, "project_context");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("LLM-oriented tools reduce orientation, reading, and Git round trips", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "demo",
        version: "1.0.0",
        scripts: { check: "tsc --noEmit", test: "node --test" },
      }),
    );
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "src", "demo.ts"),
      "export function target(value: string) {\n  return value.trim();\n}\n",
    );

    const handler = createMcpHandler(root, {
      npm: { allowedScripts: ["check"] },
      commands: ["git"],
    });

    const contextResponse = await handler(requestFor(1, "tools/call", { name: "project_context" }));
    const context = (await contextResponse.json()) as {
      result: {
        structuredContent: {
          package: { name: string };
          execution: { npmScripts: string[]; commands: string[] };
        };
      };
    };
    assert.equal(context.result.structuredContent.package.name, "demo");
    assert.deepEqual(context.result.structuredContent.execution, {
      npmScripts: ["check"],
      commands: ["git"],
    });

    const relevantResponse = await handler(
      requestFor(2, "tools/call", {
        name: "read_relevant",
        arguments: { query: "target", contextLines: 1, maxResults: 1 },
      }),
    );
    const relevant = (await relevantResponse.json()) as {
      result: {
        structuredContent: { matches: Array<{ path: string; line: number; context: string }> };
      };
    };
    assert.equal(relevant.result.structuredContent.matches[0]?.path, "src/demo.ts");
    assert.equal(relevant.result.structuredContent.matches[0]?.line, 1);
    assert.match(relevant.result.structuredContent.matches[0]?.context ?? "", /return value\.trim/);

    const changesResponse = await handler(
      requestFor(3, "tools/call", { name: "git_changes", arguments: { includeDiff: false } }),
    );
    const changes = (await changesResponse.json()) as {
      result: { structuredContent: { status: { command: string }; diff?: unknown } };
    };
    assert.equal(typeof changes.result.structuredContent.status.command, "string");
    assert.equal(changes.result.structuredContent.diff, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("locate provides bounded intent-oriented discovery", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-locate-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "demo.ts"), "export const target = 1;\n");
    await writeFile(path.join(root, "src", "other.ts"), "export const other = 2;\n");

    const handler = createMcpHandler(root);
    const response = await handler(
      requestFor(1, "tools/call", {
        name: "locate",
        arguments: { query: "target", kind: "code", maxResults: 1 },
      }),
    );
    const body = (await response.json()) as {
      result: {
        structuredContent: {
          kind: string;
          count: number;
          truncated: boolean;
          items: Array<{ path: string }>;
        };
      };
    };
    assert.equal(body.result.structuredContent.kind, "code");
    assert.equal(body.result.structuredContent.count, 1);
    assert.equal(body.result.structuredContent.truncated, true);
    assert.equal(body.result.structuredContent.items[0]?.path, "src/demo.ts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mutation dry-run previews without changing files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-dry-run-"));
  try {
    await writeFile(path.join(root, "demo.txt"), "before\n");
    const handler = createMcpHandler(root);

    const patchResponse = await handler(
      requestFor(1, "tools/call", {
        name: "patch_files",
        arguments: {
          dryRun: true,
          files: [{ path: "demo.txt", patches: [{ search: "before", replace: "after" }] }],
        },
      }),
    );
    assert.equal(patchResponse.status, 200);
    assert.equal(await readFile(path.join(root, "demo.txt"), "utf8"), "before\n");
    const patchResult = (await patchResponse.json()) as {
      result: { structuredContent: Array<{ content: string; dryRun: boolean }> };
    };
    assert.equal(patchResult.result.structuredContent[0]?.content, "after\n");
    assert.equal(patchResult.result.structuredContent[0]?.dryRun, true);

    const writeResponse = await handler(
      requestFor(2, "tools/call", {
        name: "write_files",
        arguments: {
          dryRun: true,
          files: [{ path: "new.txt", content: "new" }],
        },
      }),
    );
    assert.equal(writeResponse.status, 200);
    await assert.rejects(access(path.join(root, "new.txt")));

    const deleteResponse = await handler(
      requestFor(3, "tools/call", {
        name: "delete_files",
        arguments: { dryRun: true, paths: ["demo.txt"] },
      }),
    );
    assert.equal(deleteResponse.status, 200);
    await access(path.join(root, "demo.txt"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skills preserve nested URI paths and complete manifests", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    await mkdir(path.join(root, "skills", "acme", "billing"), { recursive: true });
    await mkdir(path.join(root, "skills", "acme", "billing", "refunds"), { recursive: true });
    await writeFile(
      path.join(root, "skills", "acme", "billing", "SKILL.md"),
      "---\nname: billing\ndescription: Billing workflows\n---\n",
    );
    await writeFile(path.join(root, "skills", "acme", "billing", "README.md"), "billing");
    await writeFile(
      path.join(root, "skills", "acme", "billing", "refunds", "SKILL.md"),
      "---\nname: refunds\ndescription: Refund workflows\n---\n",
    );

    const handler = createMcpHandler(root);
    const response = await handler(requestFor(1, "skills/list"));
    const result = (await response.json()) as {
      result: { skills: Array<{ uri: string; resources: Array<{ uri: string }> }> };
    };
    const billing = result.result.skills.find(
      (skill) => skill.uri === "skill://acme/billing/SKILL.md",
    );
    const refunds = result.result.skills.find(
      (skill) => skill.uri === "skill://acme/billing/refunds/SKILL.md",
    );
    assert.ok(billing);
    assert.ok(refunds);
    assert.deepEqual(
      billing.resources.map((resource) => resource.uri),
      [
        "skill://acme/billing/README.md",
        "skill://acme/billing/refunds/SKILL.md",
        "skill://acme/billing/SKILL.md",
      ],
    );
    assert.deepEqual(
      refunds.resources.map((resource) => resource.uri),
      ["skill://acme/billing/refunds/SKILL.md"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid skill frontmatter and oversized skills are excluded", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    await mkdir(path.join(root, "skills", "bad-name"), { recursive: true });
    await writeFile(
      path.join(root, "skills", "bad-name", "SKILL.md"),
      "---\nname: Bad_Name\ndescription: invalid\n---\n",
    );
    await mkdir(path.join(root, "skills", "missing-description"), { recursive: true });
    await writeFile(
      path.join(root, "skills", "missing-description", "SKILL.md"),
      "---\nname: missing-description\n---\n",
    );
    await mkdir(path.join(root, "skills", "duplicate-key"), { recursive: true });
    await writeFile(
      path.join(root, "skills", "duplicate-key", "SKILL.md"),
      "---\nname: duplicate-key\nname: duplicate-key\ndescription: invalid\n---\n",
    );

    await mkdir(path.join(root, "skills", "too-many"), { recursive: true });
    await writeFile(
      path.join(root, "skills", "too-many", "SKILL.md"),
      "---\nname: too-many\ndescription: too many resources\n---\n",
    );
    await Promise.all(
      Array.from({ length: 512 }, (_, index) =>
        writeFile(path.join(root, "skills", "too-many", `file-${index}.txt`), ""),
      ),
    );

    const handler = createMcpHandler(root);
    const response = await handler(requestFor(1, "skills/list"));
    const result = (await response.json()) as {
      result: { skills: Array<{ uri: string }> };
    };
    assert.deepEqual(result.result.skills, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resources/directory/read lists direct skill children", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    await mkdir(path.join(root, "skills", "billing", "templates", "regional"), { recursive: true });
    await writeFile(
      path.join(root, "skills", "billing", "SKILL.md"),
      "---\nname: billing\ndescription: Billing\n---\n",
    );
    await writeFile(path.join(root, "skills", "billing", "templates", "invoice.md"), "invoice");
    await writeFile(path.join(root, "skills", "billing", "templates", "regional", "eu.md"), "eu");
    const handler = createMcpHandler(root);
    const response = await handler(
      requestFor(1, "resources/directory/read", { uri: "skill://billing/templates" }),
    );
    const result = (await response.json()) as {
      result: {
        resultType: string;
        resources: Array<{ uri: string; name: string; mimeType: string }>;
        ttlMs: number;
        cacheScope: string;
      };
    };
    assert.equal(result.result.resultType, "complete");
    assert.deepEqual(result.result.resources, [
      {
        uri: "skill://billing/templates/invoice.md",
        name: "invoice.md",
        mimeType: "text/markdown",
      },
      { uri: "skill://billing/templates/regional", name: "regional", mimeType: "inode/directory" },
    ]);
    assert.equal((result.result as { ttlMs: number }).ttlMs, 0);
    assert.equal((result.result as { cacheScope: string }).cacheScope, "private");

    const discover = await handler(requestFor(2, "server/discover"));
    const discoverResult = (await discover.json()) as {
      result: { capabilities: { extensions: Record<string, unknown> } };
    };
    assert.deepEqual(
      discoverResult.result.capabilities.extensions["io.modelcontextprotocol/skills"],
      { directoryRead: true },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resources/directory/read rejects traversal outside the project root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-skill-traversal-"));
  const outside = await mkdtemp(path.join(tmpdir(), "agent-dir-outside-"));
  try {
    await mkdir(path.join(root, "skills", "demo"), { recursive: true });
    await writeFile(
      path.join(root, "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demo\n---\n",
    );
    await writeFile(path.join(outside, "secret.txt"), "secret");

    const handler = createMcpHandler(root);
    const response = await handler(
      requestFor(1, "resources/directory/read", {
        uri: "skill://../../agent-dir-outside-should-not-be-visible",
      }),
    );
    assert.equal(response.status, 400);
  } finally {
    await rm(outside, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("resources/directory/read rejects unknown directories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root);
    const response = await handler(
      requestFor(1, "resources/directory/read", { uri: "skill://missing" }),
    );
    assert.equal(response.status, 400);
    const result = (await response.json()) as { error: { code: number } };
    assert.equal(result.error.code, -32602);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skills/list paginates with opaque cursors", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    for (let index = 0; index < 51; index += 1) {
      const name = `skill-${String(index).padStart(2, "0")}`;
      await mkdir(path.join(root, "skills", name), { recursive: true });
      await writeFile(
        path.join(root, "skills", name, "SKILL.md"),
        `---\nname: ${name}\ndescription: Skill ${index}\n---\n`,
      );
    }
    const handler = createMcpHandler(root);
    const first = await handler(requestFor(1, "skills/list"));
    const firstResult = (await first.json()) as {
      result: { skills: unknown[]; nextCursor?: string };
    };
    assert.equal(firstResult.result.skills.length, 50);
    assert.equal(typeof firstResult.result.nextCursor, "string");

    const second = await handler(
      requestFor(2, "skills/list", { cursor: firstResult.result.nextCursor }),
    );
    const secondResult = (await second.json()) as {
      result: { skills: unknown[]; nextCursor?: string };
    };
    assert.equal(secondResult.result.skills.length, 1);
    assert.equal(secondResult.result.nextCursor, undefined);

    const malformed = await handler(requestFor(3, "skills/list", { cursor: "!!!" }));
    const malformedResult = (await malformed.json()) as {
      error: { code: number; message: string };
    };
    assert.equal(malformedResult.error.code, -32602);
    assert.equal(malformedResult.error.message, "Invalid pagination cursor.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("subscriptions/listen rejects malformed notification filters", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root);
    const badBoolean = await handler(
      requestFor(1, "subscriptions/listen", {
        notifications: { resourcesListChanged: "yes" },
      }),
    );
    assert.equal(badBoolean.status, 400);
    assert.equal(((await badBoolean.json()) as { error: { code: number } }).error.code, -32602);

    const badResources = await handler(
      requestFor(2, "subscriptions/listen", {
        notifications: { resourceSubscriptions: ["skill://ok", 42] },
      }),
    );
    assert.equal(badResources.status, 400);
    assert.equal(((await badResources.json()) as { error: { code: number } }).error.code, -32602);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("subscriptions/listen advertises resource subscriptions and stamps notifications", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root);
    const response = await handler(
      requestFor(7, "subscriptions/listen", {
        notifications: {
          resourcesListChanged: true,
          resourceSubscriptions: ["skill://demo/SKILL.md"],
        },
      }),
    );
    const reader = response.body?.getReader();
    assert.ok(reader);
    const first = await reader.read();
    const acknowledgement = new TextDecoder().decode(first.value);
    assert.match(acknowledgement, /resourceSubscriptions/);
    assert.match(acknowledgement, /skill:\/\/demo\/SKILL.md/);
    await reader.cancel();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("subscriptions/listen sends targeted resource updates only to matching subscribers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    await mkdir(path.join(root, "skills", "demo"), { recursive: true });
    await writeFile(
      path.join(root, "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demo\n---\n",
    );
    await writeFile(path.join(root, "skills", "demo", "README.md"), "before");

    const handler = createMcpHandler(root);
    const target = await handler(
      requestFor(1, "subscriptions/listen", {
        notifications: { resourceSubscriptions: ["skill://demo/README.md"] },
      }),
    );
    const other = await handler(
      requestFor(2, "subscriptions/listen", {
        notifications: { resourceSubscriptions: ["skill://demo/SKILL.md"] },
      }),
    );
    const targetReader = target.body?.getReader();
    const otherReader = other.body?.getReader();
    assert.ok(targetReader);
    assert.ok(otherReader);

    await targetReader.read();
    await otherReader.read();

    const writeResponse = await handler(
      requestFor(3, "tools/call", {
        name: "write_files",
        arguments: { files: [{ path: "skills/demo/README.md", content: "after" }] },
      }),
    );
    assert.equal(writeResponse.status, 200);

    const targetEvent = new TextDecoder().decode((await targetReader.read()).value);
    assert.match(targetEvent, /notifications\/resources\/updated/);
    assert.match(targetEvent, /skill:\/\/demo\/README.md/);

    const unrelated = await Promise.race([
      otherReader.read().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    assert.equal(unrelated, false);

    await targetReader.cancel();
    await otherReader.cancel();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("subscriptions/listen uses list_changed for resource collection changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root);
    const response = await handler(
      requestFor(1, "subscriptions/listen", {
        notifications: { resourcesListChanged: true },
      }),
    );
    const reader = response.body?.getReader();
    assert.ok(reader);
    await reader.read();

    await mkdir(path.join(root, "skills", "demo"), { recursive: true });
    const createResponse = await handler(
      requestFor(2, "tools/call", {
        name: "write_files",
        arguments: {
          files: [
            {
              path: "skills/demo/SKILL.md",
              content: "---\nname: demo\ndescription: Demo\n---\n",
            },
          ],
        },
      }),
    );
    assert.equal(createResponse.status, 200);

    const created = new TextDecoder().decode((await reader.read()).value);
    assert.match(created, /notifications\/resources\/list_changed/);
    assert.doesNotMatch(created, /notifications\/resources\/updated/);

    const deleteResponse = await handler(
      requestFor(3, "tools/call", {
        name: "delete_files",
        arguments: { paths: ["skills/demo/SKILL.md"] },
      }),
    );
    assert.equal(deleteResponse.status, 200);

    const deleted = new TextDecoder().decode((await reader.read()).value);
    assert.match(deleted, /notifications\/resources\/list_changed/);
    assert.doesNotMatch(deleted, /notifications\/resources\/updated/);
    await reader.cancel();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("subscriptions/listen closes gracefully with server metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root);
    const response = await handler(
      requestFor(1, "subscriptions/listen", {
        notifications: { resourcesListChanged: true },
      }),
    );
    const reader = response.body?.getReader();
    assert.ok(reader);
    await reader.read();

    handler.closeSubscriptions();
    const closing = new TextDecoder().decode((await reader.read()).value);
    assert.match(closing, /"resultType":"complete"/);
    assert.match(closing, /io\.modelcontextprotocol\/serverInfo/);
    assert.match(closing, /io\.modelcontextprotocol\/subscriptionId/);
    assert.equal((await reader.read()).done, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("subscriptions/listen removes canceled streams before resource notifications", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    await mkdir(path.join(root, "skills", "demo"), { recursive: true });
    await writeFile(
      path.join(root, "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demo\n---\n",
    );
    await writeFile(path.join(root, "skills", "demo", "README.md"), "before");

    const handler = createMcpHandler(root);
    const response = await handler(
      requestFor(1, "subscriptions/listen", {
        notifications: { resourceSubscriptions: ["skill://demo/README.md"] },
      }),
    );
    const reader = response.body?.getReader();
    assert.ok(reader);
    await reader.read();
    await reader.cancel();

    const writeResponse = await handler(
      requestFor(2, "tools/call", {
        name: "write_files",
        arguments: { files: [{ path: "skills/demo/README.md", content: "after" }] },
      }),
    );
    assert.equal(writeResponse.status, 200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
