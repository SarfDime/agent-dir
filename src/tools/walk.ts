import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { commandEnvironment } from "./commands.js";

/**
 * The list of project files used by discovery tools. Inside a git work tree it is
 * `git ls-files --cached --others --exclude-standard`, so `.gitignore` (including nested and
 * global ignore files) is honored exactly as git does it. Otherwise a bounded walk with built-in
 * ignores is used. There is no depth limit; the file count is capped and reported.
 */
export interface ProjectFiles {
  /** Project-relative paths with `/` separators, sorted. */
  files: string[];
  source: "git" | "walk";
  /** True when the walk hit its entry or depth cap, so the list may be incomplete. */
  incomplete: boolean;
}

export const DEFAULT_IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".codegraph",
  ".serena",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  ".cache",
  ".turbo",
  ".parcel-cache",
]);

const MAX_WALK_FILES = 200_000;
const MAX_WALK_DEPTH = 64;
const CACHE_TTL_MS = 2_000;

const cache = new Map<string, { at: number; value: ProjectFiles }>();

export function invalidateProjectFiles(_root?: string): void {
  cache.clear();
}

function ignoredPath(file: string): boolean {
  return file
    .split("/")
    .slice(0, -1)
    .some((segment) => DEFAULT_IGNORED_DIRECTORIES.has(segment));
}

function gitFiles(root: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
        maxBuffer: 256 * 1024 * 1024,
        env: { ...commandEnvironment(), GIT_OPTIONAL_LOCKS: "0" },
      },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        resolve(stdout.split("\0").filter((entry) => entry && !entry.endsWith("/")));
      },
    );
  });
}

async function walkFiles(resolvedRoot: string): Promise<{ files: string[]; incomplete: boolean }> {
  const files: string[] = [];
  const stack: string[] = [""];
  let incomplete = false;
  while (stack.length > 0) {
    const relative = stack.pop() as string;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(relative ? `${resolvedRoot}/${relative}` : resolvedRoot, {
        withFileTypes: true,
      });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORED_DIRECTORIES.has(entry.name)) continue;
        if (child.split("/").length > MAX_WALK_DEPTH) {
          incomplete = true;
          continue;
        }
        stack.push(child);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(child);
        if (files.length >= MAX_WALK_FILES) return { files, incomplete: true };
      }
    }
  }
  return { files, incomplete };
}

export async function listProjectFiles(root: string): Promise<ProjectFiles> {
  const resolvedRoot = await fs.realpath(root);
  const key = `${resolvedRoot}\0`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  let value: ProjectFiles;
  const tracked = await gitFiles(resolvedRoot);
  if (tracked) {
    value = {
      files: tracked.filter((file) => !ignoredPath(file)).sort(),
      source: "git",
      incomplete: false,
    };
  } else {
    const walked = await walkFiles(resolvedRoot);
    value = { files: walked.files.sort(), source: "walk", incomplete: walked.incomplete };
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}
