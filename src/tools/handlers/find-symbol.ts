import { findSymbol } from "../code.js";
import { numberArg, outputBytesArg } from "./arguments.js";
import type { ToolCallOutput } from "./types.js";

export async function handleFindSymbol(
  args: Record<string, unknown>,
  root: string,
): Promise<ToolCallOutput> {
  return {
    payload: {
      ...(await findSymbol(root, String(args.symbol), {
        maxResults: numberArg(args.maxResults, 100, 500),
        maxBytes: outputBytesArg(args.maxBytes),
      })),
    },
  };
}
