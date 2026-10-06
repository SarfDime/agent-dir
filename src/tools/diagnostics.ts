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

export async function diagnostics(root: string, maxResults = 200): Promise<Diagnostic[]> {
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 1000)
    throw new Error("maxResults must be an integer between 1 and 1000.");
  const resolvedRoot = await fs.realpath(root);
  const entries = await listFiles(root);
  const results: Diagnostic[] = [];
  for (const entry of entries) {
    if (results.length >= maxResults || entry.type !== "file") continue;
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
    if (path.extname(entry.path).toLowerCase() === ".json") {
      try {
        JSON.parse(await fs.readFile(target, "utf8"));
      } catch {
        results.push({
          severity: "error",
          code: "INVALID_JSON",
          path: entry.path,
          message: "File is not valid JSON.",
        });
      }
    }
    try {
      const content = await fs.readFile(target, "utf8");
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length && results.length < maxResults; index += 1)
        if (/^(?:<<<<<<<|=======|>>>>>>>)(?:.*)?$/.test(lines[index] ?? ""))
          results.push({
            severity: "error",
            code: "MERGE_CONFLICT",
            path: entry.path,
            line: index + 1,
            message: "Unresolved Git merge-conflict marker.",
          });
    } catch {
      /* binary/unreadable */
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
