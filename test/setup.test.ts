import assert from "node:assert/strict";
import test from "node:test";
import { shouldOfferSetup } from "../src/setup.js";

test("first run offers setup when no config and no explicit launch options exist", () => {
  assert.equal(shouldOfferSetup(false, {}), true);
});

test("existing config skips first-run setup", () => {
  assert.equal(shouldOfferSetup(true, {}), false);
});

test("explicit random launch skips setup", () => {
  assert.equal(shouldOfferSetup(false, { random: true }), false);
});

test("explicit tunnel selection skips setup", () => {
  assert.equal(shouldOfferSetup(false, { tunnel: "wormhole" }), false);
});

test("explicit no-tunnel launch skips setup", () => {
  assert.equal(shouldOfferSetup(false, { noTunnel: true }), false);
});
