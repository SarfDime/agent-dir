import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateLegacyProfiles } from "../src/config.js";
import { createMcpHandler } from "../src/mcp.js";
import { type BatchTask, runBatch } from "../src/tools/batch.js";
import { checkCommand, isCommandBlacklisted, spawnCapture } from "../src/tools/commands.js";
import { evaluateCommandPolicy, isCommandPolicy, mutatingScripts } from "../src/tools/policy.js";
import type { AgentConfig } from "../src/types.js";

const ROOT = process.cwd();
const NODE = process.execPath;

function nodeTask(code: string, extra: Partial<BatchTask> = {}, timeoutMs = 10_000): BatchTask {
  return {
    label: `node -e ${code}`,
    preflight: () => undefined,
    execute: () => spawnCapture(ROOT, NODE, ["-e", code], { timeoutMs }),
    ...extra,
  };
}

// ---------------------------------------------------------------- batch statuses

test("batch continue mode runs later items after a failure and labels every item", async () => {
  const result = await runBatch(
    [nodeTask("console.log('a')"), nodeTask("process.exit(1)"), nodeTask("console.log('c')")],
    { onError: "continue", maxBytes: 16_000 },
  );
  assert.deepEqual(
    result.items.map((item) => item.status),
    ["success", "failure", "success"],
  );
  assert.equal(result.items[1]?.exitCode, 1);
  assert.match(result.items[1]?.reason ?? "", /Exited with code 1/);
  assert.deepEqual(result.summary, { total: 3, success: 2, failure: 1, skipped: 0 });
  assert.equal(result.ok, false);
  assert.ok(result.items.every((item) => item.ran));
});

test("batch stop mode marks later items skipped with the reason", async () => {
  const result = await runBatch(
    [nodeTask("console.log('a')"), nodeTask("process.exit(2)"), nodeTask("console.log('c')")],
    { onError: "stop", maxBytes: 16_000 },
  );
  assert.deepEqual(
    result.items.map((item) => item.status),
    ["success", "failure", "skipped"],
  );
  assert.equal(result.items[2]?.ran, false);
  assert.match(result.items[2]?.reason ?? "", /item 1 failed/);
  assert.equal(result.items[2]?.stdout, undefined);
});

test("okExitCodes treats a normal non-zero exit as success", async () => {
  const result = await runBatch(
    [nodeTask("process.exit(1)", { okExitCodes: [0, 1] }), nodeTask("console.log('next')")],
    { onError: "stop", maxBytes: 16_000 },
  );
  assert.deepEqual(
    result.items.map((item) => item.status),
    ["success", "success"],
  );
  assert.equal(result.ok, true);
});

test("a stop-mode batch with a rejected item runs nothing", async () => {
  let executed = 0;
  const counted = (): Promise<never> => {
    executed += 1;
    return Promise.reject(new Error("must not run"));
  };
  const result = await runBatch(
    [
      nodeTask("0", { execute: counted }),
      nodeTask("0", { preflight: () => "Command 'x' is not allowed by this profile." }),
      nodeTask("0", { execute: counted }),
    ],
    { onError: "stop", maxBytes: 16_000 },
  );
  assert.equal(executed, 0);
  assert.deepEqual(
    result.items.map((item) => item.status),
    ["skipped", "failure", "skipped"],
  );
  assert.match(result.items[0]?.reason ?? "", /item 1 was rejected/);
  assert.equal(result.items[1]?.reason, "Command 'x' is not allowed by this profile.");
  assert.ok(result.items.every((item) => !item.ran));
});

test("a continue-mode batch still runs the other items when one is rejected", async () => {
  const result = await runBatch(
    [
      nodeTask("console.log('first')"),
      nodeTask("0", { preflight: () => "blocked" }),
      nodeTask("console.log('last')"),
    ],
    { onError: "continue", maxBytes: 16_000 },
  );
  assert.deepEqual(
    result.items.map((item) => [item.status, item.ran]),
    [
      ["success", true],
      ["failure", false],
      ["success", true],
    ],
  );
});

