import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { TelemetryRecorder } from "./telemetry/recorder.js";
import type { TunnelEvent, TunnelOptions, TunnelResult } from "./types.js";

const STARTUP_TIMEOUT_MS = 15_000;
const HEALTH_INTERVAL_MS = 15_000;
const HEALTH_TIMEOUT_MS = 5_000;
const HEALTH_FAILURE_THRESHOLD = 2;
const RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_ATTEMPTS = 5;
const HEALTH_PATH = "/__health";
const ANSI_ESCAPE = new RegExp(String.fromCharCode(0x1b) + String.raw`\[[0-?]*[ -/]*[@-~]`, "g");

function cleanOutput(value: Buffer | string): string {
  return value.toString().replace(ANSI_ESCAPE, "");
}
function writeLine(line = ""): void {
  process.stdout.write(`${line}\r\n`);
}
function publicUrl(subdomain: string): string {
  return `https://${subdomain}.wormhole.bar`;
}
function reasonCategory(reason: string): string {
  if (/timeout/i.test(reason)) return "timeout";
  if (/auth/i.test(reason)) return "authentication";
  if (/registration|subdomain/i.test(reason)) return "startup";
  if (/exit|process|error/i.test(reason)) return "execution";
  return "unknown";
}

function failureFromLine(line: string): string | undefined {
  if (/subdomain limit reached/i.test(line))
    return "Wormhole rejected the tunnel: subdomain limit reached.";
  const registration = line.match(/registration failed:\s*(.+?)(?:\n|$)/i);
  return registration?.[1] ? `Wormhole registration failed: ${registration[1].trim()}` : undefined;
}

