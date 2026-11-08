export function optionalStringArray(
  value: unknown,
  name: string,
  max: number,
): string[] | undefined {
  if (value === undefined) return undefined;
  const entries: unknown[] | undefined =
    typeof value === "string" ? [value] : Array.isArray(value) ? value : undefined;
  if (entries === undefined || entries.length > max)
    throw new Error(`${name} must be a string or an array of at most ${max} strings.`);
  const strings: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string")
      throw new Error(`${name} must be a string or an array of at most ${max} strings.`);
    strings.push(entry);
  }
  return strings;
}

export function intArg(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return value as number;
}