test("a timeout keeps partial output and earlier results", async () => {
  const result = await runBatch(
    [
      nodeTask("console.log('done')"),
      nodeTask("console.log('partial'); setTimeout(() => {}, 20000)", {}, 400),
    ],
    { onError: "continue", maxBytes: 16_000 },
  );
  assert.equal(result.items[0]?.status, "success");
  assert.equal(result.items[1]?.status, "failure");
  assert.match(result.items[1]?.reason ?? "", /Timed out/);
  assert.match(result.items[1]?.stdout ?? "", /partial/);
});

test("a missing executable is reported as a failure, not an exception", async () => {
  const result = await runBatch(
    [
      {
        label: "definitely-not-a-command",
        preflight: () => undefined,
        execute: () => spawnCapture(ROOT, "definitely-not-a-command", [], { timeoutMs: 5000 }),
      },
    ],
    { onError: "continue", maxBytes: 16_000 },
  );
  assert.equal(result.items[0]?.status, "failure");
  assert.match(result.items[0]?.reason ?? "", /Could not start/);
});

test("batch output is bounded, marked truncated, and keeps the tail of failures", async () => {
  const result = await runBatch(
    [
      nodeTask("console.log('x'.repeat(30000)); console.error('FINAL-ERROR'); process.exit(1)"),
      nodeTask("console.log('small')"),
    ],
    { onError: "continue", maxBytes: 2048 },
  );
  assert.equal(result.truncated, true);
  assert.equal(result.items[0]?.outputTruncated, true);
  assert.match(result.items[0]?.stderr ?? "", /FINAL-ERROR/);
  assert.match(result.items[1]?.stdout ?? "", /small/);
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 2048);
});

// ---------------------------------------------------------------- policy

const CONTEXT = { root: ROOT, allowedScripts: ["check"] };

test("blacklist entries are not bypassed by global options before the subcommand", () => {
  const blacklist = ["git push", "npm publish"];
  assert.equal(isCommandBlacklisted("git", ["push"], blacklist), true);
  assert.equal(isCommandBlacklisted("git", ["-C", ".", "push"], blacklist), true);
  assert.equal(isCommandBlacklisted("git", ["-c", "a=b", "push", "--force"], blacklist), true);
  assert.equal(isCommandBlacklisted("git", ["--git-dir=.git", "push"], blacklist), true);
  assert.equal(isCommandBlacklisted("npm", ["--prefix", "x", "publish"], blacklist), true);
  assert.equal(isCommandBlacklisted("git", ["status"], blacklist), false);
  assert.equal(isCommandBlacklisted("git", ["-C", ".", "status"], blacklist), false);
});

test("git guardrails block execution vectors but keep normal use", () => {
  const deny = (args: string[]) => evaluateCommandPolicy("git", args, CONTEXT);
  assert.match(deny(["-c", "core.sshCommand=x", "fetch"]) ?? "", /guardrail/);
  assert.match(deny(["-c", "alias.x=!sh", "x"]) ?? "", /guardrail/);
  assert.match(deny(["--exec-path=/tmp", "status"]) ?? "", /guardrail/);
  assert.match(deny(["-C", "../outside", "status"]) ?? "", /inside the project root/);
  assert.match(deny(["config", "alias.x", "!sh"]) ?? "", /guardrail/);
  assert.match(deny(["fetch", "--upload-pack=x"]) ?? "", /guardrail/);
  assert.equal(deny(["-c", "color.ui=never", "diff"]), undefined);
  assert.equal(deny(["-C", ".", "status"]), undefined);
  assert.equal(deny(["config", "--get", "user.name"]), undefined);
  assert.equal(deny(["commit", "-m", "message"]), undefined);
  assert.equal(deny(["push", "origin", "main"]), undefined);
});

