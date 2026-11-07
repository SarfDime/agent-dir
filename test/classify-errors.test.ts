import assert from "node:assert/strict";
import test from "node:test";
import { classifyTelemetryError, classifyTelemetryReason } from "../src/classify-errors.js";
import type { TelemetryErrorCategory, TelemetryErrorReason } from "../src/telemetry/types.js";
import { ToolFailure } from "../src/tools/failure.js";

test("telemetry error categories preserve typed and message-based classification", () => {
  const cases: Array<[unknown, TelemetryErrorCategory]> = [
    [new ToolFailure("range_too_large", ""), "invalid_input"],
    [new ToolFailure("path_not_found", ""), "not_found"],
    [new ToolFailure("command_not_allowed", ""), "policy_denied"],
    [new ToolFailure("command_timeout", ""), "timeout"],
    [new ToolFailure("integration_not_indexed", ""), "unavailable_integration"],
    [new ToolFailure("integration_failed", ""), "execution"],
    [new Error("Unknown tool: read_range"), "unknown_tool"],
    [new Error("Integration is unavailable"), "unavailable_integration"],
    [new Error("The path does not exist"), "not_found"],
    [new Error("The path is protected"), "policy_denied"],
    [new Error("Invalid request"), "invalid_input"],
    [new Error("Command is not allowed"), "authorization"],
    [new Error("Request timed out"), "timeout"],
    [new Error("Authentication failed"), "authentication"],
    [new Error("Spawn failed"), "execution"],
  ];

  for (const [error, expected] of cases) assert.equal(classifyTelemetryError(error), expected);
});

test("telemetry error reasons preserve typed tool reasons and safe fallbacks", () => {
  const typed = new ToolFailure("binary_file", "message with no persisted details");
  assert.equal(classifyTelemetryReason(typed), "binary_file");
  assert.equal(
    classifyTelemetryReason(new ToolFailure("command_not_allowed", "")),
    "command_not_allowed",
  );
  assert.equal(
    classifyTelemetryReason(new ToolFailure("integration_not_indexed", "")),
    "integration_not_indexed",
  );

  const cases: Array<[unknown, TelemetryErrorReason | undefined]> = [
    [new Error("Unknown tool: secret"), undefined],
    [new Error("ENOENT: file"), "path_not_found"],
    [new Error("Patch text was not found"), "patch_text_not_found"],
    [new Error("Patch text occurs 2 times in 'file'"), "patch_ambiguous"],
    [new Error("The query is required"), "missing_required"],
    [new Error("The value must be an array"), "type_mismatch"],
    [new Error("Unexpected failure"), "other"],
  ];

  for (const [error, expected] of cases) assert.equal(classifyTelemetryReason(error), expected);
});
