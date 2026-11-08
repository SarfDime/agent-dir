import type { CodeGraphIntegration } from "../../codegraph.js";
import { outputBytesArg } from "./arguments.js";
import { truncateText } from "./text.js";
import type { ToolCallOutput } from "./types.js";

function boundCodeGraphResult(
  value: Record<string, unknown>,
  maxBytes: number,
): Record<string, unknown> {
  const originalBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (originalBytes <= maxBytes) return value;

  const trim = (item: unknown, budget: number): unknown => {
    if (typeof item === "string") return truncateText(item, Math.max(0, budget - 24)).text;
    if (Array.isArray(item)) {
      const output: unknown[] = [];
      for (const entry of item) {
        const candidate = [
          ...output,
          trim(entry, Math.max(128, Math.floor(budget / Math.max(1, item.length)))),
        ];
        if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > budget) break;
        output.push(candidate[candidate.length - 1]);
      }
      return output;
    }
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      const output: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(item)) {
        const remaining =
          budget - Buffer.byteLength(JSON.stringify(output), "utf8") - key.length - 8;
        if (remaining < 64) break;
        output[key] = trim(
          entry,
          Math.min(
            remaining,
            Math.max(128, Math.floor(budget / Math.max(1, Object.keys(item).length))),
          ),
        );
        if (Buffer.byteLength(JSON.stringify(output), "utf8") > budget) {
          delete output[key];
          break;
        }
      }
      return output;
    }
    return item;
  };

  const result = trim(value, Math.max(256, maxBytes - 256)) as Record<string, unknown>;
  const bounded: Record<string, unknown> = {
    ...result,
    truncated: true,
    originalBytes,
    budgetBytes: maxBytes,
    message:
      "CodeGraph output was trimmed to fit maxBytes. Narrow the query or lower maxFiles for more complete results.",
  };
  if (Buffer.byteLength(JSON.stringify(bounded), "utf8") <= maxBytes) return bounded;
  return {
    truncated: true,
    originalBytes,
    budgetBytes: maxBytes,
    message: "CodeGraph output exceeded maxBytes. Narrow the query or lower maxFiles.",
  };
}

export async function handleCodeGraphExplore(
  args: Record<string, unknown>,
  codeGraph: CodeGraphIntegration | undefined,
): Promise<ToolCallOutput> {
  if (!codeGraph) throw new Error("CodeGraph integration is unavailable.");
  if (typeof args.query !== "string" || args.query.trim().length === 0)
    throw new Error("query must be a non-empty string.");
  if (
    args.maxFiles !== undefined &&
    (!Number.isInteger(args.maxFiles) || Number(args.maxFiles) < 1 || Number(args.maxFiles) > 100)
  )
    throw new Error("maxFiles must be an integer between 1 and 100.");
  const maxBytes = outputBytesArg(args.maxBytes);
  const result = await codeGraph.explore(
    args.query,
    args.maxFiles === undefined ? 10 : Number(args.maxFiles),
  );
  return { payload: boundCodeGraphResult(result, maxBytes) };
}
