/**
 * Minimal glob matching shared by protected paths and search scoping.
 * `*` and `?` stay within a path segment, `**` crosses segments, matching is case-insensitive.
 */
export function globToRegExp(pattern: string, flags = "i"): RegExp {
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
  return new RegExp(`^${source}$`, flags);
}

/**
 * Matches a project-relative path. A pattern without `/` matches the file name at any depth
 * (`mcp.ts` finds `src/mcp.ts`), like a `.gitignore` entry.
 */
export function matchesGlob(pattern: string, relativePath: string): boolean {
  const trimmed = pattern.startsWith("./") ? pattern.slice(2) : pattern;
  const anchored = trimmed.includes("/") ? trimmed : `**/${trimmed}`;
  return globToRegExp(anchored).test(relativePath.replace(/\\/g, "/"));
}
