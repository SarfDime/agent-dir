import { spawn } from "node:child_process";
import type { TunnelOptions, TunnelResult } from "./types.js";

export function startTunnel({ provider, port, subdomain }: TunnelOptions): Promise<TunnelResult> {
  if (provider !== "wormhole")
    throw new Error(
      `Unsupported tunnel provider: ${provider}. Use --tunnel wormhole or --no-tunnel.`,
    );
  if (!subdomain) throw new Error("Wormhole requires --subdomain <name>.");

  return new Promise((resolve, reject) => {
    const child = spawn("wormhole", ["http", String(port), "--subdomain", subdomain], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    const handle = (line: Buffer): void => {
      const text = line.toString().trim();
      if (!text || /\bINF\b|inspector started|status changed|request latency=/.test(text)) return;
      if (/tunnel established url=/.test(text)) {
        const url = text.match(/url=(\S+)/)?.[1] ?? `https://${subdomain}.wormhole.bar`;
        console.log("");
        console.log("  ✓ TUNNEL ONLINE");
        console.log(`    Public URL   : ${url}`);
        console.log(`    MCP endpoint : ${url}/mcp`);
        console.log(`    Forwarding   : ${url} → http://127.0.0.1:${port}`);
        console.log("");
        settled = true;
        resolve({ child, url });
        return;
      }
      if (/Forwarding:/.test(text)) return;
    };
    child.stdout?.on("data", handle);
    child.stderr?.on("data", handle);
    child.once("error", (error: Error) => {
      if (!settled) reject(new Error(`Unable to start Wormhole: ${error.message}`));
    });
    child.once("exit", (code: number | null) => {
      if (!settled && code !== 0) reject(new Error(`Wormhole exited with code ${code}.`));
    });
  });
}
