import { isRecord } from "./validation.js";
import { packageVersion } from "./version.js";

export const SERVER_INFO = { name: "agent-dir", version: packageVersion };
export const SERVER_INFO_META = { "io.modelcontextprotocol/serverInfo": SERVER_INFO };
export const SUBSCRIPTION_ID_META = "io.modelcontextprotocol/subscriptionId";
const PAGE_SIZE = 50;

export interface Subscription {
  id: string | number | null | undefined;
  controller: ReadableStreamDefaultController<Uint8Array>;
  notifications: {
    toolsListChanged: boolean;
    promptsListChanged: boolean;
    resourcesListChanged: boolean;
    resourceSubscriptions: Set<string>;
  };
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}
export function isValidRequestId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}
export function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  status: number,
  data?: unknown,
): Response {
  return json(
    { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } },
    status,
  );
}
export function paginate<T>(
  items: T[],
  cursorValue: unknown,
): {
  items: T[];
  nextCursor?: string;
} {
  const offset = decodeCursor(cursorValue);
  const page = items.slice(offset, offset + PAGE_SIZE);
  const nextOffset = offset + page.length;
  return nextOffset < items.length
    ? { items: page, nextCursor: encodeCursor(nextOffset) }
    : { items: page };
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function decodeCursor(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "string" || value.length > 128)
    throw new Error("Invalid pagination cursor.");
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64url").toString("utf8");
  } catch {
    throw new Error("Invalid pagination cursor.");
  }
  if (!/^(?:0|[1-9]\d*)$/.test(decoded)) throw new Error("Invalid pagination cursor.");
  const offset = Number(decoded);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid pagination cursor.");
  return offset;
}

export function subscriptionNotifications(value: unknown): Subscription["notifications"] {
  if (!isRecord(value)) throw new Error("subscriptions/listen notifications are required.");
  for (const key of ["toolsListChanged", "promptsListChanged", "resourcesListChanged"]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean")
      throw new Error(`subscriptions/listen ${key} must be a boolean.`);
  }
  if (
    value.resourceSubscriptions !== undefined &&
    (!Array.isArray(value.resourceSubscriptions) ||
      value.resourceSubscriptions.some((uri) => typeof uri !== "string" || uri.length === 0))
  )
    throw new Error(
      "subscriptions/listen resourceSubscriptions must be an array of non-empty strings.",
    );

  const resourceSubscriptions =
    value.resourceSubscriptions === undefined ? [] : (value.resourceSubscriptions as string[]);
  return {
    toolsListChanged: value.toolsListChanged === true,
    promptsListChanged: value.promptsListChanged === true,
    resourcesListChanged: value.resourcesListChanged === true,
    resourceSubscriptions: new Set(resourceSubscriptions),
  };
}

export function subscriptionResponse(
  id: string | number | null | undefined,
  notifications: Subscription["notifications"],
  subscriptions: Set<Subscription>,
): Response {
  let subscription: Subscription | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const honored = {
        toolsListChanged: notifications.toolsListChanged,
        promptsListChanged: notifications.promptsListChanged,
        resourcesListChanged: notifications.resourcesListChanged,
        resourceSubscriptions: notifications.resourceSubscriptions,
      };
      subscription = { id, controller, notifications: honored };
      subscriptions.add(subscription);
      writeSse(controller, {
        jsonrpc: "2.0",
        method: "notifications/subscriptions/acknowledged",
        params: {
          notifications: {
            ...(honored.toolsListChanged ? { toolsListChanged: true } : {}),
            ...(honored.promptsListChanged ? { promptsListChanged: true } : {}),
            ...(honored.resourcesListChanged ? { resourcesListChanged: true } : {}),
            ...(honored.resourceSubscriptions.size
              ? { resourceSubscriptions: [...honored.resourceSubscriptions] }
              : {}),
          },
        },
        _meta: { ...SERVER_INFO_META, [SUBSCRIPTION_ID_META]: id },
      });
    },
    cancel() {
      if (subscription) subscriptions.delete(subscription);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

export function writeSse(
  controller: ReadableStreamDefaultController<Uint8Array>,
  message: unknown,
): void {
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(message)}\n\n`));
}

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
