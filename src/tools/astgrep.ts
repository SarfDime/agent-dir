import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";

const MAX_OUTPUT_BYTES = 64_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_RESULTS = 500;

export interface AstGrepArgs {
  pattern: string;
  lang?: string;
  globs?: string[];
  context?: number;
  maxResults?: number;
  maxBytes?: number;
}

function executablePath(): string | undefined {
  const names = process.platform === "win32" ? ["ast-grep.exe", "sg.exe"] : ["ast-grep", "sg"];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Try the next candidate.
      }
    }
  }
  return undefined;
}

export function isAstGrepAvailable(): boolean {
  const executable = executablePath();
  if (!executable) return false;
  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 2_000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0 && /ast-grep/i.test(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
}

function boundedText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "\n…[truncated]";
  let end = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  while (end > 0 && Buffer.byteLength(value.slice(0, end) + suffix, "utf8") > maxBytes) end--;
  return value.slice(0, end) + suffix;
}

export async function runAstGrep(
  root: string,
  args: AstGrepArgs,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const executable = executablePath();
  if (!executable || !isAstGrepAvailable()) {
    throw new Error(
      "ast-grep is not installed or not available on PATH. Install the ast-grep CLI to enable ast_grep_search.",
    );
  }
  if (typeof args.pattern !== "string" || !args.pattern.trim()) {
    throw new Error("pattern must be a non-empty string.");
  }
  if (args.pattern.length > 2_000) throw new Error("pattern must be 2,000 characters or fewer.");
  if (args.lang !== undefined && !/^[a-zA-Z0-9_+-]{1,32}$/.test(args.lang)) {
    throw new Error("lang must be a short language identifier.");
  }
  const globs = args.globs ?? [];
  if (
    !Array.isArray(globs) ||
    globs.length > 20 ||
    globs.some(
      (glob) =>
        typeof glob !== "string" ||
        !glob.trim() ||
        glob.length > 256 ||
        glob.startsWith("/") ||
        glob.split(/[\\/]/).includes(".."),
    )
  ) {
    throw new Error(
      "globs must contain up to 20 relative glob patterns without parent-directory segments.",
    );
  }
  const context = args.context ?? 0;
  if (!Number.isInteger(context) || context < 0 || context > 5) {
    throw new Error("context must be an integer between 0 and 5.");
  }
  const maxResults = args.maxResults ?? 100;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) {
    throw new Error("maxResults must be an integer between 1 and 500.");
  }
  const maxBytes = args.maxBytes ?? 8_000;
  if (!Number.isInteger(maxBytes) || maxBytes < 1_024 || maxBytes > MAX_OUTPUT_BYTES) {
    throw new Error("maxBytes must be an integer between 1024 and 64000.");
  }

  const cliArgs = ["run", "--pattern", args.pattern, "--json=compact", "--color", "never"];
  if (args.lang) cliArgs.push("--lang", args.lang);
  for (const glob of globs) cliArgs.push("--globs", glob);
  if (context > 0) cliArgs.push("--context", String(context));
  cliArgs.push(".");
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(executable, cliArgs, {
        cwd: root,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const kill = () => child.kill("SIGKILL");
      const onAbort = () => {
        kill();
        finish(() => reject(new Error("ast-grep search was cancelled.")));
      };
      const timer = setTimeout(() => {
        kill();
        finish(() => reject(new Error("ast-grep search exceeded the 30-second timeout.")));
      }, MAX_TIMEOUT_MS);
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          kill();
          finish(() =>
            reject(
              new Error(
                "ast-grep output exceeded the 64 KB safety limit. Narrow the pattern or globs.",
              ),
            ),
          );
          return;
        }
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (Buffer.byteLength(stderr, "utf8") < 8_000) stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => finish(() => reject(error)));
      child.on("close", (code) => finish(() => resolve({ code, stdout, stderr })));
    },
  );

  if (result.code !== 0 && result.code !== 1) {
    throw new Error(
      boundedText(result.stderr || `ast-grep exited with code ${result.code}.`, 4_000),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout || "[]");
  } catch {
    throw new Error("ast-grep returned invalid JSON output.");
  }
  if (!Array.isArray(parsed)) throw new Error("ast-grep returned an unexpected JSON shape.");
  const items = parsed.slice(0, maxResults);
  const serialized = JSON.stringify(items);
  const bounded = boundedText(serialized, maxBytes);
  return {
    ...(bounded === serialized ? { matches: items } : { preview: bounded }),
    count: items.length,
    truncated: parsed.length > items.length || bounded !== serialized,
    ...(result.stderr.trim() ? { stderr: boundedText(result.stderr.trim(), 2_000) } : {}),
  };
}
