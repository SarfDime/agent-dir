import { spawn } from "node:child_process";
import {
  appendBoundedOutput,
  commandEnvironment,
  processTreeSpawnOptions,
  terminateProcessTree,
} from "./commands.js";

export interface GitResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runGit(root: string, args: string[], timeoutMs = 30000): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: root,
      shell: false,
      env: commandEnvironment(),
      ...processTreeSpawnOptions(),
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      terminateProcessTree(child);
      reject(new Error(`git ${args.join(" ")} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
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
      reject(error);
    });
    child.on("close", (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ command: ["git", ...args].join(" "), exitCode: code ?? 1, stdout, stderr });
    });
  });
}

export function gitStatus(root: string): Promise<GitResult> {
  return runGit(root, ["status", "--short", "--branch"]);
}
