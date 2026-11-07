import type { ToolFailure } from "../failure.js";

export interface ToolCallOutput {
  payload: Record<string, unknown>;
  text?: string;
  failure?: ToolFailure;
}

export interface ToolRequestContext {
  sessionKey: string;
  signal?: AbortSignal;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  request: ToolRequestContext,
) => Promise<ToolCallOutput>;
