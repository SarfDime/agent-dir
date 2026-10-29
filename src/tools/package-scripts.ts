import { promises as fs } from "node:fs";
import path from "node:path";
import type { PackageManager } from "../types.js";
import type { CaptureResult, CommandResult } from "./commands.js";
import { spawnCapture } from "./commands.js";

interface PackageJson {
  scripts?: Record<string, string>;
}

/** Validates a script request; returns a problem description or undefined when it can run. */
export async function packageScriptProblem(
  root: string,
  script: string,
  allowedScripts: string[] = [],
): Promise<string | undefined> {
  if (typeof script !== "string" || !/^[A-Za-z0-9:_-]+$/.test(script))
    return "Invalid package script name.";
  let packageJson: PackageJson;
  try {
    packageJson = JSON.parse(
      await fs.readFile(path.join(root, "package.json"), "utf8"),
    ) as PackageJson;
  } catch {
    return "No valid package.json found.";
  }
  if (!packageJson.scripts?.[script])
    return `Package script '${script}' does not exist in package.json.`;
  if (!allowedScripts.includes(script))
    return `Package script '${script}' is not allowed by this profile.`;
  return undefined;
}

const MAX_SCRIPT_ARGS = 16;
const MAX_SCRIPT_ARG_LENGTH = 300;

/** Extra arguments are only accepted for scripts the profile lists in `argumentScripts`. */
export function packageScriptArgsProblem(
  script: string,
  args: unknown,
  argumentScripts: string[] = [],
): string | undefined {
  if (args === undefined) return undefined;
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
    return "Package script args must be an array of strings.";
  if (args.length === 0) return undefined;
  if (!argumentScripts.includes(script))
    return `Package script '${script}' does not accept arguments; add it to scripts.argumentScripts in the profile to allow them.`;
  if (args.length > MAX_SCRIPT_ARGS) return `At most ${MAX_SCRIPT_ARGS} arguments are allowed.`;
  if (args.some((arg) => arg.length > MAX_SCRIPT_ARG_LENGTH || /[\0\r\n]/.test(arg)))
    return `Arguments must be single lines of at most ${MAX_SCRIPT_ARG_LENGTH} characters.`;
  return undefined;
}

export function packageScriptLabel(
  packageManager: PackageManager,
  script: string,
  args: string[] = [],
): string {
  return [`${packageManager} run ${script}`, ...(args.length ? ["--", ...args] : [])].join(" ");
}

/** Runs an already validated script with the shared process runner. */
export function packageScriptCapture(
  root: string,
  script: string,
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
    packageManager?: PackageManager;
    args?: string[];
  } = {},
): Promise<CaptureResult> {
  const packageManager = options.packageManager ?? "npm";
  const executable = process.platform === "win32" ? `${packageManager}.cmd` : packageManager;
  return spawnCapture(
    root,
    executable,
    ["run", script, ...(options.args?.length ? ["--", ...options.args] : [])],
    {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
}

export async function runPackageScript(
  root: string,
  script: string,
  timeoutMs = 120000,
  allowedScripts: string[] = [],
  signal?: AbortSignal,
  packageManager: PackageManager = "npm",
): Promise<CommandResult> {
  const problem = await packageScriptProblem(root, script, allowedScripts);
  if (problem) throw new Error(problem);
  const label = packageScriptLabel(packageManager, script);
  const capture = await packageScriptCapture(root, script, {
    timeoutMs,
    packageManager,
    ...(signal ? { signal } : {}),
  });
  if (capture.aborted) throw new Error(`${label} was aborted.`);
  if (capture.timedOut) throw new Error(`${label} timed out after ${timeoutMs}ms.`);
  if (capture.error) throw new Error(capture.error);
  return {
    command: label,
    exitCode: capture.exitCode ?? 1,
    stdout: capture.stdout,
    stderr: capture.stderr,
  };
}
