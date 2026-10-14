import { type ChildProcess, spawn } from "node:child_process";

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
        !/(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTHORIZATION|ACCESS[_-]?KEY)/i.test(
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

export function isCommandBlacklisted(
  command: string,
  args: string[] = [],
  blacklistedCommands: string[] = [],
): boolean {
  const invocation = [command, ...args];
  return blacklistedCommands.some((entry) => {
    const tokens = entry.trim().split(/\s+/).filter(Boolean);
    return tokens.length > 0 && tokens.every((token, index) => invocation[index] === token);
  });
}

export function runCommand(
  root: string,
  command: string,
  args: string[] = [],
  allowedCommands: string[] = [],
  blacklistedCommands: string[] = [],
  timeoutMs = 120000,
  signal?: AbortSignal,
): Promise<CommandResult> {
  if (!SAFE_NAME.test(command)) throw new Error("Invalid command name.");
  if (!allowedCommands.includes(command))
    throw new Error(`Command '${command}' is not allowed by this profile.`);
  if (isCommandBlacklisted(command, args, blacklistedCommands))
    throw new Error(`Command '${[command, ...args].join(" ")}' is blocked by this profile.`);
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
    throw new Error("Command arguments must be strings.");

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      shell: false,
      env: commandEnvironment(),
      ...processTreeSpawnOptions(),
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    let timer: ReturnType<typeof setTimeout>;
    const abort = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      terminateProcessTree(child);
      reject(new Error(`Command '${command}' was aborted.`));
    };
    timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      terminateProcessTree(child);
      signal?.removeEventListener("abort", abort);
      reject(new Error(`Command '${command}' timed out after ${timeoutMs}ms.`));
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
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve({ command: [command, ...args].join(" "), exitCode: code ?? 1, stdout, stderr });
    });
  });
}
