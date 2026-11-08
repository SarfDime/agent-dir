import type { TelemetryErrorCategory, TelemetryErrorReason } from "../telemetry/types.js";

export type ToolFailureReason = Exclude<
  TelemetryErrorReason,
  "unknown_argument" | "type_mismatch" | "missing_required" | "enum_mismatch" | "other"
>;

const FAILURE_CATEGORIES: Record<ToolFailureReason, TelemetryErrorCategory> = {
  patch_text_not_found: "not_found",
  patch_ambiguous: "conflict",
  path_not_found: "not_found",
  path_outside_root: "invalid_input",
  protected_path: "policy_denied",
  range_too_large: "invalid_input",
  not_a_file: "invalid_input",
  binary_file: "invalid_input",
  file_too_large: "invalid_input",
  invalid_pattern: "invalid_input",
  command_invalid: "invalid_input",
  command_not_allowed: "policy_denied",
  command_blocked: "policy_denied",
  command_timeout: "timeout",
  command_aborted: "execution",
  command_spawn_failed: "execution",
  command_failed: "execution",
  integration_unavailable: "unavailable_integration",
  integration_not_installed: "unavailable_integration",
  integration_not_indexed: "unavailable_integration",
  integration_not_running: "unavailable_integration",
  integration_timeout: "timeout",
  integration_request_too_large: "invalid_input",
  integration_failed: "execution",
  length_or_range: "invalid_input",
};

/** A tool failure with a bounded reason safe to record in telemetry. */
export class ToolFailure extends Error {
  readonly category: TelemetryErrorCategory;
  readonly reason: ToolFailureReason;

  constructor(reason: ToolFailureReason, message: string) {
    super(message);
    this.name = "ToolFailure";
    this.category = FAILURE_CATEGORIES[reason];
    this.reason = reason;
  }
}
