import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createTelemetryEnvelope } from "./privacy.js";
import type {
  AnonymousTelemetryEvent,
  TelemetryEnvelope,
  TelemetryLevel,
  TelemetryProjectContext,
  TelemetryRuntimeContext,
} from "./types.js";

const DEFAULT_MAX_EVENTS = 500;
const DEFAULT_PERSISTED_EVENTS = 500;
const TELEMETRY_FILE = join(homedir(), ".config", "agent-dir", "telemetry.jsonl");

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

  constructor(options: TelemetryRecorderOptions) {
    this.level = options.level;
    this.maxEvents = Math.max(1, Math.min(options.maxEvents ?? DEFAULT_MAX_EVENTS, 10_000));
    this.runtime = options.runtime;
    this.project = options.project;
    this.persist = options.persist ?? false;
    this.persistPath = options.persistPath ?? TELEMETRY_FILE;
    this.configId = options.configId ?? "default";
    this.sessionId = options.sessionId ?? "default";
    if (this.persist && this.level !== "none") this.loadPersisted();
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
    if (this.persist) this.persistEvent(envelope);
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
            event.configId === this.configId,
        )
        .slice(-Math.min(this.maxEvents, DEFAULT_PERSISTED_EVENTS));
      this.events.push(...persisted);
    } catch {
      // A missing or corrupt telemetry file starts a fresh in-memory buffer.
    }
  }

  private persistEvent(envelope: TelemetryEnvelope): void {
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true, mode: 0o700 });
      appendFileSync(this.persistPath, `${JSON.stringify(envelope)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      chmodSync(this.persistPath, 0o600);
      if (this.events.length === this.maxEvents) {
        const lines = readFileSync(this.persistPath, "utf8").split("\n").filter(Boolean);
        if (lines.length > this.maxEvents) {
          writeFileSync(this.persistPath, `${lines.slice(-this.maxEvents).join("\n")}\n`, {
            encoding: "utf8",
            mode: 0o600,
          });
        }
      }
    } catch {
      // Telemetry persistence must never affect the MCP request path.
    }
  }
}