export function startTunnel(options: TunnelOptions): Promise<TunnelResult> {
  if (options.provider !== "wormhole")
    return Promise.reject(new Error(`Unsupported tunnel provider: ${options.provider}`));

  return new Promise((resolve, reject) => {
    const telemetry =
      options.telemetry && options.telemetry.level !== "none"
        ? new TelemetryRecorder({
            ...options.telemetry,
            persist: options.telemetry.persist ?? true,
            sessionId: options.telemetry.sessionId ?? `tunnel-${Date.now().toString(36)}`,
          })
        : undefined;
    let child: ChildProcess | undefined;
    let url: string | undefined;
    let startup = true;
    let resolved = false;
    let reconnecting = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let healthTimer: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    let healthFailures = 0;
    let healthState: "healthy" | "degraded" = "healthy";

    const record = (event: TunnelEvent): void => {
      if (!telemetry) return;
      if (event.type === "online")
        telemetry.record({ event: "tunnel", state: "online", attempt: event.attempt });
      else if (event.type === "disconnected")
        telemetry.record({
          event: "tunnel",
          state: "disconnected",
          reasonCategory: reasonCategory(event.reason),
        });
      else if (event.type === "reconnecting")
        telemetry.record({
          event: "tunnel",
          state: "reconnecting",
          attempt: event.attempt,
          reasonCategory: reasonCategory(event.reason),
        });
      else if (event.type === "reconnected")
        telemetry.record({ event: "tunnel", state: "reconnected", attempt: event.attempt });
      else if (event.type === "health")
        telemetry.record({ event: "tunnel", state: "health", healthState: event.state });
      else
        telemetry.record({
          event: "tunnel",
          state: "failed",
          attempts: event.attempts,
          reasonCategory: reasonCategory(event.reason),
        });
    };

    const emit = (event: TunnelEvent): void => {
      record(event);
      if (event.type === "online") {
        writeLine();
        writeLine("  ✓ TUNNEL ONLINE");
        writeLine(`    Public URL   : ${event.url}`);
        writeLine(`    MCP endpoint : ${event.url}/mcp`);
        writeLine(`    Forwarding   : ${event.url} → http://127.0.0.1:${options.port}`);
        writeLine();
      } else if (event.type === "disconnected") {
        writeLine();
        writeLine(`  ⚠ TUNNEL DISCONNECTED  ${event.reason}`);
      } else if (event.type === "reconnecting") {
        writeLine(`    Reconnecting : attempt ${event.attempt}/${MAX_RECONNECT_ATTEMPTS}`);
      } else if (event.type === "reconnected") {
        writeLine(`  ✓ TUNNEL RECONNECTED  attempt ${event.attempt}`);
        writeLine(`    Public URL   : ${event.url}`);
        writeLine(`    MCP endpoint : ${event.url}/mcp`);
        writeLine();
      } else if (event.type === "health") {
        if (event.state === "degraded") writeLine("  ⚠ TUNNEL HEALTH DEGRADED");
        else if (event.state === "recovered") writeLine("  ✓ TUNNEL HEALTH RECOVERED");
      } else {
        writeLine(`  ⚠ TUNNEL RECOVERY CYCLE EXHAUSTED  ${event.reason}`);
        writeLine(`    Attempts completed : ${event.attempts}`);
        writeLine("    Starting a fresh reconnect cycle.");
      }
    };

    const cleanupTimers = (): void => {
      if (timer) clearTimeout(timer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (healthTimer) clearInterval(healthTimer);
      timer = undefined;
      reconnectTimer = undefined;
      healthTimer = undefined;
    };

    const stop = (): void => {
      stopped = true;
      cleanupTimers();
      if (child && !child.killed) child.kill("SIGTERM");
    };

    const startHealthChecks = (): void => {
      if (!url || stopped || healthTimer) return;
      healthTimer = setInterval(async () => {
        if (!url || stopped || reconnecting) return;
        try {
          const response = await fetch(new URL(HEALTH_PATH, url), {
            method: "HEAD",
            ...(options.token ? { headers: { authorization: `Bearer ${options.token}` } } : {}),
            signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
          });
          if (!response.ok) throw new Error(`Health check returned HTTP ${response.status}.`);
          healthFailures = 0;
          if (healthState === "degraded") {
            healthState = "healthy";
            emit({ type: "health", state: "recovered" });
          }
        } catch {
          healthFailures += 1;
          if (healthFailures === 1 && healthState === "healthy") {
            healthState = "degraded";
            emit({ type: "health", state: "degraded" });
          }
          if (healthFailures >= HEALTH_FAILURE_THRESHOLD) {
            healthFailures = 0;
            handleDisconnect("Public tunnel health check failed.");
          }
        }
      }, HEALTH_INTERVAL_MS);
      healthTimer.unref();
    };

    const spawnTunnel = (attempt: number): void => {
      if (stopped) return;
      reconnecting = false;
      const args = ["http", String(options.port)];
      if (!options.random && options.subdomain) args.push("--subdomain", options.subdomain);
      child = spawn("wormhole", args, { stdio: ["ignore", "pipe", "pipe"] });
      let buffer = "";
      let connected = false;

      const cleanupAttempt = (): void => {
        if (timer) clearTimeout(timer);
        timer = undefined;
        child?.stdout?.removeListener("data", onData);
        child?.stderr?.removeListener("data", onData);
        child?.removeListener("error", onError);
        child?.removeListener("exit", onExit);
      };

      const disconnect = (reason: string): void => {
        cleanupAttempt();
        if (child && !child.killed) child.kill("SIGTERM");
        if (stopped) return;
        if (startup) {
          stop();
          reject(new Error(reason));
          return;
        }
        handleDisconnect(reason);
      };

      const connectedAt = (nextUrl: string): void => {
        if (connected || stopped) return;
        connected = true;
        url = nextUrl;
        if (timer) clearTimeout(timer);
        timer = undefined;
        if (startup) {
          startup = false;
          emit({ type: "online", url, attempt });
          startHealthChecks();
          if (!resolved) {
            if (!child) {
              stop();
              reject(new Error("Wormhole connected without a child process."));
              return;
            }
            resolved = true;
            resolve({ child, url, onEvent: emit, stop });
          }
        } else {
          reconnecting = false;
          attempts = 0;
          healthFailures = 0;
          emit({ type: "reconnected", url, attempt });
          startHealthChecks();
        }
      };

      const processLine = (raw: string): void => {
        const line = cleanOutput(raw).trim();
        if (!line) return;
        const failure = failureFromLine(line);
        if (failure) {
          disconnect(failure);
          return;
        }
        const explicit = line.match(/https:\/\/[^\s"'<>]+/)?.[0]?.replace(/[),.;]+$/, "");
        if (explicit) connectedAt(explicit);
        else if (/Status\s+.*connected/i.test(line) && options.subdomain)
          connectedAt(publicUrl(options.subdomain));
      };

      const onData = (chunk: Buffer): void => {
        buffer += cleanOutput(chunk);
        const lines = buffer.split(/\r\n|\n|\r/);
        buffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      };
      const onError = (error: Error): void => disconnect(`Wormhole error: ${error.message}`);
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        const detail = signal ? `signal ${signal}` : `code ${code}`;
        disconnect(
          startup
            ? `Wormhole exited before the tunnel was established (${detail}).`
            : `Wormhole process exited (${detail}).`,
        );
      };

      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.once("error", onError);
      child.once("exit", onExit);
      timer = setTimeout(() => {
        if (!connected)
          disconnect(
            `Timed out waiting for Wormhole to establish the tunnel after ${STARTUP_TIMEOUT_MS / 1000}s.`,
          );
      }, STARTUP_TIMEOUT_MS);
    };

    const handleDisconnect = (reason: string): void => {
      if (stopped || reconnecting) return;
      reconnecting = true;
      if (child && !child.killed) child.kill("SIGTERM");
      emit({ type: "disconnected", reason });
      if (attempts >= MAX_RECONNECT_ATTEMPTS) {
        emit({ type: "failed", reason, attempts });
        attempts = 0;
      }
      attempts += 1;
      emit({ type: "reconnecting", attempt: attempts, reason });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        spawnTunnel(attempts);
      }, RECONNECT_DELAY_MS * attempts);
    };

    spawnTunnel(0);
  });
}
