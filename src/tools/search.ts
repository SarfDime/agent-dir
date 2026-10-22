import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { commandEnvironment, processTreeSpawnOptions, terminateProcessTree } from "./commands.js";
import { safePath } from "./files.js";
import { matchesGlob } from "./glob.js";
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
  /** Optional filter on a candidate hit: the full line and the 0-based match index. */
  accept?: (line: string, index: number) => boolean;
}

export interface RawMatch {
  path: string;
  line: number;
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
}

const MAX_FILE_BYTES = 1_000_000;
const RG_BATCH = 300;
const RG_TIMEOUT_MS = 30_000;

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

// ---------------------------------------------------------------- built-in backend

const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\d*\})/;

function compileBuiltinRegex(query: string, caseSensitive: boolean): RegExp {
  if (query.length > 2000) throw new Error("Regex pattern is too long (limit 2000 characters).");
  if (NESTED_QUANTIFIER.test(query))
    throw new Error(
      "Regex rejected: nested quantifiers can cause catastrophic backtracking. Simplify the pattern, or install ripgrep (recommended), which searches in linear time.",
    );
  return new RegExp(query, caseSensitive ? "g" : "gi");
}

function firstAcceptedHit(
  line: string,
  request: SearchRequest,
  matcher: RegExp | undefined,
  needle: string,
): number {
  if (matcher) {
    matcher.lastIndex = 0;
    for (let hit = matcher.exec(line); hit !== null; hit = matcher.exec(line)) {
      if (!request.accept || request.accept(line, hit.index)) return hit.index;
      if (hit[0].length === 0) matcher.lastIndex += 1;
    }
    return -1;
  }
  const haystack = request.caseSensitive ? line : line.toLowerCase();
  for (let from = 0; ; ) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return -1;
    if (!request.accept || request.accept(line, index)) return index;
    from = index + 1;
  }
}

async function searchBuiltin(
  root: string,
  request: SearchRequest,
  files: string[],
  limit: number,
): Promise<RawMatch[]> {
  const matcher = request.regex
    ? compileBuiltinRegex(request.query, request.caseSensitive)
    : undefined;
  const needle = request.caseSensitive ? request.query : request.query.toLowerCase();
  const matches: RawMatch[] = [];
  const resolvedRoot = await fs.realpath(root);
  for (const [position, relative] of files.entries()) {
    if (position % 50 === 49) await new Promise((resolve) => setImmediate(resolve));
    let content: string;
    try {
      content = await fs.readFile(await safePath(resolvedRoot, relative), "utf8");
    } catch {
      continue;
    }
    if (content.includes("\0")) continue;
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const column = firstAcceptedHit(line, request, matcher, needle);
      if (column === -1) continue;
      matches.push({
        path: relative,
        line: index + 1,
        column: column + 1,
        raw: line,
        before: lines.slice(Math.max(0, index - request.context), index),
        after: lines.slice(index + 1, index + 1 + request.context),
      });
      if (matches.length >= limit) return matches;
    }
  }
  return matches;
}

// ---------------------------------------------------------------- ripgrep backend

class RipgrepFallback extends Error {}

interface RgText {
  text?: string;
  bytes?: string;
}

function rgText(value: RgText | undefined): string {
  if (!value) return "";
  if (value.text !== undefined) return value.text;
  return value.bytes ? Buffer.from(value.bytes, "base64").toString("utf8") : "";
}

interface RgFile {
  lines: Map<number, string>;
  hits: Array<{ line: number; column: number; raw: string }>;
}

function finishFile(relative: string, file: RgFile, request: SearchRequest): RawMatch[] {
  return file.hits.map((hit) => {
    const before: string[] = [];
    const after: string[] = [];
    for (let offset = request.context; offset >= 1; offset -= 1) {
      const text = file.lines.get(hit.line - offset);
      if (text !== undefined) before.push(text);
    }
    for (let offset = 1; offset <= request.context; offset += 1) {
      const text = file.lines.get(hit.line + offset);
      if (text !== undefined) after.push(text);
    }
    return { path: relative, line: hit.line, column: hit.column, raw: hit.raw, before, after };
  });
}

