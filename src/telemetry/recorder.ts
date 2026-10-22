import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createTelemetryEnvelope } from "./privacy.js";
import { pruneTelemetry, telemetrySessionPath } from "./storage.js";
import type {
  AnonymousTelemetryEvent,
  TelemetryEnvelope,
  TelemetryLevel,
  TelemetryProjectContext,
  TelemetryRuntimeContext,
} from "./types.js";

const DEFAULT_MAX_EVENTS = 500;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface TelemetryRecorderOptions {
  level: TelemetryLevel;
  maxEvents?: number;
  runtime?: TelemetryRuntimeContext;
  project?: TelemetryProjectContext;
  persist?: boolean;
  persistPath?: string;
  configId?: string;
  sessionId?: string;
}

export class TelemetryRecorder {
  private readonly level: TelemetryLevel;
  private readonly maxEvents: number;
  private readonly runtime: TelemetryRuntimeContext | undefined;
  private readonly project: TelemetryProjectContext | undefined;
  private readonly events: TelemetryEnvelope[] = [];
  private readonly persist: boolean;
  private readonly persistPath: string;
  private readonly configId: string;
  private readonly sessionId: string;
  private readonly defaultLocation: boolean;
  private lastPrune = 0;
  private fileReady = false;

  constructor(options: TelemetryRecorderOptions) {
    this.level = options.level;
    this.maxEvents = Math.max(1, Math.min(options.maxEvents ?? DEFAULT_MAX_EVENTS, 10_000));
    this.runtime = options.runtime;
    this.project = options.project;
    this.persist = options.persist ?? false;
    this.configId = options.configId ?? "default";
    this.sessionId = options.sessionId ?? randomUUID();
    this.persistPath = options.persistPath ?? telemetrySessionPath(this.configId, this.sessionId);
    this.defaultLocation = options.persistPath === undefined;
    if (this.persist && this.level !== "none") {
      this.maybePrune();
      this.loadPersisted();
    }
  }

  record(
    event: AnonymousTelemetryEvent,
    runtime: TelemetryRuntimeContext | undefined = this.runtime,
    project: TelemetryProjectContext | undefined = this.project,
  ): void {
    if (this.level === "none") return;

    const envelope = createTelemetryEnvelope(
      this.level,
      event,
      runtime,
      project,
      this.configId,
      this.sessionId,
    );

    if (this.events.length >= this.maxEvents) this.events.shift();
    this.events.push(envelope);
    if (this.persist) {
      this.maybePrune();
      this.persistEvent(envelope);
    }
  }

  snapshot(): TelemetryEnvelope[] {
    return structuredClone(this.events);
  }

  clear(): void {
    this.events.length = 0;
    if (!this.persist) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true, mode: 0o700 });
      writeFileSync(this.persistPath, "", { encoding: "utf8", mode: 0o600 });
      chmodSync(this.persistPath, 0o600);
    } catch {
      // Telemetry persistence must never affect the MCP request path.
    }
  }

  get size(): number {
    return this.events.length;
  }

  private loadPersisted(): void {
    try {
      const lines = readFileSync(this.persistPath, "utf8").split("\n").filter(Boolean);
      const persisted = lines
        .map((line) => JSON.parse(line) as TelemetryEnvelope)
        .filter(
          (event) =>
            event &&
            event.schemaVersion === 1 &&
            event.level === this.level &&
            event.configId === this.configId &&
            event.sessionId === this.sessionId,
        )
        .slice(-this.maxEvents);
      this.events.push(...persisted);
    } catch {
      // A missing or corrupt telemetry file starts a fresh in-memory buffer.
    }
  }

  /** Enforces retention (30 days / 100 MB) for the shared store, at most every few hours. */
  private maybePrune(): void {
    if (!this.persist || this.level === "none" || !this.defaultLocation) return;
    const now = Date.now();
    if (now - this.lastPrune < PRUNE_INTERVAL_MS) return;
    this.lastPrune = now;
    try {
      pruneTelemetry({ keep: [this.persistPath] });
    } catch {
      // Retention must never affect the MCP request path.
    }
  }

  private persistEvent(envelope: TelemetryEnvelope): void {
    const line = `${JSON.stringify(envelope)}\n`;
    // Directory creation and chmod happen once; if the file disappears (for example after
    // `telemetry reset`), retry once with full setup.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (!this.fileReady) mkdirSync(dirname(this.persistPath), { recursive: true, mode: 0o700 });
        appendFileSync(this.persistPath, line, { encoding: "utf8", mode: 0o600 });
        if (!this.fileReady) {
          chmodSync(this.persistPath, 0o600);
          this.fileReady = true;
        }
        return;
      } catch {
        // Telemetry persistence must never affect the MCP request path.
        this.fileReady = false;
      }
    }
  }
}
