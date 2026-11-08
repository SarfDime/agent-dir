import { readFileSync } from "node:fs";
import { hostname, release, userInfo } from "node:os";
import type { CodeGraphIntegration } from "./codegraph.js";
import { telemetryHmac } from "./telemetry/fingerprint.js";
import type {
  TelemetryLevel,
  TelemetryProjectContext,
  TelemetryRuntimeContext,
  TelemetryToolEvent,
} from "./telemetry/types.js";
import { projectOverview } from "./tools/metadata.js";
import { isRecord } from "./validation.js";
import { packageVersion } from "./version.js";

export type TelemetryRuntime = TelemetryRuntimeContext;
let cachedStaticRuntime: TelemetryRuntime | undefined;

/** Identity a client reports about itself; carried across its own requests, never shared. */
interface ClientIdentity {
  name?: string;
  version?: string;
}

/** Key used when a request carries no `Mcp-Session-Id` header. */
export const UNIDENTIFIED_SESSION = "unidentified";

/** Fields that never change during the process lifetime are collected once. */
export function staticTelemetryRuntime(): TelemetryRuntime {
  cachedStaticRuntime ??= {
    agentDirVersion: packageVersion,
    nodeMajor: Number(process.versions.node.split(".")[0]),
    os:
      process.platform === "darwin"
        ? "macos"
        : process.platform === "linux"
          ? "linux"
          : process.platform === "win32"
            ? "windows"
            : "other",
    arch: process.arch,
    nodeVersion: process.versions.node,
    ...linuxDistribution(),
    kernelVersion: release(),
    hostname: hostname(),
    username: userInfo().username,
  };
  return cachedStaticRuntime;
}

/**
 * Client identities seen by one handler. Clients that send a `Mcp-Session-Id` are tracked
 * separately; a client that never sends one is tracked once, because a
 * request without an identity cannot be attributed to a session at all. The identity is only used
 * when the request itself carries no `clientInfo`, so a client that identifies every request is
 * always attributed to itself.
 */
interface ClientRegistry {
  bySession: Map<string, ClientIdentity>;
  withoutSession?: ClientIdentity;
}

const MAX_TRACKED_CLIENT_SESSIONS = 32;
export const MAX_TRACKED_READ_SESSIONS = 32;

export function createClientRegistry(): ClientRegistry {
  return { bySession: new Map() };
}

function rememberClient(
  registry: ClientRegistry,
  sessionKey: string,
  identity: ClientIdentity,
): void {
  if (sessionKey === UNIDENTIFIED_SESSION) {
    registry.withoutSession = identity;
    return;
  }
  registry.bySession.delete(sessionKey);
  registry.bySession.set(sessionKey, identity);
  while (registry.bySession.size > MAX_TRACKED_CLIENT_SESSIONS) {
    const oldest = registry.bySession.keys().next().value;
    if (oldest === undefined) break;
    registry.bySession.delete(oldest);
  }
}

function lookupClient(registry: ClientRegistry, sessionKey: string): ClientIdentity | undefined {
  return sessionKey === UNIDENTIFIED_SESSION
    ? registry.withoutSession
    : registry.bySession.get(sessionKey);
}

export function telemetryRuntime(
  params: Record<string, unknown>,
  level: TelemetryLevel,
  headerProtocolVersion?: string | null,
  clientContext?: { sessionKey: string; registry: ClientRegistry },
): TelemetryRuntime {
  const meta = isRecord(params._meta) ? params._meta : undefined;
  const metaClient = meta?.["io.modelcontextprotocol/clientInfo"];
  const reportedClient = isRecord(params.clientInfo)
    ? params.clientInfo
    : isRecord(metaClient)
      ? metaClient
      : undefined;
  const reportedIdentity: ClientIdentity = {
    ...(typeof reportedClient?.name === "string" ? { name: reportedClient.name } : {}),
    ...(typeof reportedClient?.version === "string" ? { version: reportedClient.version } : {}),
  };
  if (
    clientContext &&
    (reportedIdentity.name !== undefined || reportedIdentity.version !== undefined)
  )
    rememberClient(clientContext.registry, clientContext.sessionKey, reportedIdentity);
  // Prefer what this request said; otherwise use what the same session said earlier.
  const clientInfo =
    reportedIdentity.name !== undefined || reportedIdentity.version !== undefined
      ? reportedIdentity
      : clientContext
        ? lookupClient(clientContext.registry, clientContext.sessionKey)
        : undefined;
  const metaVersion = meta?.["io.modelcontextprotocol/protocolVersion"];
  const protocolVersion =
    typeof params.protocolVersion === "string"
      ? params.protocolVersion
      : typeof metaVersion === "string"
        ? metaVersion
        : (headerProtocolVersion ?? undefined);
  return {
    ...staticTelemetryRuntime(),
    ...(typeof clientInfo?.name === "string" ? { mcpClientName: clientInfo.name } : {}),
    ...(typeof clientInfo?.version === "string" ? { mcpClientVersion: clientInfo.version } : {}),
    ...(protocolVersion ? { mcpProtocolVersion: protocolVersion } : {}),
    ...(level === "none"
      ? {}
      : {
          processId: process.pid,
          parentProcessId: process.ppid,
          processUptimeMs: Math.round(process.uptime() * 1000),
          memoryRssBytes: process.memoryUsage().rss,
        }),
  };
}

