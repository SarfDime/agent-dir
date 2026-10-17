import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendBoundedOutput,
  commandEnvironment,
  isCommandBlacklisted,
  runCommand,
} from "../src/tools/commands.js";
import { runPackageScript } from "../src/tools/package-scripts.js";

test("command output is bounded and marked when truncated", () => {
  const output = appendBoundedOutput("", "x".repeat(600_000));
  assert.ok(Buffer.byteLength(output, "utf8") <= 512_000);
  assert.match(output, /output truncated at 512 KB/);
  assert.equal(appendBoundedOutput(output, "more"), output);
});

test("child command environment filters common secret-bearing variables", () => {
  const previousToken = process.env.AGENT_DIR_TEST_TOKEN;
  const previousPath = process.env.PATH;
  process.env.AGENT_DIR_TEST_TOKEN = "do-not-forward";
  try {
    const env = commandEnvironment();
    assert.equal(env.AGENT_DIR_TEST_TOKEN, undefined);
    assert.equal(env.PATH, previousPath);
  } finally {
    if (previousToken === undefined) delete process.env.AGENT_DIR_TEST_TOKEN;
    else process.env.AGENT_DIR_TEST_TOKEN = previousToken;
  }
});

test("package scripts run with the filtered environment while retaining build essentials", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-npm-env-"));
  const previousToken = process.env.AGENT_DIR_TEST_TOKEN;
  process.env.AGENT_DIR_TEST_TOKEN = "must-not-reach-script";
  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        private: true,
        scripts: {
          "env-check":
            'node -e "process.stdout.write(JSON.stringify({token:process.env.AGENT_DIR_TEST_TOKEN||null,path:!!process.env.PATH,home:!!process.env.HOME}))"',
        },
      }),
    );
    const result = await runPackageScript(root, "env-check", 10_000, ["env-check"]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1) ?? ""), {
      token: null,
      path: true,
      home: true,
    });
  } finally {
    if (previousToken === undefined) delete process.env.AGENT_DIR_TEST_TOKEN;
    else process.env.AGENT_DIR_TEST_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

test("configured package scripts work with the filtered environment", async () => {
  for (const script of ["check", "format:check"]) {
    const result = await runPackageScript(process.cwd(), script, 120_000, [script]);
    assert.equal(result.exitCode, 0, `${script} failed:\n${result.stderr}\n${result.stdout}`);
  }
});

test("command timeout terminates descendant processes", async (t) => {
  if (process.platform === "win32") return t.skip("Process-group assertion is POSIX-specific.");
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-command-tree-"));
  const pidFile = path.join(root, "child.pid");
  try {
    const script = [
      "const fs=require('node:fs');",
      "const {spawn}=require('node:child_process');",
      "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
      `fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));`,
      "setInterval(()=>{},1000);",
    ].join("");
    await assert.rejects(runCommand(root, "node", ["-e", script], ["node"], [], 250), /timed out/);
    const childPid = Number(await readFile(pidFile, "utf8"));
    let terminated = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        process.kill(childPid, 0);
      } catch {
        terminated = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(
      terminated,
      true,
      "The spawned descendant should be terminated with the command process group.",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("blacklisted command prefixes block a subcommand without blocking the executable", () => {
  const blacklist = ["git commit"];

  assert.equal(isCommandBlacklisted("git", ["commit", "-m", "message"], blacklist), true);
  assert.equal(isCommandBlacklisted("git", ["status"], blacklist), false);
  assert.equal(isCommandBlacklisted("git", ["diff"], blacklist), false);
});

test("a bare blacklisted command blocks every invocation of that executable", () => {
  const blacklist = ["git"];

  assert.equal(isCommandBlacklisted("git", ["status"], blacklist), true);
  assert.equal(isCommandBlacklisted("git", [], blacklist), true);
  assert.equal(isCommandBlacklisted("grep", ["git"], blacklist), false);
});
