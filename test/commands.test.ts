import assert from "node:assert/strict";
import test from "node:test";
import { isCommandBlacklisted } from "../src/tools/commands.js";

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
