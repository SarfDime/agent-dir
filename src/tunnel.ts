import { spawn } from "node:child_process";
import type { TunnelOptions, TunnelResult } from "./types.js";

const STARTUP_TIMEOUT_MS = 15_000;
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

function failureFromLine(line: string): string | undefined {
  if (/subdomain limit reached/i.test(line)) {
    return "Wormhole rejected the tunnel: subdomain limit reached. Release an existing subdomain first.";
  }

  const registration = line.match(/registration failed:\s*(.+?)(?:\n|$)/i);
  const reason = registration?.[1];
  if (reason) {
    return `Wormhole registration failed: ${reason.trim()}`;
  }

  return undefined;
}

export function startTunnel({
  provider,
  port,
  subdomain,
  random,
}: TunnelOptions): Promise<TunnelResult> {
  if (provider !== "wormhole")
    throw new Error(
      `Unsupported tunnel provider: ${provider}. Use --tunnel wormhole or --no-tunnel.`,
    );
  return new Promise((resolve, reject) => {
    const args = ["http", String(port)];
    if (!random && subdomain) args.push("--subdomain", subdomain);

    const child = spawn("wormhole", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let buffer = "";
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
    };

    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!child.killed) child.kill("SIGTERM");
      reject(new Error(message));
    };

    const succeed = (url: string): void => {
      if (settled) return;
      settled = true;
      cleanup();

      writeLine();
      writeLine("  ✓ TUNNEL ONLINE");
      writeLine(`    Public URL   : ${url}`);
      writeLine(`    MCP endpoint : ${url}/mcp`);
      writeLine(`    Forwarding   : ${url} → http://127.0.0.1:${port}`);
      writeLine();

      resolve({ child, url });
    };

    const processLine = (rawLine: string): void => {
      const line = cleanOutput(rawLine).trim();
      if (!line) return;

      const failure = failureFromLine(line);
      if (failure) {
        fail(failure);
        return;
      }

      const explicitUrl = line.match(/https:\/\/[^\s"'<>]+/)?.[0]?.replace(/[),.;]+$/, "");
      if (explicitUrl) {
        succeed(explicitUrl);
        return;
      }

      if (/Status\s+.*connected/i.test(line)) {
        if (subdomain) succeed(publicUrl(subdomain));
      }
    };

    const onData = (chunk: Buffer): void => {
      buffer += cleanOutput(chunk);
      const lines = buffer.split(/\r\n|\n|\r/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        processLine(line);
        if (settled) break;
      }
    };

    const onError = (error: Error): void => {
      fail(`Unable to start Wormhole: ${error.message}`);
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      const detail = signal ? `signal ${signal}` : `code ${code}`;
      fail(`Wormhole exited before the tunnel was established (${detail}).`);
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);

    timer = setTimeout(() => {
      fail(
        `Timed out waiting for Wormhole to establish the tunnel after ${STARTUP_TIMEOUT_MS / 1000}s.`,
      );
    }, STARTUP_TIMEOUT_MS);
  });
}