test("package manager guardrails block publishing, remote execution and unlisted scripts", () => {
  const deny = (command: string, args: string[]) => evaluateCommandPolicy(command, args, CONTEXT);
  assert.match(deny("npm", ["publish"]) ?? "", /guardrail/);
  assert.match(deny("npm", ["--prefix", "x", "publish"]) ?? "", /guardrail/);
  assert.match(deny("pnpm", ["dlx", "something"]) ?? "", /remote code/);
  assert.match(deny("npm", ["exec", "tool"]) ?? "", /remote code/);
  assert.match(deny("npm", ["run", "release"]) ?? "", /run_package_scripts_batch/);
  assert.match(deny("npm", ["test"]) ?? "", /run_package_scripts_batch/);
  assert.equal(deny("npm", ["run", "check"]), undefined);
  assert.equal(deny("npm", ["install"]), undefined);
  assert.equal(deny("npm", ["pack", "--dry-run"]), undefined);
});

test("gh, rg and find guardrails block write and execution modes", () => {
  const gh = (args: string[]) => evaluateCommandPolicy("gh", args, CONTEXT);
  assert.equal(gh(["api", "repos/o/r/pulls"]), undefined);
  assert.match(gh(["api", "-X", "DELETE", "repos/o/r"]) ?? "", /DELETE/);
  assert.match(gh(["api", "-f", "a=b", "repos/o/r"]) ?? "", /write/);
  assert.match(gh(["repo", "delete", "o/r"]) ?? "", /not available/);
  assert.match(gh(["auth", "token"]) ?? "", /not available/);
  assert.equal(gh(["pr", "merge", "1"]), undefined);
  assert.match(evaluateCommandPolicy("rg", ["--pre=cat", "x"], CONTEXT) ?? "", /external program/);
  assert.equal(evaluateCommandPolicy("rg", ["x", "src"], CONTEXT), undefined);
  assert.match(
    evaluateCommandPolicy("find", [".", "-exec", "rm", "{}", ";"], CONTEXT) ?? "",
    /find -exec/,
  );
  assert.equal(evaluateCommandPolicy("find", [".", "-name", "x"], CONTEXT), undefined);
});

test("profile rules extend the built-in guardrails and can be disabled explicitly", () => {
  const policy = { rules: { git: { allowSubcommands: ["status", "diff"] } } };
  assert.equal(evaluateCommandPolicy("git", ["status"], { ...CONTEXT, policy }), undefined);
  assert.match(
    evaluateCommandPolicy("git", ["log"], { ...CONTEXT, policy }) ?? "",
    /allowed subcommands/,
  );
  const denied = { rules: { git: { denySubcommands: ["push"], denyOptions: ["--force"] } } };
  assert.match(
    evaluateCommandPolicy("git", ["push"], { ...CONTEXT, policy: denied }) ?? "",
    /denied/,
  );
  assert.match(
    evaluateCommandPolicy("git", ["commit", "--force"], { ...CONTEXT, policy: denied }) ?? "",
    /denied/,
  );
  const off = { builtinGuardrails: false };
  assert.equal(evaluateCommandPolicy("npm", ["publish"], { ...CONTEXT, policy: off }), undefined);
  assert.equal(isCommandPolicy({ rules: { git: { denyOptions: ["--x"] } } }), true);
  assert.equal(isCommandPolicy({ rules: { git: { denyOptions: "--x" } } }), false);
  assert.equal(isCommandPolicy({ builtinGuardrails: "no" }), false);
});

