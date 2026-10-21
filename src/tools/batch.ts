import type { CaptureResult } from "./commands.js";

/**
 * Every batch item ends in exactly one of three states so an agent never has to guess whether
 * something ran: `success`, `failure` (ran and failed, or was rejected before running), or
 * `skipped` (deliberately not run, with the reason).
 */
export type BatchStatus = "success" | "failure" | "skipped";
export type BatchOnError = "continue" | "stop";

export interface BatchTask {
  /** Human-readable command line shown in the result. */
  label: string;
  /** Exit codes that count as success (default `[0]`), for example `[0, 1]` for `rg`. */
  okExitCodes?: number[];
  /** Returns a rejection reason when the item must not run. */
  preflight: () => Promise<string | undefined> | string | undefined;
  execute: () => Promise<CaptureResult>;
}

export interface BatchItem {
  index: number;
  command: string;
  status: BatchStatus;
  /** Why the item failed or was skipped; absent on success. */
  reason?: string;
  /** True when the command was started. */
  ran: boolean;
  exitCode?: number;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  outputTruncated?: boolean;
}

export interface BatchResult {
  ok: boolean;
  onError: BatchOnError;
  summary: { total: number; success: number; failure: number; skipped: number };
  items: BatchItem[];
  truncated: boolean;
}

const ITEM_OVERHEAD_BYTES = 320;
const RESULT_OVERHEAD_BYTES = 300;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Trims to a UTF-8 byte budget on a character boundary, keeping the head or the tail. */
export function truncateUtf8(text: string, maxBytes: number, keep: "head" | "tail"): string {
  if (byteLength(text) <= maxBytes) return text;
  const marker = "\n…[truncated]\n";
  const budget = Math.max(0, maxBytes - byteLength(marker));
  const buffer = Buffer.from(text, "utf8");
  if (keep === "head") {
    let slice = buffer.subarray(0, budget).toString("utf8");
    while (byteLength(slice) > budget) slice = slice.slice(0, -1);
    return `${slice}${marker}`.trimEnd();
  }
  let slice = buffer.subarray(buffer.length - budget).toString("utf8");
  while (byteLength(slice) > budget) slice = slice.slice(1);
  return `${marker}${slice}`.trimStart();
}

/** Water-filling split of a byte budget so small outputs never waste a large item's share. */
function allocate(sizes: number[], budget: number): number[] {
  const allocation = sizes.map(() => 0);
  const order = sizes.map((size, index) => ({ size, index })).sort((a, b) => a.size - b.size);
  let remaining = Math.max(0, budget);
  order.forEach((entry, position) => {
    const share = Math.floor(remaining / (order.length - position));
    const granted = Math.min(entry.size, share);
    allocation[entry.index] = granted;
    remaining -= granted;
  });
  return allocation;
}

function applyOutputBudget(items: BatchItem[], maxBytes: number): boolean {
  const withOutput = items.filter((item) => item.stdout !== undefined || item.stderr !== undefined);
  const budget = maxBytes - RESULT_OVERHEAD_BYTES - items.length * ITEM_OVERHEAD_BYTES;
  const sizes = withOutput.map(
    (item) => byteLength(item.stdout ?? "") + byteLength(item.stderr ?? ""),
  );
  const allocation = allocate(sizes, budget);
  let truncated = false;
  withOutput.forEach((item, position) => {
    const granted = allocation[position] ?? 0;
    const stdout = item.stdout ?? "";
    const stderr = item.stderr ?? "";
    if (byteLength(stdout) + byteLength(stderr) <= granted) return;
    // Errors matter: give stderr up to 40% of the share, then let stdout use the rest.
    let stderrCap = Math.min(byteLength(stderr), Math.floor(granted * 0.4));
    const stdoutCap = granted - stderrCap;
    if (byteLength(stdout) < stdoutCap)
      stderrCap = Math.min(byteLength(stderr), granted - byteLength(stdout));
    const keep = item.status === "failure" ? "tail" : "head";
    item.stdout = truncateUtf8(stdout, Math.max(0, granted - stderrCap), keep);
    item.stderr = truncateUtf8(stderr, stderrCap, keep);
    item.outputTruncated = true;
    truncated = true;
  });
  return truncated;
}

export async function runBatch(
  tasks: BatchTask[],
  options: { onError: BatchOnError; maxBytes: number },
): Promise<BatchResult> {
  const { onError } = options;
  const problems: Array<string | undefined> = [];
  for (const task of tasks) problems.push(await task.preflight());
  const firstRejected = problems.findIndex((problem) => problem !== undefined);

  const items: BatchItem[] = [];
  if (onError === "stop" && firstRejected >= 0) {
    // Nothing runs when a stop-on-error batch contains a rejected item.
    tasks.forEach((task, index) => {
      const problem = problems[index];
      items.push(
        problem === undefined
          ? {
              index,
              command: task.label,
              status: "skipped",
              ran: false,
              reason: `Not run: item ${firstRejected} was rejected before execution (onError: stop).`,
            }
          : { index, command: task.label, status: "failure", ran: false, reason: problem },
      );
    });
  } else {
    let stoppedBy: number | undefined;
    for (const [index, task] of tasks.entries()) {
      const problem = problems[index];
      if (stoppedBy !== undefined) {
        items.push({
          index,
          command: task.label,
          status: "skipped",
          ran: false,
          reason: `Not run: item ${stoppedBy} failed (onError: stop).`,
        });
        continue;
      }
      if (problem !== undefined) {
        items.push({ index, command: task.label, status: "failure", ran: false, reason: problem });
        continue;
      }
      const capture = await task.execute();
      const okCodes = task.okExitCodes ?? [0];
      const succeeded =
        !capture.timedOut &&
        !capture.aborted &&
        capture.error === undefined &&
        capture.exitCode !== null &&
        okCodes.includes(capture.exitCode);
      const item: BatchItem = {
        index,
        command: task.label,
        status: succeeded ? "success" : "failure",
        ran: true,
        durationMs: capture.durationMs,
        stdout: capture.stdout,
        stderr: capture.stderr,
      };
      if (capture.exitCode !== null) item.exitCode = capture.exitCode;
      if (!succeeded) {
        item.reason = capture.timedOut
          ? "Timed out; the process was terminated. Partial output is included."
          : capture.aborted
            ? "Aborted by the client; the process was terminated."
            : capture.error !== undefined
              ? `Could not start: ${capture.error}`
              : `Exited with code ${capture.exitCode}.`;
        if (onError === "stop") stoppedBy = index;
      }
      items.push(item);
    }
  }

  const truncated = applyOutputBudget(items, options.maxBytes);
  const summary = {
    total: items.length,
    success: items.filter((item) => item.status === "success").length,
    failure: items.filter((item) => item.status === "failure").length,
    skipped: items.filter((item) => item.status === "skipped").length,
  };
  return {
    ok: summary.failure === 0 && summary.skipped === 0,
    onError,
    summary,
    items,
    truncated,
  };
}
