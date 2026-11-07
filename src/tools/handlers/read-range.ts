import type { ReadRangeHistory } from "../read.js";
import {
  formatRangeText,
  type ReadRangeResult,
  type ReadRangeSelection,
  readRange,
} from "../read.js";
import { objectArray, outputBytesArg, READ_RANGE_DEFAULT_BYTES } from "./arguments.js";
import type { ToolCallOutput } from "./types.js";

export async function handleReadRange(
  args: Record<string, unknown>,
  root: string,
  readHistory: ReadRangeHistory,
): Promise<ToolCallOutput> {
  const maxBytes = outputBytesArg(args.maxBytes, READ_RANGE_DEFAULT_BYTES);
  const filePath = String(args.path);
  const requestedRanges: ReadRangeSelection[] =
    args.ranges === undefined
      ? [{ startLine: Number(args.startLine), endLine: Number(args.endLine) }]
      : objectArray(args.ranges, "ranges").map((range) => ({
          startLine: Number(range.startLine),
          endLine: Number(range.endLine),
        }));
  const observation = await readHistory.inspect(root, filePath, requestedRanges);
  const skipRepeated = args.skipIfUnchanged === true && observation?.repeatedUnchanged === true;
  const note = skipRepeated
    ? "Unchanged range content omitted because skipIfUnchanged is true."
    : observation?.overlapsPrevious
      ? "This read overlaps lines already read in this session."
      : undefined;
  let completedRanges: ReadRangeSelection[] = [];
  let readCompleted = false;
  let payload: Record<string, unknown>;
  let text: string;
  if (args.ranges !== undefined) {
    const ranges = objectArray(args.ranges, "ranges");
    if (ranges.length === 0 || ranges.length > 10)
      throw new Error("ranges must contain 1 to 10 items.");
    const results: ReadRangeResult[] = [];
    let remaining = maxBytes - 256;
    for (const [index, range] of ranges.entries()) {
      const share = Math.max(256, Math.floor(remaining / (ranges.length - index)));
      const result = await readRange(
        root,
        filePath,
        Number(range.startLine),
        Number(range.endLine),
        share,
      );
      results.push(result);
      remaining -= Buffer.byteLength(result.content, "utf8") + 200;
    }
    completedRanges = results
      .filter((result) => result.endLine >= result.startLine)
      .map(({ startLine, endLine }) => ({ startLine, endLine }));
    readCompleted = results.every((result) => !result.truncated);
    const outputResults = skipRepeated
      ? results.map((result) => ({ ...result, content: "", skipped: true as const }))
      : results;
    payload = {
      items: outputResults,
      truncated: results.some((item) => item.truncated),
      ...(skipRepeated ? { skipped: true } : {}),
      ...(note ? { note } : {}),
    };
    text = [outputResults.map(formatRangeText).join("\n\n"), ...(note ? [`[note: ${note}]`] : [])]
      .filter(Boolean)
      .join("\n\n");
  } else {
    if (args.startLine === undefined || args.endLine === undefined)
      throw new Error("startLine and endLine are required unless ranges is provided.");
    const readResult = await readRange(
      root,
      filePath,
      Number(args.startLine),
      Number(args.endLine),
      Math.max(1, maxBytes - 256),
    );
    if (readResult.endLine >= readResult.startLine)
      completedRanges = [{ startLine: readResult.startLine, endLine: readResult.endLine }];
    readCompleted = !readResult.truncated;
    const result = skipRepeated
      ? { ...readResult, content: "", skipped: true as const }
      : readResult;
    payload = {
      ...result,
      ...(skipRepeated ? { skipped: true } : {}),
      ...(note ? { note } : {}),
    };
    text = [formatRangeText(result), ...(note ? [`[note: ${note}]`] : [])].join("\n");
  }
  readHistory.record(observation, completedRanges, readCompleted);
  return { payload, text };
}
