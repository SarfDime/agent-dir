import { spawn } from "node:child_process";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function runCommand(
  root: string,
  command: string,
  args: string[] = [],
  allowedCommands: string[] = [],
  timeoutMs = 120000,
): Promise<CommandResult> {
  if (!SAFE_NAME.test(command)) throw new Error("Invalid command name.");
  if (!allowedCommands.includes(command))
    throw new Error(`Command '${command}' is not allowed by this profile.`);
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
    throw new Error("Command arguments must be strings.");

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, shell: false, env: process.env });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill("SIGTERM");
      reject(new Error(`Command '${command}' timed out after ${timeoutMs}ms.`));
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
      resolve({ command: [command, ...args].join(" "), exitCode: code ?? 1, stdout, stderr });
    });
  });
}
