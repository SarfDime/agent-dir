import type { TelemetryErrorCategory, TelemetryErrorReason } from "./telemetry/types.js";
import { ToolFailure } from "./tools/failure.js";

export function classifyTelemetryError(error: unknown): TelemetryErrorCategory {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (error instanceof ToolFailure) return error.category;
  if (message.startsWith("unknown tool")) return "unknown_tool";
  if (
    message.includes("integration is unavailable") ||
    message.includes("is not installed") ||
    message.includes("process is not running") ||
    message.includes("analytics is disabled") ||
    message.includes("not indexed")
  )
    return "unavailable_integration";
  if (
    message.includes("not found") ||
    message.includes("enoent") ||
    message.includes("no such file") ||
    message.includes("does not exist")
  )
    return "not_found";
  if (
    message.includes("guardrail") ||
    message.includes("is not allowed by this profile") ||
    message.includes("is blocked by this profile") ||
    message.includes("is protected") ||
    message.includes("protected path")
  )
    return "policy_denied";
  if (message.includes("invalid") || message.includes("must be")) return "invalid_input";
  if (message.includes("blocked") || message.includes("not allowed")) return "authorization";
  if (message.includes("timeout") || message.includes("timed out")) return "timeout";
  if (message.includes("authentication") || message.includes("unauthorized"))
    return "authentication";
  return "execution";
}

/**
 * Machine-readable reason for a failure, from typed errors where they exist and from the message
 * otherwise. Never derived from, or containing, argument values or file contents.
 */
export function classifyTelemetryReason(error: unknown): TelemetryErrorReason | undefined {
  if (error instanceof ToolFailure) return error.reason;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.startsWith("unknown tool")) return undefined;
  if (message.includes("enoent") || message.includes("does not exist")) return "path_not_found";
  if (message.includes("patch text was not found")) return "patch_text_not_found";
  if (message.includes("times in '")) return "patch_ambiguous";
  if (message.includes("is required")) return "missing_required";
  if (message.includes("must be") || message.includes("must contain")) return "type_mismatch";
  return "other";
}