test("legacy npm.allowedScripts profiles are migrated with a warning instead of losing their scripts", () => {
  const warnings: string[] = [];
  const config = {
    profiles: {
      old: {
        directory: "/p",
        port: 3000,
        tunnel: "none",
        npm: { allowedScripts: ["check", "test"] },
      },
      current: {
        directory: "/q",
        port: 3001,
        tunnel: "none",
        scripts: { allowedScripts: ["build"] },
      },
    },
  } as unknown as AgentConfig;
  migrateLegacyProfiles(config, (message) => warnings.push(message));
  assert.deepEqual(config.profiles.old?.scripts, { allowedScripts: ["check", "test"] });
  assert.deepEqual(config.profiles.current?.scripts, { allowedScripts: ["build"] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /Profile 'old'/);
});

test("profile validation accepts guardrail settings and rejects malformed ones", () => {
  assert.equal(
    isCommandPolicy({ builtinGuardrails: false, rules: { git: { denyOptions: ["--force"] } } }),
    true,
  );
  assert.equal(isCommandPolicy([]), false);
  assert.equal(isCommandPolicy({ rules: { git: [] } }), false);
});

test("checkCommand keeps the allowlist and blacklist messages", () => {
  const context = { allowedCommands: ["git"], blacklistedCommands: ["git reset --hard"] };
  assert.equal(checkCommand(ROOT, "bad command", [], context), "Invalid command name.");
  assert.match(checkCommand(ROOT, "curl", [], context) ?? "", /is not allowed by this profile/);
  assert.match(
    checkCommand(ROOT, "git", ["reset", "--hard"], context) ?? "",
    /is blocked by this profile/,
  );
  assert.match(
    checkCommand(ROOT, "git", ["-C", ".", "reset", "--hard"], context) ?? "",
    /is blocked/,
  );
  assert.equal(checkCommand(ROOT, "git", ["status"], context), undefined);
});

// ---------------------------------------------------------------- through the MCP handler

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "batch-test", version: "1.0.0" },
};

type BatchBody = {
  result: {
    structuredContent: {
      ok: boolean;
      summary: { success: number; failure: number; skipped: number };
      items: Array<{ status: string; ran: boolean; reason?: string; command: string }>;
    };
  };
};

async function callBatch(
  handler: ReturnType<typeof createMcpHandler>,
  name: string,
  args: Record<string, unknown>,
): Promise<BatchBody["result"]["structuredContent"]> {
  const response = await handler(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args, _meta: META },
      }),
    }),
  );
  const body = (await response.json()) as BatchBody;
  return body.result.structuredContent;
}

