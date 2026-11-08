import assert from "node:assert/strict";
import test from "node:test";
import { guidanceVariant } from "../src/guidance.js";

test("guidanceVariant recognizes the search-footer experiment and defaults unknown values to table", () => {
  assert.equal(guidanceVariant("table"), "table");
  assert.equal(guidanceVariant("terse"), "terse");
  assert.equal(guidanceVariant("search-footer"), "search-footer");
  assert.equal(guidanceVariant("unknown"), "table");
});
