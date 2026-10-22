import { type ChildProcess, spawn } from "node:child_process";
import {
  blacklistCandidates,
  type CommandPolicyConfig,
  evaluateCommandPolicy,
  matchesBlacklistEntry,
} from "./policy.js";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_CAPTURE_BYTES = 512_000;
const TRUNCATION_MARKER = "\n…[output truncated at 512 KB]";

export function appendBoundedOutput(current: string, chunk: Buffer | string): string {
  if (
    current.endsWith(TRUNCATION_MARKER) ||
    Buffer.byteLength(current, "utf8") >= MAX_CAPTURE_BYTES
  )
    return current;
  const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const available = MAX_CAPTURE_BYTES - Buffer.byteLength(current, "utf8");
  if (incoming.byteLength <= available) return current + incoming.toString("utf8");
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  const payloadBytes = Math.max(0, available - markerBytes);
  let payload = incoming.subarray(0, payloadBytes).toString("utf8");
  while (Buffer.byteLength(payload, "utf8") > payloadBytes) payload = payload.slice(0, -1);
  return current + payload + TRUNCATION_MARKER;
}

export function commandEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTHORIZATION|ACCESS[_-]?KEY|COOKIE|SESSION[_-]?(?:ID|KEY)|SSH_AUTH_SOCK|GPG_|KUBECONFIG|DATABASE_URL|REDIS_URL|MONGO(?:DB)?_(?:URI|URL)|_DSN$|CONNECTION[_-]?STRING)/i.test(
          key,
        ),
    ),
  );
}

const FORCE_KILL_DELAY_MS = 1_000;

export function terminateProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid || child.killed || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => child.kill("SIGKILL"));
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const forceTimer = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, FORCE_KILL_DELAY_MS);
  forceTimer.unref();
  child.once("close", () => clearTimeout(forceTimer));
}

export function processTreeSpawnOptions(): { detached: boolean } {
  return { detached: process.platform !== "win32" };
}

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Outcome of one captured process. Never rejects; failures are described by the flags. */
export interface CaptureResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** Spawn failure message (for example the executable does not exist). */
  error?: string;
  durationMs: number;
}

/**
 * The single process runner for commands and package scripts: no shell, filtered environment,
 * process-tree termination, bounded capture, and partial output preserved on timeout or abort.
 */
export function spawnCapture(
  root: string,
  executable: string,
  args: string[],
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CaptureResult> {
  const timeoutMs = options.timeoutMs ?? 120000;
  const signal = options.signal;
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: Omit<CaptureResult, "stdout" | "stderr" | "durationMs">): void => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve({ ...result, stdout, stderr, durationMs: Date.now() - startedAt });
    };
    const child = spawn(executable, args, {
      cwd: root,
      shell: false,
      env: commandEnvironment(),
      ...processTreeSpawnOptions(),
    });
    function abort(): void {
      if (finished) return;
      terminateProcessTree(child);
      finish({ exitCode: null, timedOut: false, aborted: true });
    }
    timer = setTimeout(() => {
      if (finished) return;
      terminateProcessTree(child);
      finish({ exitCode: null, timedOut: true, aborted: false });
    }, timeoutMs);
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = appendBoundedOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = appendBoundedOutput(stderr, chunk);
    });
    child.on("error", (error: Error) => {
      finish({ exitCode: null, timedOut: false, aborted: false, error: error.message });
    });
    child.on("close", (code: number | null) => {
      finish({ exitCode: code ?? 1, timedOut: false, aborted: false });
    });
  });
}

export function isCommandBlacklisted(
  command: string,
  args: string[] = [],
  blacklistedCommands: string[] = [],
): boolean {
  // Global options placed before a subcommand (`git -C . push`) must not bypass an entry.
  const candidates = blacklistCandidates(command, args);
  return blacklistedCommands.some((entry) =>
    candidates.some((invocation) => matchesBlacklistEntry(entry, invocation)),
  );
}

export interface CommandCheckContext {
  allowedCommands: string[];
  blacklistedCommands?: string[];
  allowedScripts?: string[];
  policy?: CommandPolicyConfig;
}

/** Validates one command against the profile; returns a denial reason or undefined. */
export function checkCommand(
  root: string,
  command: string,
  args: string[],
  context: CommandCheckContext,
): string | undefined {
  if (typeof command !== "string" || !SAFE_NAME.test(command)) return "Invalid command name.";
  if (!context.allowedCommands.includes(command))
    return `Command '${command}' is not allowed by this profile.`;
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
    return "Command arguments must be strings.";
  if (isCommandBlacklisted(command, args, context.blacklistedCommands ?? []))
    return `Command '${[command, ...args].join(" ")}' is blocked by this profile.`;
  return evaluateCommandPolicy(command, args, {
    root,
    ...(context.allowedScripts ? { allowedScripts: context.allowedScripts } : {}),
    ...(context.policy ? { policy: context.policy } : {}),
  });
}

export async function runCommand(
  root: string,
  command: string,
  args: string[] = [],
  allowedCommands: string[] = [],
  blacklistedCommands: string[] = [],
  timeoutMs = 120000,
  signal?: AbortSignal,
  context: Omit<CommandCheckContext, "allowedCommands" | "blacklistedCommands"> = {},
): Promise<CommandResult> {
  const problem = checkCommand(root, command, args, {
    allowedCommands,
    blacklistedCommands,
    ...context,
  });
  if (problem) throw new Error(problem);
  const capture = await spawnCapture(root, command, args, {
    timeoutMs,
    ...(signal ? { signal } : {}),
  });
  if (capture.aborted) throw new Error(`Command '${command}' was aborted.`);
  if (capture.timedOut) throw new Error(`Command '${command}' timed out after ${timeoutMs}ms.`);
  if (capture.error) throw new Error(capture.error);
  return {
    command: [command, ...args].join(" "),
    exitCode: capture.exitCode ?? 1,
    stdout: capture.stdout,
    stderr: capture.stderr,
  };
}
