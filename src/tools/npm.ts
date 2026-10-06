import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { CommandResult } from "./commands.js";

interface PackageJson {
  scripts?: Record<string, string>;
}

export function runNpm(
  root: string,
  script: string,
  timeoutMs = 120000,
  allowedScripts: string[] = [],
  signal?: AbortSignal,
): Promise<CommandResult> {
  if (!/^[A-Za-z0-9:_-]+$/.test(script)) throw new Error("Invalid npm script name.");
  return (async () => {
    let packageJson: PackageJson;
    try {
      packageJson = JSON.parse(
        await fs.readFile(path.join(root, "package.json"), "utf8"),
      ) as PackageJson;
    } catch {
      throw new Error("No valid package.json found.");
    }
    if (!packageJson.scripts?.[script])
      throw new Error(`npm script '${script}' does not exist in package.json.`);
    if (!allowedScripts.includes(script))
      throw new Error(`npm script '${script}' is not allowed by this profile.`);
    return new Promise<CommandResult>((resolve, reject) => {
      const executable = process.platform === "win32" ? "npm.cmd" : "npm";
      const child = spawn(executable, ["run", script], {
        cwd: root,
        shell: false,
        env: process.env,
      });
      let stdout = "";
      let stderr = "";
      let finished = false;
      let timer: ReturnType<typeof setTimeout>;
      const abort = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        reject(new Error(`npm run ${script} was aborted.`));
      };
      timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        child.kill("SIGTERM");
        signal?.removeEventListener("abort", abort);
        reject(new Error(`npm run ${script} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.on("error", (error: Error) => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(error);
        }
      });
      child.on("close", (code: number | null) => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          resolve({ command: `npm run ${script}`, exitCode: code ?? 1, stdout, stderr });
        }
      });
    });
  })();
}
