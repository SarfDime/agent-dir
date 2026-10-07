import { TELEMETRY_LEVELS, type TelemetryConfig, type TelemetryLevel } from "./types.js";

export const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = { level: "none" };

export function isTelemetryLevel(value: unknown): value is TelemetryLevel {
  return typeof value === "string" && TELEMETRY_LEVELS.includes(value as TelemetryLevel);
}

export function parseTelemetryConfig(value: unknown): TelemetryConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") return undefined;
  const level = (value as Record<string, unknown>).level;
  if (!isTelemetryLevel(level)) return undefined;
  return { level };
}
