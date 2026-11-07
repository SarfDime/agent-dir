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
  const bounded = boundedItems(found.files, outputBytesArg(args.maxBytes));
  return {
    payload: {
      items: bounded.items,
      truncated: bounded.truncated || found.truncated,
      ...(found.note && !bounded.truncated ? { note: found.note } : {}),
    },
  };
}
