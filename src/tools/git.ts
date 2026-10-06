import { spawn } from "node:child_process";

export interface GitResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

function validatePaths(paths: string[]): void {
  if (
    !Array.isArray(paths) ||
    paths.length === 0 ||
    paths.some((path) => typeof path !== "string" || !path)
  ) {
    throw new Error("paths must contain at least one non-empty path.");
  }
}

function runGit(root: string, args: string[], timeoutMs = 30000): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: root, shell: false, env: process.env });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill("SIGTERM");
      reject(new Error(`git ${args.join(" ")} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
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

export function gitStage(root: string, paths: string[]): Promise<GitResult> {
  validatePaths(paths);
  return runGit(root, ["add", "--", ...paths]);
}

export function gitUnstage(root: string, paths: string[]): Promise<GitResult> {
  validatePaths(paths);
  return runGit(root, ["restore", "--staged", "--", ...paths]);
}

export function gitCommit(root: string, message: string): Promise<GitResult> {
  if (!message.trim()) throw new Error("commit message must not be empty.");
  return runGit(root, ["commit", "-m", message]);
}

export function gitPush(root: string, remote?: string, branch?: string): Promise<GitResult> {
  const args = ["push"];
  if (remote) {
    if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw new Error("Invalid Git remote name.");
    args.push(remote);
    if (branch) {
      if (!/^[A-Za-z0-9._/-]+$/.test(branch)) throw new Error("Invalid Git branch name.");
      args.push(branch);
    }
  } else if (branch) {
    throw new Error("A Git remote is required when specifying a branch.");
  }
  return runGit(root, args);
}

export function gitStatus(root: string): Promise<GitResult> {
  return runGit(root, ["status", "--short", "--branch"]);
}
export function gitDiff(root: string, staged = false, pathspec?: string): Promise<GitResult> {
  const args = ["diff", "--no-ext-diff", "--no-color"];
  if (staged) args.push("--cached");
  if (pathspec) args.push("--", pathspec);
  return runGit(root, args);
}
export function gitRestore(root: string, paths: string[], staged = false): Promise<GitResult> {
  validatePaths(paths);
  return runGit(root, ["restore", ...(staged ? ["--staged"] : []), "--", ...paths]);
}

export function gitLog(root: string, limit = 20, pathspec?: string): Promise<GitResult> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error("limit must be an integer between 1 and 200.");
  const args = [
    "log",
    "--no-color",
    "--date=iso-strict",
    "--format=%H%x09%ad%x09%an%x09%s",
    "-n",
    String(limit),
  ];
  if (pathspec) args.push("--", pathspec);
  return runGit(root, args);
}
