import type { TelemetryErrorReason } from "./telemetry/types.js";

/** Narrows an unknown value to a plain object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ArgumentSchema = Record<string, unknown>;

function typeMatches(type: unknown, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
    default:
      return true;
  }
}

/** A rejected argument list: the message the caller sees plus the machine-readable reason. */
export interface ToolArgumentProblem {
  message: string;
  reason: TelemetryErrorReason;
}

/** Keys shaped like a transport encoding wrapper, which Agent Dir does not accept anywhere. */
const ENCODING_ARGUMENT = /base64|b64|encod/i;

/**
 * Keys shaped like the whole argument object wrapped into one string (`{"_raw": "{...}"}`).
 * Deliberately narrow: a wrong key that is not one of these keeps the plain rejection, so the hint
 * never costs bytes on an ordinary typo.
 */
const WRAPPED_ARGUMENTS = /^_?raw([_-]?arg(s|uments?))?$|^(args|arguments)[_-]?(json|raw)$/i;

function argumentProblem(message: string, reason: TelemetryErrorReason): ToolArgumentProblem {
  return { message, reason };
}

function withArticle(type: string): string {
  return /^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`;
}

/** JSON type name of a received value, so a type error says what actually arrived. */
function describeJsonType(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

/**
 * Validates tool arguments against the advertised `inputSchema` before dispatch, so a bad call
 * fails with a message naming the argument instead of a coercion artefact inside a tool.
 */
export function validateToolArguments(
  schema: ArgumentSchema,
  value: unknown,
  path = "",
  toolName?: string,
): ToolArgumentProblem | undefined {
  const label = path || "arguments";
  const unknownArgument = (key: string, names: string[]): ToolArgumentProblem => {
    // A client that invented an encoding wrapper, or that wrapped the whole argument object into
    // one string, is corrected in the text it actually reads instead of only being rejected.
    const hint = WRAPPED_ARGUMENTS.test(key)
      ? ' The whole argument object was sent as one string. Send the arguments themselves, for example {"changes": [...]}, not a wrapper key.'
      : toolName === "apply_changes" && ENCODING_ARGUMENT.test(key)
        ? " apply_changes takes plain JSON; escape quotes and newlines in `content` and `patches` as normal JSON strings. There is no base64 option."
        : "";
    return argumentProblem(
      names.length
        ? `Unknown argument '${key}'. Valid arguments: ${names.join(", ")}.${hint}`
        : `Unknown argument '${key}'. This tool takes no arguments.${hint}`,
      "unknown_argument",
    );
  };
  // A misspelled argument is reported against the parent schema before any `anyOf` branch runs,
  // otherwise an alternative shape's `required` check masks the typo with "is required".
  if (isRecord(value) && schema.additionalProperties === false && isRecord(schema.properties)) {
    const names = Object.keys(schema.properties);
    for (const key of Object.keys(value)) {
      if (!isRecord(schema.properties[key])) return unknownArgument(key, names);
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const errors = schema.anyOf.map((branch) =>
      isRecord(branch) ? validateToolArguments(branch, value, path, toolName) : undefined,
    );
    const failures = errors.filter((error): error is ToolArgumentProblem => error !== undefined);
    if (failures.length < errors.length) {
      // A branch matched, but the properties the schema declares itself still apply to the value.
      const { anyOf: _matched, ...own } = schema;
      return validateToolArguments(own, value, path, toolName);
    }
    // No branch matched. When every branch only lacks its own key, say so once; otherwise the
    // branch that got past the presence check is the closer match and its error is the useful one.
    if (failures.length > 0 && failures.every((error) => error.reason === "missing_required")) {
      const names = schema.anyOf.flatMap((branch) =>
        isRecord(branch) && Array.isArray(branch.required)
          ? branch.required.map((name) => `'${path ? `${label}.${String(name)}` : String(name)}'`)
          : [],
      );
      return argumentProblem(`One of ${names.join(" or ")} is required.`, "missing_required");
    }
    return (
      failures.find((error) => error.reason !== "missing_required") ??
      failures[0] ??
      argumentProblem(`${label} does not match any allowed shape.`, "other")
    );
  }
  if (schema.type !== undefined && !typeMatches(schema.type, value))
    return argumentProblem(
      `'${label}' must be ${schema.type === "integer" ? "an integer" : withArticle(String(schema.type))} (got ${describeJsonType(value)}).`,
      "type_mismatch",
    );
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    return argumentProblem(
      `'${label}' must be one of ${schema.enum.map(String).join(", ")}.`,
      "enum_mismatch",
    );

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.trim().length < schema.minLength)
      return argumentProblem(
        `'${label}' must be at least ${schema.minLength} characters.`,
        "length_or_range",
      );
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
      return argumentProblem(
        `'${label}' must be at most ${schema.maxLength} characters.`,
        "length_or_range",
      );
    return undefined;
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      return argumentProblem(`'${label}' must be at least ${schema.minimum}.`, "length_or_range");
    if (typeof schema.maximum === "number" && value > schema.maximum)
      return argumentProblem(`'${label}' must be at most ${schema.maximum}.`, "length_or_range");
    return undefined;
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      return argumentProblem(
        `'${label}' needs at least ${schema.minItems} item(s).`,
        "length_or_range",
      );
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      return argumentProblem(
        `'${label}' accepts at most ${schema.maxItems} item(s).`,
        "length_or_range",
      );
    if (isRecord(schema.items))
      for (const [index, entry] of value.entries()) {
        const error = validateToolArguments(schema.items, entry, `${label}[${index}]`, toolName);
        if (error) return error;
      }
    return undefined;
  }

  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const names = Object.keys(properties);
    // Report a misspelled argument before a missing one: it is the more actionable signal.
    for (const [key, entry] of Object.entries(value)) {
      const property = properties[key];
      if (!isRecord(property)) {
        if (schema.additionalProperties === false) return unknownArgument(key, names);
        continue;
      }
      const error = validateToolArguments(
        property,
        entry,
        path ? `${label}.${key}` : key,
        toolName,
      );
      if (error) return error;
    }
    for (const required of Array.isArray(schema.required) ? schema.required : []) {
      const name = String(required);
      if (!(name in value))
        return argumentProblem(
          `'${path ? `${label}.${name}` : name}' is required.`,
          "missing_required",
        );
    }
  }
  return undefined;
}