function linuxDistribution(): { distroId?: string; distroName?: string; distroVersion?: string } {
  if (process.platform !== "linux") return {};
  try {
    const values = Object.fromEntries(
      readFileSync("/etc/os-release", "utf8")
        .split("\n")
        .map((line) => line.match(/^([A-Z_]+)=(.*)$/))
        .filter((match): match is RegExpMatchArray => match !== null)
        .map((match) => [match[1], match[2]?.replace(/^"|"$/g, "")]),
    );
    return {
      ...(values.ID ? { distroId: values.ID } : {}),
      ...(values.PRETTY_NAME ? { distroName: values.PRETTY_NAME } : {}),
      ...(values.VERSION_ID ? { distroVersion: values.VERSION_ID } : {}),
    };
  } catch {
    return {};
  }
}

export function telemetryHash(value: string): string {
  return telemetryHmac(value);
}

// A rough byte-based proxy, not a model-tokenizer count or Claude billing measurement.
export function estimateTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, "utf8") / 4);
}

export function toolTelemetryMetrics(
  toolName: string,
  payload: Record<string, unknown>,
  seenOutputFingerprints: Set<string>,
): {
  affectedFiles?: number;
  truncated?: boolean;
  paginated?: boolean;
  outputFingerprint?: string;
  duplicateOutputBytes?: number;
  textOutputBytes?: number;
  uniqueFileCount?: number;
  files?: Array<{ pathHash: string; contentHash?: string; bytes: number }>;
} {
  const paths = new Set<string>();
  const files = new Map<string, { pathHash: string; contentHash?: string; bytes: number }>();
  let truncated = false;
  let paginated = false;
  let textOutputBytes = 0;
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      textOutputBytes += Buffer.byteLength(value, "utf8");
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!isRecord(value)) return;
    if (typeof value.path === "string") {
      paths.add(value.path);
      const content = typeof value.content === "string" ? value.content : undefined;
      files.set(value.path, {
        pathHash: telemetryHash(value.path),
        ...(content === undefined ? {} : { contentHash: telemetryHash(content) }),
        bytes: content === undefined ? 0 : Buffer.byteLength(content, "utf8"),
      });
    }
    if (value.truncated === true) truncated = true;
    if (value.nextCursor !== undefined) paginated = true;
    for (const child of Object.values(value)) visit(child);
  };
  visit(payload);
  if (payload.truncated === true) truncated = true;
  const skipped = Array.isArray(payload.items)
    ? payload.items.filter((item) => isRecord(item) && item.status === "skipped").length
    : 0;
  const outputJson = JSON.stringify(payload);
  const outputFingerprint = telemetryHash(outputJson);
  const outputBytes = Buffer.byteLength(outputJson, "utf8");
  const duplicateOutputBytes = seenOutputFingerprints.has(outputFingerprint) ? outputBytes : 0;
  seenOutputFingerprints.add(outputFingerprint);
  return {
    ...(paths.size > 0 && /^(write|patch|delete|read|file)/.test(toolName)
      ? { affectedFiles: paths.size }
      : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(paginated ? { paginated: true } : {}),
    ...(skipped > 0 ? { skippedCount: skipped } : {}),
    outputFingerprint,
    duplicateOutputBytes,
    textOutputBytes,
    uniqueFileCount: files.size,
    ...(files.size ? { files: [...files.values()].slice(0, 100) } : {}),
  };
}

/**
 * Booleans describing which optional arguments were supplied. Values are never recorded, so this
 * is safe at every level and sufficient to see whether guidance changes how agents call tools.
 */
