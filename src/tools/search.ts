import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { commandEnvironment } from "./commands.js";
import { safePath } from "./files.js";
import { matchesGlob } from "./glob.js";
import { RipgrepFallback, searchBuiltin, searchRipgrep } from "./search-backends.js";
import { listProjectFiles } from "./walk.js";

/**
 * Text search with two interchangeable backends. ripgrep is used when installed (recommended);
 * a built-in scanner is the fallback. Both search exactly the same candidate files (chosen in
 * Node), apply the same limits (files over 1 MB and binary files are skipped, results are
 * ordered by path and line, one result per line), and return the same result shape.
 */
export type SearchBackend = "ripgrep" | "builtin";

export interface SearchRequest {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  /** Project-relative files or directories to search; empty means everything. */
  paths: string[];
  /** Include globs, or exclude globs prefixed with `!`. */
  globs: string[];
  context: number;
  maxResults: number;
  includeGenerated: boolean;
  /** Let the pattern match across line boundaries (`.` then also matches newlines). */
  multiline?: boolean;
  /** Optional filter on a candidate hit: the full line and the 0-based match index. */
  accept?: (line: string, index: number) => boolean;
}

export interface RawMatch {
  path: string;
  line: number;
  /** Last line of the match; equals `line` for single-line matches. */
  endLine: number;
  /** 1-based column in UTF-16 units. */
  column: number;
  raw: string;
  before: string[];
  after: string[];
}

export interface SearchOutcome {
  matches: RawMatch[];
  /** True when more matches existed than maxResults. */
  moreAvailable: boolean;
  backend: SearchBackend;
  incomplete: boolean;
  notes: string[];
  /** Number of candidate files actually searched, so an empty result can explain itself. */
  scanned: number;
}

const MAX_FILE_BYTES = 1_000_000;

const GENERATED_FILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
  "*.lock",
  "*.min.js",
  "*.min.css",
  "*.map",
];

// ---------------------------------------------------------------- backend detection

let detection: { backend: SearchBackend; version?: string } | undefined;

export function detectSearchBackend(): { backend: SearchBackend; version?: string } {
  if (detection) return detection;
  if (process.env.AGENT_DIR_SEARCH_BACKEND !== "builtin") {
    try {
      const result = spawnSync("rg", ["--version", "--no-config"], {
        encoding: "utf8",
        timeout: 3000,
        env: commandEnvironment(),
      });
      if (result.status === 0) {
        const version = /ripgrep\s+(\S+)/.exec(result.stdout)?.[1];
        detection = { backend: "ripgrep", ...(version ? { version } : {}) };
        return detection;
      }
    } catch {
      // Not installed: fall through to the built-in backend.
    }
  }
  detection = { backend: "builtin" };
  return detection;
}

export function resetSearchBackendForTests(): void {
  detection = undefined;
}

export function describeSearchBackend(): string {
  const { backend, version } = detectSearchBackend();
  return backend === "ripgrep"
    ? `ripgrep${version ? ` ${version}` : ""}`
    : "built-in (install ripgrep for faster search: https://github.com/BurntSushi/ripgrep#installation)";
}

// ---------------------------------------------------------------- candidate files

function normalizeScope(value: string): string {
  const normalized = path.posix
    .normalize(value.replace(/\\/g, "/"))
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  if (normalized === "." || normalized === "") return "";
  if (normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized))
    throw new Error(`Search path '${value}' escapes the exposed project directory.`);
  return normalized;
}

async function candidateFiles(
  root: string,
  request: SearchRequest,
): Promise<{ files: string[]; incomplete: boolean; notes: string[] }> {
  const listing = await listProjectFiles(root);
  const notes: string[] = [];
  let files = listing.files;
  const scopes = request.paths.map(normalizeScope);
  if (scopes.length > 0 && !scopes.includes("")) {
    files = files.filter((file) =>
      scopes.some((scope) => file === scope || file.startsWith(`${scope}/`)),
    );
    for (const [index, scope] of scopes.entries()) {
      if (!listing.files.some((file) => file === scope || file.startsWith(`${scope}/`)))
        notes.push(`Path '${request.paths[index]}' matched no project files.`);
    }
  }
  const include = request.globs.filter((glob) => !glob.startsWith("!"));
  const exclude = request.globs.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1));
  if (include.length > 0)
    files = files.filter((file) => include.some((glob) => matchesGlob(glob, file)));
  if (exclude.length > 0)
    files = files.filter((file) => !exclude.some((glob) => matchesGlob(glob, file)));
  if (!request.includeGenerated) {
    files = files.filter(
      (file) => scopes.includes(file) || !GENERATED_FILES.some((glob) => matchesGlob(glob, file)),
    );
  }
  return { files, incomplete: listing.incomplete, notes };
}

/** Drops files over the size limit and symlinks that leave the project root. */
async function searchableFiles(root: string, files: string[]): Promise<string[]> {
  const resolvedRoot = await fs.realpath(root);
  const keep: boolean[] = [];
  const CHUNK = 64;
  for (let start = 0; start < files.length; start += CHUNK) {
    const chunk = files.slice(start, start + CHUNK);
    const results = await Promise.all(
      chunk.map(async (relative) => {
        try {
          const full = path.join(resolvedRoot, relative);
          const stat = await fs.lstat(full);
          if (stat.isSymbolicLink()) {
            const target = await safePath(resolvedRoot, relative);
            const targetStat = await fs.stat(target);
            return targetStat.isFile() && targetStat.size <= MAX_FILE_BYTES;
          }
          return stat.isFile() && stat.size <= MAX_FILE_BYTES;
        } catch {
          return false;
        }
      }),
    );
    keep.push(...results);
  }
  return files.filter((_, index) => keep[index]);
}

// ---------------------------------------------------------------- entry point

export async function runSearch(
  root: string,
  request: SearchRequest,
  forcedBackend?: SearchBackend,
): Promise<SearchOutcome> {
  if (!request.query.trim()) throw new Error("Search query cannot be empty.");
  const candidates = await candidateFiles(root, request);
  const files = await searchableFiles(root, candidates.files);
  const limit = request.maxResults + 1;
  const notes = [...candidates.notes];
  let incomplete = candidates.incomplete;
  let backend = forcedBackend ?? detectSearchBackend().backend;
  let matches: RawMatch[] = [];

  if (backend === "ripgrep") {
    try {
      const result = await searchRipgrep(root, request, files, limit);
      matches = result.matches;
      if (result.timedOut) {
        incomplete = true;
        notes.push(
          "ripgrep timed out after 30 s; results may be incomplete. Narrow the search with paths or globs.",
        );
      }
    } catch (error) {
      if (!(error instanceof RipgrepFallback)) throw error;
      backend = "builtin";
      notes.push(
        `ripgrep could not run this pattern (${error.message}); used the built-in search instead.`,
      );
    }
  }
  if (backend === "builtin") matches = await searchBuiltin(root, request, files, limit);

  return {
    matches: matches.slice(0, request.maxResults),
    moreAvailable: matches.length > request.maxResults,
    backend,
    incomplete,
    notes,
    scanned: files.length,
  };
}
