import { findFiles } from "../code.js";
import { numberArg, outputBytesArg } from "./arguments.js";
import type { ToolCallOutput } from "./types.js";

function boundedItems<T>(items: T[], maxBytes: number): { items: T[]; truncated: boolean } {
  const selected: T[] = [];
  let bytes = 2;
  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    const separatorBytes = selected.length ? 1 : 0;
    if (selected.length && bytes + separatorBytes + itemBytes > maxBytes) break;
    if (!selected.length && bytes + itemBytes > maxBytes) break;
    selected.push(item);
    bytes += separatorBytes + itemBytes;
  }
  return { items: selected, truncated: selected.length < items.length };
}

export async function handleFindFiles(
  args: Record<string, unknown>,
  root: string,
): Promise<ToolCallOutput> {
  const maxResults = numberArg(args.maxResults, 200, 1000);
  const found = await findFiles(root, String(args.pattern), maxResults);
  const bounded = boundedItems(found.files, Math.max(2, outputBytesArg(args.maxBytes) - 256));
  const note = bounded.truncated
    ? found.truncated
      ? `Output byte limit reached after ${bounded.items.length} results; at least ${found.files.length} files matched and maxResults also limits the listing. Increase maxBytes and/or maxResults.`
      : `Output byte limit reached; showing ${bounded.items.length} of ${found.files.length} matching files. Increase maxBytes.`
    : found.note;
  return {
    payload: {
      items: bounded.items,
      truncated: bounded.truncated || found.truncated,
      ...(note ? { note } : {}),
    },
  };
}
