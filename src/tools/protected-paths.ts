/**
 * Paths that agents may not modify through Agent Dir's edit tools by default: version-control
 * internals (hooks and config can run programs), environment files with secrets, and registry
 * credentials. This is a guardrail, not a security boundary (see SECURITY.md).
 */
export interface PathProtectionConfig {
  /** Additional protected patterns (relative, `*`, `**` and `?` supported). */
  extra?: string[];
  /** Patterns that stay editable even when a protected pattern matches. */
  allow?: string[];
}

export const DEFAULT_PROTECTED_PATHS = [
  ".git",
  ".git/**",
  "**/.git/**",
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  ".npmrc",
  "**/.npmrc",
];

const DEFAULT_ALLOWED_PATHS = [
  ".env.example",
  ".env.sample",
  ".env.template",
  "**/.env.example",
  "**/.env.sample",
  "**/.env.template",
];

export function isPathProtectionConfig(value: unknown): value is PathProtectionConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  const strings = (item: unknown): boolean =>
    item === undefined || (Array.isArray(item) && item.every((entry) => typeof entry === "string"));
  return strings(config.extra) && strings(config.allow);
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "i");
}

function matchesAny(relativePath: string, patterns: string[]): string | undefined {
  return patterns.find((pattern) => globToRegExp(pattern).test(relativePath));
}

/** Returns an explanation when the project-relative path is protected, otherwise undefined. */
export function protectedPathProblem(
  relativePath: string,
  config: PathProtectionConfig = {},
): string | undefined {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (matchesAny(normalized, [...DEFAULT_ALLOWED_PATHS, ...(config.allow ?? [])])) return undefined;
  const pattern = matchesAny(normalized, [...DEFAULT_PROTECTED_PATHS, ...(config.extra ?? [])]);
  if (!pattern) return undefined;
  return `'${normalized}' is a protected path (matches '${pattern}'). Edit it yourself, or adjust 'protectedPaths' in the profile if agents may change it.`;
}
