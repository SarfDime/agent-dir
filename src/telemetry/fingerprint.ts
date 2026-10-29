import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_KEY_FILE = join(homedir(), ".config", "agent-dir", "telemetry.key");

let key: Buffer | undefined;
let persistentKeyLoaded = false;

/**
 * Uses a per-installation secret stored next to the configuration so fingerprints stay
 * comparable across sessions on this machine but cannot be confirmed by dictionary guessing.
 * Only called when telemetry is enabled; otherwise an in-memory key is used and nothing is written.
 */
export function usePersistentTelemetryKey(path = DEFAULT_KEY_FILE): void {
  if (persistentKeyLoaded) return;
  persistentKeyLoaded = true;
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (/^[a-f0-9]{64}$/.test(existing)) {
      key = Buffer.from(existing, "hex");
      return;
    }
  } catch {
    // Missing or unreadable: create a new key below.
  }
  try {
    const created = randomBytes(32);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${created.toString("hex")}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(path, 0o600);
    key = created;
  } catch {
    // Keep the in-memory key; telemetry persistence must never affect requests.
  }
}

/** Test hook: forget the loaded key so a different key file can be used. */
export function resetTelemetryKeyForTests(): void {
  key = undefined;
  persistentKeyLoaded = false;
}

function secret(): Buffer {
  key ??= randomBytes(32);
  return key;
}

/** Keyed, non-reversible digest used for every telemetry fingerprint and path/content hash. */
export function telemetryHmac(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([name, item]) => [name, sortKeys(item)]),
    );
  }
  return value;
}

/** JSON with sorted keys, so equal arguments always serialize identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/**
 * Canonical source for an input fingerprint. The output budget (`maxBytes`) does not change
 * what the agent asked for, so it is excluded: the same request with a different budget is a
 * duplicate call.
 */
export function fingerprintInput(toolName: string, argumentsValue: unknown): string {
  const normalized =
    argumentsValue !== null && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)
      ? Object.fromEntries(
          Object.entries(argumentsValue as Record<string, unknown>).filter(
            ([name]) => name !== "maxBytes",
          ),
        )
      : argumentsValue;
  return canonicalJson({ toolName, arguments: normalized });
}
