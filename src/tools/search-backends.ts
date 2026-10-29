import { type ChildProcess, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { commandEnvironment, processTreeSpawnOptions, terminateProcessTree } from "./commands.js";
import { safePath } from "./files.js";
import type { RawMatch, SearchRequest } from "./search.js";

const RG_BATCH = 300;
const RG_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------- built-in backend

const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\d*\})/;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileBuiltinRegex(request: SearchRequest): RegExp {
  const source = request.regex ? request.query : escapeRegex(request.query);
  if (source.length > 2000) throw new Error("Regex pattern is too long (limit 2000 characters).");
  if (request.regex && NESTED_QUANTIFIER.test(source))
    throw new Error(
      "Regex rejected: nested quantifiers can cause catastrophic backtracking. Simplify the pattern, or install ripgrep (recommended), which searches in linear time.",
    );
  const flags = `g${request.caseSensitive ? "" : "i"}${request.multiline ? "ms" : ""}`;
  return new RegExp(source, flags);
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

function lineIndexOf(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Matches that may span lines. Overlapping matches are merged into the first, like ripgrep. */
function multilineMatches(
  relative: string,
  content: string,
  request: SearchRequest,
  matcher: RegExp,
  limit: number,
): RawMatch[] {
  const text = content.replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const starts: number[] = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  const matches: RawMatch[] = [];
  let lastEndLine = 0;
  matcher.lastIndex = 0;
  for (let hit = matcher.exec(text); hit !== null; hit = matcher.exec(text)) {
    if (hit[0].length === 0) {
      matcher.lastIndex += 1;
      continue;
    }
    const startIndex = lineIndexOf(starts, hit.index);
    const endIndex = lineIndexOf(starts, hit.index + hit[0].length - 1);
    const startLine = startIndex + 1;
    if (startLine <= lastEndLine) continue;
    const column = hit.index - (starts[startIndex] ?? 0);
    if (request.accept && !request.accept(lines[startIndex] ?? "", column)) continue;
    const endLine = Math.min(endIndex + 1, lines.length);
    matches.push({
      path: relative,
      line: startLine,
      endLine,
      column: column + 1,
      raw: lines.slice(startIndex, endLine).join("\n"),
      before: lines.slice(Math.max(0, startIndex - request.context), startIndex),
      after: lines.slice(endLine, endLine + request.context),
    });
    lastEndLine = endLine;
    if (matches.length >= limit) break;
  }
  return matches;
}

export async function searchBuiltin(
  root: string,
  request: SearchRequest,
  files: string[],
  limit: number,
): Promise<RawMatch[]> {
  const needsRegex = request.regex || request.multiline === true;
  const matcher = needsRegex ? compileBuiltinRegex(request) : undefined;
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
    if (request.multiline && matcher) {
      matches.push(
        ...multilineMatches(relative, content, request, matcher, limit - matches.length),
      );
      if (matches.length >= limit) return matches;
      continue;
    }
    const lines = content.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const column = firstAcceptedHit(line, request, matcher, needle);
      if (column === -1) continue;
      matches.push({
        path: relative,
        line: index + 1,
        endLine: index + 1,
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

export class RipgrepFallback extends Error {}

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
  hits: Array<{ line: number; endLine: number; column: number; raw: string }>;
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
      const text = file.lines.get(hit.endLine + offset);
      if (text !== undefined) after.push(text);
    }
    return {
      path: relative,
      line: hit.line,
      endLine: hit.endLine,
      column: hit.column,
      raw: hit.raw,
      before,
      after,
    };
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
    if (request.multiline) args.push("-U", ...(request.regex ? ["--multiline-dotall"] : []));
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
    let lastEndLine = 0;

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
        lastEndLine = 0;
      } else if ((event.type === "match" || event.type === "context") && current) {
        const block = rgText(data.lines).replace(/\r?\n$/, "");
        const blockLines = block.split(/\r?\n/);
        const lineNumber = data.line_number ?? 0;
        blockLines.forEach((text, offset) => {
          current?.file.lines.set(lineNumber + offset, text);
        });
        if (event.type === "match" && lineNumber > lastEndLine) {
          const first = blockLines[0] ?? "";
          const submatch = (data.submatches ?? [])[0];
          const index = submatch
            ? Buffer.from(block).subarray(0, submatch.start).toString("utf8").length
            : 0;
          const accepted =
            !request.accept ||
            (data.submatches ?? []).some((candidate) =>
              request.accept?.(
                first,
                Buffer.from(block).subarray(0, candidate.start).toString("utf8").length,
              ),
            );
          if (accepted) {
            const endLine = lineNumber + blockLines.length - 1;
            current.file.hits.push({
              line: lineNumber,
              endLine,
              column: index + 1,
              raw: block,
            });
            lastEndLine = endLine;
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
      if (!stoppedEarly && code === 2 && /regex|literal|unrecognized|multiline/i.test(stderr))
        finish(new RipgrepFallback(stderr.trim().split("\n")[0] ?? "ripgrep rejected the pattern"));
      else finish();
    });
  });
}

export async function searchRipgrep(
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
