import { promises as fs } from "node:fs";
import path from "node:path";
import { listFiles } from "./files.js";

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  path?: string;
  line?: number;
  message: string;
}

/** Content checks skip larger files; they are not source code worth scanning. */
const MAX_CONTENT_BYTES = 1_000_000;

/** Files whose format is JSON with comments, so comments there are normal. */
const JSONC_NAMES =
  /(?:^|\/)(?:tsconfig[^/]*\.json|jsconfig[^/]*\.json|\.eslintrc\.json|devcontainer\.json|\.vscode\/[^/]+\.json|[^/]+\.jsonc|biome\.jsonc?)$/i;

/** Removes comments and trailing commas, leaving string contents untouched. */
export function stripJsonc(text: string): string {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;
    const next = text[index + 1];
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      output += text.slice(index, end + 1);
      index = end + 1;
    } else if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
    } else {
      output += char;
      index += 1;
    }
  }
  return output.replace(/,(\s*[}\]])/g, "$1");
}

function jsonProblem(relativePath: string, content: string): Diagnostic | undefined {
  try {
    JSON.parse(content);
    return undefined;
  } catch {
    // Fall through to the tolerant parse.
  }
  try {
    JSON.parse(stripJsonc(content));
  } catch {
    return {
      severity: "error",
      code: "INVALID_JSON",
      path: relativePath,
      message: "File is not valid JSON.",
    };
  }
  if (JSONC_NAMES.test(relativePath)) return undefined;
  return {
    severity: "warning",
    code: "JSON_WITH_COMMENTS",
    path: relativePath,
    message: "File contains comments or trailing commas, which strict JSON parsers reject.",
  };
}

/** Reports real conflict blocks only: a lone ======= line (a Markdown heading) is ignored. */
function conflictMarkers(lines: string[]): number[] {
  const found: number[] = [];
  let inConflict = false;
  for (const [index, line] of lines.entries()) {
    if (/^<<<<<<<(?: .*)?$/.test(line)) {
      found.push(index + 1);
      inConflict = true;
    } else if (inConflict && /^=======$/.test(line)) {
      found.push(index + 1);
    } else if (/^>>>>>>>(?: .*)?$/.test(line)) {
      found.push(index + 1);
      inConflict = false;
    }
  }
  return found;
}

export async function diagnostics(root: string, maxResults = 200): Promise<Diagnostic[]> {
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 1000)
    throw new Error("maxResults must be an integer between 1 and 1000.");
  const resolvedRoot = await fs.realpath(root);
  const entries = await listFiles(root);
  const results: Diagnostic[] = [];
  for (const entry of entries) {
    if (results.length >= maxResults) break;
    if (entry.type !== "file") continue;
    const target = path.join(resolvedRoot, entry.path);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(target);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      try {
        await fs.realpath(target);
      } catch {
        results.push({
          severity: "error",
          code: "BROKEN_SYMLINK",
          path: entry.path,
          message: "Symbolic link target does not exist.",
        });
      }
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_CONTENT_BYTES) continue;
    let content: string;
    try {
      content = await fs.readFile(target, "utf8");
    } catch {
      continue;
    }
    if (content.includes("\0")) continue;
    if (path.extname(entry.path).toLowerCase() === ".json" || /\.jsonc$/i.test(entry.path)) {
      const problem = jsonProblem(entry.path, content);
      if (problem) results.push(problem);
    }
    for (const line of conflictMarkers(content.split(/\r?\n/))) {
      if (results.length >= maxResults) break;
      results.push({
        severity: "error",
        code: "MERGE_CONFLICT",
        path: entry.path,
        line,
        message: "Unresolved Git merge-conflict marker.",
      });
    }
  }
  const rootEntries = await fs.readdir(resolvedRoot);
  if (rootEntries.includes("package.json")) {
    try {
      const packageJson = JSON.parse(
        await fs.readFile(path.join(resolvedRoot, "package.json"), "utf8"),
      ) as { scripts?: Record<string, string> };
      if (!packageJson.scripts)
        results.push({
          severity: "warning",
          code: "NO_NPM_SCRIPTS",
          path: "package.json",
          message: "package.json has no scripts object.",
        });
    } catch {
      /* INVALID_JSON already reports it */
    }
  }
  return results;
}