test("run_command_batch applies guardrails per item and reports every status", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-batch-"));
  try {
    const handler = createMcpHandler(root, { commands: ["git"] }, { level: "none" });
    const commands = [
      { command: "git", args: ["-c", "core.sshCommand=x", "status"] },
      { command: "git", args: ["--version"] },
      { command: "curl", args: ["https://example.com"] },
    ];
    const result = await callBatch(handler, "run_command_batch", { commands });
    assert.deepEqual(
      result.items.map((item) => [item.status, item.ran]),
      [
        ["failure", false],
        ["success", true],
        ["failure", false],
      ],
    );
    assert.match(result.items[0]?.reason ?? "", /guardrail/);
    assert.match(result.items[2]?.reason ?? "", /not allowed by this profile/);

    const stopped = await callBatch(handler, "run_command_batch", { commands, onError: "stop" });
    assert.deepEqual(
      stopped.items.map((item) => [item.status, item.ran]),
      [
        ["failure", false],
        ["skipped", false],
        ["failure", false],
      ],
    );
    assert.equal(stopped.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run_package_scripts_batch stops by default and can continue", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-scripts-"));
  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "fixture",
        scripts: { a: "node -e 0", b: 'node -e "process.exit(3)"', c: "node -e 0" },
      }),
    );
    const handler = createMcpHandler(
      root,
      { scripts: { allowedScripts: ["a", "b", "c"] } },
      { level: "none" },
    );
    const stopped = await callBatch(handler, "run_package_scripts_batch", {
      scripts: ["a", "b", "c"],
    });
    assert.deepEqual(
      stopped.items.map((item) => item.status),
      ["success", "failure", "skipped"],
    );
    const continued = await callBatch(handler, "run_package_scripts_batch", {
      scripts: ["a", "b", "c"],
      onError: "continue",
    });
    assert.deepEqual(
      continued.items.map((item) => item.status),
      ["success", "failure", "success"],
    );
    const rejected = await callBatch(handler, "run_package_scripts_batch", {
      scripts: ["a", "missing"],
    });
    assert.deepEqual(
      rejected.items.map((item) => [item.status, item.ran]),
      [
        ["skipped", false],
        ["failure", false],
      ],
    );
    assert.match(rejected.items[1]?.reason ?? "", /does not exist/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("batch tools accept a per-call timeout and reject out-of-range values", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-timeout-"));
  try {
    const handler = createMcpHandler(root, { commands: ["node"] }, { level: "none" });
    const started = Date.now();
    const result = await callBatch(handler, "run_command_batch", {
      commands: [
        { command: "node", args: ["-e", "console.log('x'); setTimeout(() => {}, 20000)"] },
      ],
      timeoutMs: 1000,
    });
    assert.equal(result.items[0]?.status, "failure");
    assert.match(result.items[0]?.reason ?? "", /Timed out/);
    assert.ok(Date.now() - started < 10_000);

    const response = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "run_command_batch",
            arguments: { commands: [{ command: "node" }], timeoutMs: 5 },
            _meta: META,
          },
        }),
      }),
    );
    const body = (await response.json()) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0]?.text ?? "", /timeoutMs must be/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package scripts accept arguments only when the profile allows them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-script-args-"));
  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "fixture",
        scripts: {
          show: "node -e \"console.log(process.argv.slice(1).join('|'))\"",
          other: 'node -e "console.log(1)"',
        },
      }),
    );
    const handler = createMcpHandler(
      root,
      { scripts: { allowedScripts: ["show", "other"], argumentScripts: ["show"] } },
      { level: "none" },
    );
    const result = await callBatch(handler, "run_package_scripts_batch", {
      scripts: [
        { script: "show", args: ["one", "two words"] },
        { script: "other", args: ["x"] },
      ],
      onError: "continue",
    });
    assert.equal(result.items[0]?.status, "success");
    assert.equal(result.items[0]?.command, "npm run show -- one two words");
    assert.match((result.items[0] as { stdout?: string }).stdout ?? "", /one\|two words/);
    assert.equal(result.items[1]?.status, "failure");
    assert.equal(result.items[1]?.ran, false);
    assert.match(result.items[1]?.reason ?? "", /does not accept arguments/);

    const bad = await callBatch(handler, "run_package_scripts_batch", {
      scripts: [{ script: "show", args: ["line\nbreak"] }],
    });
    assert.match(bad.items[0]?.reason ?? "", /single lines/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scripts that rewrite files are identified for warnings", () => {
  assert.deepEqual(
    mutatingScripts(["check", "format", "check:write", "lint:fix", "test", "prefix", "build"]),
    ["format", "check:write", "lint:fix"],
  );
});

test("CLI profiles store protected path options", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "agent-dir-config-protect-"));
  try {
    const configDir = path.join(home, ".config", "agent-dir");
    await mkdir(configDir, { recursive: true });
    const output = execFileSync(
      process.execPath,
      [
        "dist/bin/agent-dir.js",
        "config",
        "add",
        "demo",
        "--directory",
        home,
        "--protect",
        ".github/workflows/**,scripts/release/**",
        "--unprotect",
        ".env.test",
      ],
      { encoding: "utf8", env: { ...process.env, HOME: home } },
    );
    assert.match(output, /Saved profile 'demo'/);
    const saved = JSON.parse(await readFile(path.join(configDir, "config.json"), "utf8")) as {
      profiles: Record<string, { protectedPaths?: { extra?: string[]; allow?: string[] } }>;
    };
    assert.deepEqual(saved.profiles.demo?.protectedPaths, {
      extra: [".github/workflows/**", "scripts/release/**"],
      allow: [".env.test"],
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
