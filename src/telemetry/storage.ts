import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { TelemetryEnvelope } from "./types.js";

const CONFIG_DIRECTORY = join(homedir(), ".config", "agent-dir");
export const TELEMETRY_DIRECTORY = join(CONFIG_DIRECTORY, "telemetry");
export const LEGACY_TELEMETRY_FILE = join(CONFIG_DIRECTORY, "telemetry.jsonl");
const LEGACY_ARCHIVE_FILE = join(CONFIG_DIRECTORY, "telemetry.legacy-archive.jsonl");

function safeSegment(value: string): string {
  const safe = value
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+$/, "_")
    .slice(0, 100);
  return safe || "unknown";
}

export function telemetrySessionPath(configId: string, sessionId: string): string {
  return join(
    TELEMETRY_DIRECTORY,
    safeSegment(configId),
    `session-${safeSegment(sessionId)}.jsonl`,
  );
}

function parseEvents(content: string): TelemetryEnvelope[] {
  const events: TelemetryEnvelope[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as TelemetryEnvelope;
      if (
        value &&
        value.schemaVersion === 1 &&
        typeof value.configId === "string" &&
        typeof value.sessionId === "string" &&
        typeof value.timestamp === "string" &&
        value.event
      ) {
        events.push(value);
      }
    } catch {
      // Ignore malformed lines without discarding other valid events.
    }
  }
  return events;
}

function readFileEvents(path: string): TelemetryEnvelope[] {
  try {
    return parseEvents(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

function collectJsonlFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectJsonlFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}

/** Migrate the old shared file once, preserving an archive and avoiding duplicate lines. */
export function migrateLegacyTelemetry(): void {
  if (!existsSync(LEGACY_TELEMETRY_FILE)) return;
  const legacyEvents = readFileEvents(LEGACY_TELEMETRY_FILE);
  mkdirSync(TELEMETRY_DIRECTORY, { recursive: true, mode: 0o700 });

  const groups = new Map<string, TelemetryEnvelope[]>();
  for (const event of legacyEvents) {
    const path = telemetrySessionPath(event.configId, event.sessionId);
    const group = groups.get(path) ?? [];
    group.push(event);
    groups.set(path, group);
  }

  for (const [path, events] of groups) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    let existing = new Set<string>();
    try {
      existing = new Set(readFileSync(path, "utf8").split("\n").filter(Boolean));
    } catch {
      // New session file.
    }
    const missing = events
      .map((event) => JSON.stringify(event))
      .filter((line) => {
        if (existing.has(line)) return false;
        existing.add(line);
        return true;
      });
    if (missing.length) {
      appendFileSync(path, `${missing.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
      chmodSync(path, 0o600);
    }
  }

  let archive = LEGACY_ARCHIVE_FILE;
  if (existsSync(archive)) archive = `${LEGACY_ARCHIVE_FILE}.${Date.now()}`;
  renameSync(LEGACY_TELEMETRY_FILE, archive);
}

export function readAllTelemetryEvents(): TelemetryEnvelope[] {
  migrateLegacyTelemetry();
  return collectJsonlFiles(TELEMETRY_DIRECTORY)
    .flatMap(readFileEvents)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function resetTelemetry(profile?: string, all = false): void {
  if (all) {
    rmSync(TELEMETRY_DIRECTORY, { recursive: true, force: true });
    rmSync(LEGACY_TELEMETRY_FILE, { force: true });
    rmSync(LEGACY_ARCHIVE_FILE, { force: true });
    for (const entry of existsSync(CONFIG_DIRECTORY)
      ? readdirSync(CONFIG_DIRECTORY, { withFileTypes: true })
      : []) {
      if (entry.isFile() && entry.name.startsWith("telemetry.legacy-archive.jsonl.")) {
        rmSync(join(CONFIG_DIRECTORY, entry.name), { force: true });
      }
    }
    return;
  }
  if (!profile) throw new Error("Specify a profile name or use --all.");
  rmSync(join(TELEMETRY_DIRECTORY, safeSegment(profile)), { recursive: true, force: true });
}

export function ensureTelemetryDirectory(): void {
  mkdirSync(TELEMETRY_DIRECTORY, { recursive: true, mode: 0o700 });
  try {
    chmodSync(TELEMETRY_DIRECTORY, 0o700);
  } catch {
    // Best-effort permission hardening.
  }
}
