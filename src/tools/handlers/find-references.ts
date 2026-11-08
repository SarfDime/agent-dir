import { findReferences } from "../code.js";
import { numberArg, outputBytesArg } from "./arguments.js";
import type { ToolCallOutput } from "./types.js";

export async function handleFindReferences(
  args: Record<string, unknown>,
  root: string,
): Promise<ToolCallOutput> {
  return {
    payload: {
      ...(await findReferences(root, String(args.symbol), {
        maxResults: numberArg(args.maxResults, 200, 1000),
        maxBytes: outputBytesArg(args.maxBytes),
      })),
    },
  };
}
