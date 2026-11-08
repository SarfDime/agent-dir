import { fileInfo } from "../metadata.js";
import type { ToolCallOutput } from "./types.js";

export async function handleFileInfo(
  args: Record<string, unknown>,
  root: string,
): Promise<ToolCallOutput> {
  return { payload: await fileInfo(root, String(args.path)) };
}