function runRipgrepBatch(
  root: string,
  request: SearchRequest,
  batch: string[],
  remaining: number,
  deadline: number,
): Promise<{ matches: RawMatch[]; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const args = [
      "--json",
      "--no-config",
      "--sort",
      "path",
      "--max-filesize",
      "1M",
      request.caseSensitive ? "-s" : "-i",
    ];
    if (!request.regex) args.push("-F");
    if (request.context > 0) args.push("-C", String(request.context));
    args.push("-e", request.query, "--", ...batch);

    const child: ChildProcess = spawn("rg", args, {
      cwd: root,
      shell: false,
      env: commandEnvironment(),
      ...processTreeSpawnOptions(),
    });
    const matches: RawMatch[] = [];
    let pending = "";
    let stderr = "";
    let current: { path: string; file: RgFile } | undefined;
    let stoppedEarly = false;
    let timedOut = false;
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ matches, timedOut });
    };
    const stop = (): void => {
      stoppedEarly = true;
      terminateProcessTree(child);
    };
    const timer = setTimeout(
      () => {
        timedOut = true;
        stop();
      },
      Math.max(1000, deadline - Date.now()),
    );

    const handle = (line: string): void => {
      if (!line || stoppedEarly) return;
      let event: { type: string; data: Record<string, unknown> };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        return;
      }
      const data = event.data as {
        path?: RgText;
        lines?: RgText;
        line_number?: number;
        binary_offset?: number | null;
        submatches?: Array<{ start: number }>;
      };
      if (event.type === "begin") {
        current = { path: rgText(data.path), file: { lines: new Map(), hits: [] } };
      } else if ((event.type === "match" || event.type === "context") && current) {
        const text = rgText(data.lines).replace(/\r?\n$/, "");
        const lineNumber = data.line_number ?? 0;
        current.file.lines.set(lineNumber, text);
        if (event.type === "match") {
          const bytes = Buffer.from(text);
          for (const submatch of data.submatches ?? []) {
            const index = bytes.subarray(0, submatch.start).toString("utf8").length;
            if (request.accept && !request.accept(text, index)) continue;
            current.file.hits.push({ line: lineNumber, column: index + 1, raw: text });
            break;
          }
        }
      } else if (event.type === "end" && current) {
        // Binary files are skipped wholesale so both backends agree.
        if (data.binary_offset === undefined || data.binary_offset === null) {
          matches.push(...finishFile(current.path, current.file, request));
        }
        current = undefined;
        if (matches.length >= remaining) stop();
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        handle(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(new RipgrepFallback(error.message)));
    child.on("close", (code) => {
      if (pending) handle(pending);
      if (
        !stoppedEarly &&
        code === 2 &&
        /regex parse error|error parsing|regex|unrecognized/i.test(stderr)
      )
        finish(new RipgrepFallback(stderr.trim().split("\n")[0] ?? "ripgrep rejected the pattern"));
      else finish();
    });
  });
}

async function searchRipgrep(
  root: string,
  request: SearchRequest,
  files: string[],
  limit: number,
): Promise<{ matches: RawMatch[]; timedOut: boolean }> {
  const deadline = Date.now() + RG_TIMEOUT_MS;
  const matches: RawMatch[] = [];
  let timedOut = false;
  for (let start = 0; start < files.length && matches.length < limit; start += RG_BATCH) {
    const batch = files.slice(start, start + RG_BATCH);
    const result = await runRipgrepBatch(root, request, batch, limit - matches.length, deadline);
    matches.push(...result.matches);
    if (result.timedOut) {
      timedOut = true;
      break;
    }
  }
  return { matches: matches.slice(0, limit), timedOut };
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
  };
}
