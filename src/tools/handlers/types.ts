export interface ToolCallOutput {
  payload: Record<string, unknown>;
  text?: string;
}

export interface ToolRequestContext {
  sessionKey: string;
  signal?: AbortSignal;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  request: ToolRequestContext,
) => Promise<ToolCallOutput>;
