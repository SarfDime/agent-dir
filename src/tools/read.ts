import { promises as fs } from "node:fs";
import { closestPathHint, safePath, ToolFailure } from "./files.js";

const MAX_READ_FILE_BYTES = 20 * 1024 * 1024;
const MAX_RANGE_LINES = 2000;

export interface ReadRangeResult {
  path: string;
  startLine: number;
  /** Last line returned; `startLine - 1` when nothing was returned. */
  endLine: number;
  content: string;
  /** True when the requested range was cut short by the byte budget. */
  truncated: boolean;
  /** True when the last line of the file is included (or the range starts past it). */
  eof: boolean;
  totalLines: number;
  /** Where to continue reading; absent at the end of the file. */
  nextStartLine?: number;
}

function clipLine(line: string, maxBytes: number): string {
  const marker = "…[truncated]";
  let end = Math.max(0, line.length);
  while (end > 0 && Buffer.byteLength(line.slice(0, end) + marker, "utf8") > maxBytes) {
    end = Math.floor(end * 0.8);
  }
  return line.slice(0, end) + marker;
}

/** Reads a line range with EOF information and a continuation hint. */
export async function readRange(
  root: string,
  relativePath: string,
  startLine: number,
  endLine: number,
  maxBytes = 16_000,
): Promise<ReadRangeResult> {
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  )
    throw new Error("startLine and endLine must be integers with 1 <= startLine <= endLine.");
  if (endLine - startLine + 1 > MAX_RANGE_LINES)
    throw new ToolFailure(
      "range_too_large",
      `A range may contain at most ${MAX_RANGE_LINES} lines; request a smaller range.`,
    );
  let target: string;
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    target = await safePath(root, relativePath);
    stat = await fs.stat(target);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    throw new Error(
      `'${relativePath}' does not exist.${await closestPathHint(root, relativePath)}`,
    );
  }
  if (!stat.isFile()) throw new ToolFailure("not_a_file", `'${relativePath}' is not a file.`);
  if (stat.size > MAX_READ_FILE_BYTES)
    throw new ToolFailure(
      "file_too_large",
      `'${relativePath}' is larger than 20 MB; use search_code with paths and context instead.`,
    );
  const raw = await fs.readFile(target, "utf8");
  if (raw.includes("\0"))
    throw new ToolFailure("binary_file", `'${relativePath}' looks like a binary file.`);

  const lines = raw.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const totalLines = lines.length;
  if (startLine > totalLines) {
    return {
      path: relativePath,
      startLine,
      endLine: startLine - 1,
      content: "",
      truncated: false,
      eof: true,
      totalLines,
    };
  }

  const requested = lines.slice(startLine - 1, endLine);
  const returned: string[] = [];
  let used = 0;
  let clipped = false;
  for (const line of requested) {
    const bytes = Buffer.byteLength(line, "utf8") + (returned.length > 0 ? 1 : 0);
    if (used + bytes > maxBytes) {
      if (returned.length === 0) {
        returned.push(clipLine(line, maxBytes));
        clipped = true;
      }
      break;
    }
    returned.push(line);
    used += bytes;
  }
  const last = startLine + returned.length - 1;
  return {
    path: relativePath,
    startLine,
    endLine: last,
    content: returned.join("\n"),
    truncated: returned.length < requested.length || clipped,
    eof: last >= totalLines,
    totalLines,
    ...(last < totalLines ? { nextStartLine: last + 1 } : {}),
  };
}

/** Plain-text rendering used as the model-facing text block. */
export function formatRangeText(result: ReadRangeResult): string {
  const header = `${result.path} lines ${result.startLine}-${result.endLine} of ${result.totalLines}${
    result.eof ? " (end of file)" : ""
  }${result.truncated ? " (cut by byte budget)" : ""}`;
  const footer =
    result.nextStartLine === undefined ? "" : `\n[continue with startLine=${result.nextStartLine}]`;
  return `${header}\n${result.content}${footer}`;
}
