export const DEFAULT_OUTPUT_BYTES = 8_000;
export const READ_RANGE_DEFAULT_BYTES = 16_000;

export function objectArray(value: unknown, name: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "object" || item === null))
    throw new Error(`${name} must be an array of objects.`);
  return value as Record<string, unknown>[];
}

export function outputBytesArg(value: unknown, fallback = DEFAULT_OUTPUT_BYTES): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < 1024 || result > 64_000)
    throw new Error("maxBytes must be an integer between 1024 and 64000.");
  return result;
}

export function numberArg(value: unknown, fallback: number, max: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < 1 || result > max)
    throw new Error(`Value must be an integer between 1 and ${max}.`);
  return result;
}