export function argumentShape(argumentsValue: unknown): {
  argShape?: NonNullable<TelemetryToolEvent["argShape"]>;
} {
  if (!isRecord(argumentsValue)) return {};
  const present = (key: string): boolean =>
    argumentsValue[key] !== undefined && argumentsValue[key] !== null;
  const nonEmpty = (key: string): boolean => {
    const value = argumentsValue[key];
    return Array.isArray(value) ? value.length > 0 : present(key);
  };
  const shape: NonNullable<TelemetryToolEvent["argShape"]> = {
    ...(argumentsValue.regex === true ? { regex: true } : {}),
    ...(argumentsValue.caseSensitive === true ? { caseSensitive: true } : {}),
    ...(nonEmpty("paths") ? { paths: true } : {}),
    ...(nonEmpty("globs") ? { globs: true } : {}),
    ...(typeof argumentsValue.context === "number" && argumentsValue.context > 0
      ? { context: true }
      : {}),
    ...(argumentsValue.multiline === true ? { multiline: true } : {}),
    ...(nonEmpty("ranges") ? { ranges: true } : {}),
    ...(nonEmpty("queries") ? { queries: true } : {}),
    ...(argumentsValue.dryRun === true ? { dryRun: true } : {}),
    ...(argumentsValue.skipIfUnchanged === true ? { skipIfUnchanged: true } : {}),
    ...(present("okExitCodes") ? { okExitCodes: true } : {}),
    ...(present("maxResults") || present("limit") ? { limit: true } : {}),
  };
  return Object.keys(shape).length ? { argShape: shape } : {};
}

/**
 * Total lines a `read_range` call asked for, summed over ranges. Line counts carry no content, so
 * they are safe to record and they are the only way to tell whether reads are too big or merely
 * too frequent.
 */
export function readSpan(argumentsValue: unknown): number {
  if (!isRecord(argumentsValue)) return 0;
  const span = (start: unknown, end: unknown): number => {
    const from = Number(start);
    const to = Number(end);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
    return Math.max(0, Math.min(1_000_000, Math.floor(to) - Math.floor(from) + 1));
  };
  if (Array.isArray(argumentsValue.ranges))
    return argumentsValue.ranges.reduce<number>(
      (total, range) => total + (isRecord(range) ? span(range.startLine, range.endLine) : 0),
      0,
    );
  return span(argumentsValue.startLine, argumentsValue.endLine);
}

export function toolOutcome(
  count: number | undefined,
  truncated: boolean,
): "ok" | "empty" | "truncated" | "error" {
  if (truncated) return "truncated";
  if (count === 0) return "empty";
  return "ok";
}

export function commandExecutables(
  toolName: string,
  argumentsValue: unknown,
): { executables?: string[] } {
  if (toolName !== "run_command_batch" || !isRecord(argumentsValue)) return {};
  if (!Array.isArray(argumentsValue.commands)) return {};
  const names = argumentsValue.commands.flatMap((item) =>
    isRecord(item) && typeof item.command === "string" ? [item.command] : [],
  );
  return names.length > 0 ? { executables: names.slice(0, 10) } : {};
}

export function commandTelemetryDescriptor(
  toolName: string,
): { family: string; operation: string } | undefined {
  if (toolName === "run_package_scripts_batch")
    return { family: "package-scripts", operation: "batch" };
  if (toolName === "run_command_batch") return { family: "command", operation: "batch" };
  return undefined;
}

export async function buildTelemetryProjectContext(
  root: string,
  codeGraph: CodeGraphIntegration,
): Promise<TelemetryProjectContext> {
  const overview = await projectOverview(root);
  const extension = overview.languages[0]?.extension;
  const language =
    extension === ".ts" || extension === ".tsx"
      ? "typescript"
      : extension === ".js" || extension === ".jsx"
        ? "javascript"
        : extension === ".py"
          ? "python"
          : extension === ".go"
            ? "go"
            : extension === ".rs"
              ? "rust"
              : extension === ".java"
                ? "java"
                : undefined;
  const packageManager = overview.packageManagers[0];
  const projectSize = overview.files < 100 ? "small" : overview.files < 1000 ? "medium" : "large";
  const capability = await codeGraph.capability();
  return {
    projectRoot: root,
    workingDirectory: process.cwd(),
    ...(language ? { language } : {}),
    ...(packageManager && ["npm", "pnpm", "yarn", "bun"].includes(packageManager)
      ? { packageManager: packageManager as "npm" | "pnpm" | "yarn" | "bun" }
      : {}),
    hasGit: overview.git.available,
    hasCodegraph: capability.installed && capability.indexed,
    projectSize,
  };
}

export function resultCount(payload: Record<string, unknown>): number | undefined {
  if (Array.isArray(payload.items)) return payload.items.length;
  if (
    typeof payload.returned === "number" &&
    Number.isSafeInteger(payload.returned) &&
    payload.returned >= 0
  )
    return payload.returned;
  return undefined;
}
