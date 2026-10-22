import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TelemetryRecorder } from "../src/telemetry/recorder.js";
import {
  pruneTelemetry,
  readTelemetryEvents,
  scrubDiagnosticDetails,
} from "../src/telemetry/storage.js";
import type { AnonymousTelemetryEvent } from "../src/telemetry/types.js";

const DAY = 86_400_000;

function envelope(
  configId: string,
  sessionId: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    schemaVersion: 1,
    configId,
    sessionId,
    timestamp: new Date().toISOString(),
    level: "basic",
    event: { event: "tool_call", tool: "read_range", success: true, ...extra },
  });
}

function sessionFile(
  directory: string,
  configId: string,
  sessionId: string,
  options: { ageDays?: number; padding?: number; extra?: Record<string, unknown> } = {},
): string {
  mkdirSync(join(directory, configId), { recursive: true });
  const path = join(directory, configId, `session-${sessionId}.jsonl`);
  const padding = "x".repeat(options.padding ?? 0);
  writeFileSync(path, `${envelope(configId, sessionId, { padding, ...(options.extra ?? {}) })}\n`, {
    mode: 0o600,
  });
  if (options.ageDays) {
    const time = new Date(Date.now() - options.ageDays * DAY);
    utimesSync(path, time, time);
  }
  return path;
}

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "agent-dir-retention-"));
}

test("prune removes session files older than the retention age", () => {
  const directory = temporaryDirectory();
  try {
    const old = sessionFile(directory, "proj", "old", { ageDays: 31 });
    const fresh = sessionFile(directory, "proj", "fresh", { ageDays: 29 });
    const result = pruneTelemetry({ directory });
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(fresh), true);
    assert.equal(result.deletedFiles, 1);
    assert.equal(result.remainingFiles, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prune enforces the size cap by deleting the oldest files first", () => {
  const directory = temporaryDirectory();
  try {
    const oldest = sessionFile(directory, "proj", "a", { ageDays: 3, padding: 400 });
    const middle = sessionFile(directory, "proj", "b", { ageDays: 2, padding: 400 });
    const newest = sessionFile(directory, "proj", "c", { ageDays: 1, padding: 400 });
    const size = statSync(newest).size;
    const result = pruneTelemetry({ directory, maxBytes: size * 2 + 10 });
    assert.equal(existsSync(oldest), false);
    assert.equal(existsSync(middle), true);
    assert.equal(existsSync(newest), true);
    assert.ok(result.remainingBytes <= size * 2 + 10);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prune never deletes protected files, even when over both limits", () => {
  const directory = temporaryDirectory();
  try {
    const active = sessionFile(directory, "proj", "active", { ageDays: 90, padding: 400 });
    pruneTelemetry({ directory, maxBytes: 1, keep: [active] });
    assert.equal(existsSync(active), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prune removes emptied profile directories", () => {
  const directory = temporaryDirectory();
  try {
    sessionFile(directory, "gone", "old", { ageDays: 40 });
    pruneTelemetry({ directory });
    assert.equal(existsSync(join(directory, "gone")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("scrub removes only the legacy raw diagnosticDetails field and keeps file mode", () => {
  const directory = temporaryDirectory();
  try {
    const dirty = sessionFile(directory, "proj", "dirty", {
      extra: { diagnosticDetails: { input: { path: "secret.txt" }, output: "file contents" } },
    });
    const clean = sessionFile(directory, "proj", "clean");
    const before = readFileSync(clean, "utf8");
    assert.equal(scrubDiagnosticDetails(directory), 1);
    const after = readFileSync(dirty, "utf8");
    assert.ok(!after.includes("diagnosticDetails"));
    assert.ok(!after.includes("file contents"));
    const parsed = JSON.parse(after.trim()) as { event: { tool: string; success: boolean } };
    assert.equal(parsed.event.tool, "read_range");
    assert.equal(parsed.event.success, true);
    assert.equal(statSync(dirty).mode & 0o777, 0o600);
    assert.equal(readFileSync(clean, "utf8"), before);
    assert.equal(scrubDiagnosticDetails(directory), 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("readTelemetryEvents filters by profile, session and time without writing", () => {
  const directory = temporaryDirectory();
  try {
    const a = sessionFile(directory, "alpha", "one");
    sessionFile(directory, "alpha", "two");
    sessionFile(directory, "beta", "one");
    const old = sessionFile(directory, "alpha", "stale", { ageDays: 10 });
    const mtimeBefore = statSync(a).mtimeMs;

    assert.equal(readTelemetryEvents({ directory }).length, 4);
    assert.equal(readTelemetryEvents({ directory, profile: "alpha" }).length, 3);
    assert.equal(readTelemetryEvents({ directory, profile: "alpha", session: "two" }).length, 1);
    assert.equal(readTelemetryEvents({ directory, sinceMs: Date.now() - 5 * DAY }).length, 3);
    assert.equal(readTelemetryEvents({ directory, profile: "missing" }).length, 0);
    assert.equal(statSync(a).mtimeMs, mtimeBefore);
    assert.equal(existsSync(old), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("recorder recreates its file after the telemetry directory is removed", () => {
  const directory = temporaryDirectory();
  const persistPath = join(directory, "proj", "session-x.jsonl");
  try {
    const recorder = new TelemetryRecorder({
      level: "anonymous",
      persist: true,
      persistPath,
      configId: "proj",
      sessionId: "x",
    });
    const event: AnonymousTelemetryEvent = {
      event: "tool_call",
      tool: "read_range",
      success: true,
      durationMs: 1,
    };
    recorder.record(event);
    recorder.record(event);
    assert.equal(readFileSync(persistPath, "utf8").trim().split("\n").length, 2);
    assert.equal(statSync(persistPath).mode & 0o777, 0o600);
    rmSync(join(directory, "proj"), { recursive: true, force: true });
    recorder.record(event);
    assert.equal(readFileSync(persistPath, "utf8").trim().split("\n").length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
