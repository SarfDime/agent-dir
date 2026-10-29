import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
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

export interface TelemetryReadFilter {
  profile?: string;
  session?: string;
  /** Skip session files last modified before this time (epoch ms). */
  sinceMs?: number;
  directory?: string;
}

/**
 * Read-only query: never migrates or rewrites files, and prunes by profile directory,
 * session file name and modification time before parsing anything.
 */
export function readTelemetryEvents(filter: TelemetryReadFilter = {}): TelemetryEnvelope[] {
  const directory = filter.directory ?? TELEMETRY_DIRECTORY;
  const root = filter.profile ? join(directory, safeSegment(filter.profile)) : directory;
  const sessionFile = filter.session ? `session-${safeSegment(filter.session)}.jsonl` : undefined;
  return collectJsonlFiles(root)
    .filter((path) => !sessionFile || basename(path) === sessionFile)
    .filter((path) => {
      if (filter.sinceMs === undefined) return true;
      try {
        return statSync(path).mtimeMs >= filter.sinceMs;
      } catch {
        return false;
      }
    })
    .flatMap(readFileEvents)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/** Retention policy: whichever limit is reached first applies. */
export const TELEMETRY_RETENTION_DAYS = 30;
export const TELEMETRY_RETENTION_BYTES = 100 * 1024 * 1024;

function legacyArchiveFiles(): string[] {
  if (!existsSync(CONFIG_DIRECTORY)) return [];
  return readdirSync(CONFIG_DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith("telemetry.legacy-archive.jsonl"))
    .map((entry) => join(CONFIG_DIRECTORY, entry.name));
}

/** Removes the legacy raw `diagnosticDetails` field from one file. Returns events changed. */
function scrubFile(path: string): number {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return 0;
  }
  if (!content.includes('"diagnosticDetails"')) return 0;
  let changed = 0;
  const lines = content.split("\n").map((line) => {
    if (!line.includes('"diagnosticDetails"')) return line;
    try {
      const value = JSON.parse(line) as { event?: Record<string, unknown> };
      if (value.event && "diagnosticDetails" in value.event) {
        value.event.diagnosticDetails = undefined;
        changed += 1;
        return JSON.stringify(value);
      }
    } catch {
      // Leave malformed lines untouched.
    }
    return line;
  });
  if (!changed) return 0;
  const temporary = `${path}.scrub-${process.pid}`;
  try {
    writeFileSync(temporary, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch {
    rmSync(temporary, { force: true });
    return 0;
  }
  return changed;
}

/** Scrubs legacy raw tool details from recorded telemetry (explicit, never part of a read). */
export function scrubDiagnosticDetails(directory = TELEMETRY_DIRECTORY): number {
  const files = collectJsonlFiles(directory);
  if (directory === TELEMETRY_DIRECTORY) files.push(...legacyArchiveFiles());
  return files.reduce((total, path) => total + scrubFile(path), 0);
}

export interface TelemetryPruneOptions {
  directory?: string;
  maxAgeDays?: number;
  maxBytes?: number;
  now?: number;
  /** Files that must never be deleted (for example the active session file). */
  keep?: string[];
}

export interface TelemetryPruneResult {
  deletedFiles: number;
  deletedBytes: number;
  scrubbedEvents: number;
  remainingFiles: number;
  remainingBytes: number;
}

/**
 * Enforces retention (30 days and 100 MB by default, whichever is reached first) by deleting
 * the oldest session files, and scrubs legacy raw tool details from what remains.
 */
export function pruneTelemetry(options: TelemetryPruneOptions = {}): TelemetryPruneResult {
  const directory = options.directory ?? TELEMETRY_DIRECTORY;
  const now = options.now ?? Date.now();
  const maxAgeMs = (options.maxAgeDays ?? TELEMETRY_RETENTION_DAYS) * 86_400_000;
  const maxBytes = options.maxBytes ?? TELEMETRY_RETENTION_BYTES;
  const keep = new Set(options.keep ?? []);
  const scrubbedEvents = scrubDiagnosticDetails(directory);

  let files: Array<{ path: string; size: number; mtime: number }> = [];
  for (const path of collectJsonlFiles(directory)) {
    try {
      const stats = statSync(path);
      files.push({ path, size: stats.size, mtime: stats.mtimeMs });
    } catch {
      // Vanished between listing and stat.
    }
  }
  let deletedFiles = 0;
  let deletedBytes = 0;
  const remove = (file: { path: string; size: number }): boolean => {
    try {
      rmSync(file.path, { force: true });
      deletedFiles += 1;
      deletedBytes += file.size;
      return true;
    } catch {
      return false;
    }
  };
  files = files.filter(
    (file) => keep.has(file.path) || file.mtime >= now - maxAgeMs || !remove(file),
  );

  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of [...files].sort((a, b) => a.mtime - b.mtime)) {
    if (total <= maxBytes) break;
    if (keep.has(file.path)) continue;
    if (remove(file)) {
      total -= file.size;
      files = files.filter((item) => item !== file);
    }
  }

  if (existsSync(directory)) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        rmdirSync(join(directory, entry.name));
      } catch {
        // Not empty or in use.
      }
    }
  }
  return {
    deletedFiles,
    deletedBytes,
    scrubbedEvents,
    remainingFiles: files.length,
    remainingBytes: total,
  };
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
