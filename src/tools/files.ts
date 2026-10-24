import { promises as fs } from "node:fs";
import path from "node:path";
import { type PathProtectionConfig, protectedPathProblem } from "./protected-paths.js";
import { listProjectFiles } from "./walk.js";

export async function safePath(
  root: string,
  relativePath = ".",
  allowMissing = false,
): Promise<string> {
  const resolvedRoot = await fs.realpath(root);
  const target = path.resolve(resolvedRoot, relativePath);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`))
    throw new Error("Path escapes the exposed project directory.");

  try {
    const resolvedTarget = await fs.realpath(target);
    if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`))
      throw new Error("Path escapes the exposed project directory.");
    return resolvedTarget;
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    let ancestor = path.dirname(target);
    while (ancestor !== resolvedRoot && ancestor.startsWith(`${resolvedRoot}${path.sep}`)) {
      try {
        const resolvedAncestor = await fs.realpath(ancestor);
        if (
          resolvedAncestor !== resolvedRoot &&
          !resolvedAncestor.startsWith(`${resolvedRoot}${path.sep}`)
        )
          throw new Error("Path escapes the exposed project directory.");
        return path.join(resolvedAncestor, path.relative(ancestor, target));
      } catch (ancestorError) {
        if ((ancestorError as NodeJS.ErrnoException).code !== "ENOENT") throw ancestorError;
        ancestor = path.dirname(ancestor);
      }
    }
    return path.join(resolvedRoot, path.relative(resolvedRoot, target));
  }
}

export interface FileEntry {
  path: string;
  type: "file" | "directory";
}
export interface FilePatch {
  search: string;
  replace: string;
  count?: number;
}

export async function listFiles(root: string): Promise<FileEntry[]> {
  const { files } = await listProjectFiles(root);
  const directories = new Set<string>();
  for (const file of files) {
    let slash = file.lastIndexOf("/");
    while (slash > 0) {
      directories.add(file.slice(0, slash));
      slash = file.lastIndexOf("/", slash - 1);
    }
  }
  const entries: FileEntry[] = [
    ...[...directories].map((entryPath): FileEntry => ({ path: entryPath, type: "directory" })),
    ...files.map((entryPath): FileEntry => ({ path: entryPath, type: "file" })),
  ];
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function readFile(root: string, relativePath: string): Promise<string> {
  return safePath(root, relativePath).then((target) => fs.readFile(target, "utf8"));
}

export type FileChange =
  | { kind: "write"; path: string; content: string }
  | { kind: "patch"; path: string; patches: FilePatch[] }
  | { kind: "delete"; path: string };

export interface AppliedFileChange {
  kind: FileChange["kind"];
  path: string;
  changed: boolean;
  dryRun?: boolean;
}

interface PreparedFileChange extends AppliedFileChange {
  target: string;
  content?: string;
  /** Exact previous bytes, so rollback restores binary files unchanged. */
  previous?: Buffer;
  previousContent?: string;
  existed: boolean;
  mode?: number;
}

function occurrenceLines(content: string, search: string, limit = 5): number[] {
  const lines: number[] = [];
  for (let from = 0; lines.length < limit; ) {
    const index = content.indexOf(search, from);
    if (index === -1) break;
    lines.push(content.slice(0, index).split("\n").length);
    from = index + Math.max(1, search.length);
  }
  return lines;
}

function trigrams(value: string): Set<string> {
  const text = value.trim().toLowerCase().replace(/\s+/g, " ");
  const grams = new Set<string>();
  for (let index = 0; index + 3 <= text.length; index += 1) grams.add(text.slice(index, index + 3));
  return grams;
}

/** Lines most similar to the first line of the missing text, to help the agent correct it. */
function closestLines(content: string, search: string, limit = 3): string[] {
  const first = search.split("\n").find((line) => line.trim().length >= 3);
  if (!first) return [];
  const wanted = trigrams(first);
  if (wanted.size === 0) return [];
  const scored: Array<{ line: number; text: string; score: number }> = [];
  for (const [index, text] of content.split("\n").entries()) {
    if (text.trim().length < 3) continue;
    const grams = trigrams(text);
    let shared = 0;
    for (const gram of wanted) if (grams.has(gram)) shared += 1;
    const score = shared / (wanted.size + grams.size - shared);
    if (score >= 0.3) scored.push({ line: index + 1, text: text.trim().slice(0, 120), score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.line - b.line)
    .slice(0, limit)
    .map((item) => `line ${item.line}: ${item.text}`);
}

/** Writes via a temporary file in the same directory and renames it into place. */
async function writeFileAtomic(
  target: string,
  data: string | Buffer,
  mode?: number,
): Promise<void> {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.agent-dir-${process.pid}-${Date.now()}.tmp`,
  );
  try {
    await fs.writeFile(temporary, data, mode === undefined ? undefined : { mode });
    if (mode !== undefined) await fs.chmod(temporary, mode);
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

function describePatchProblems(
  content: string,
  displayPath: string,
  patch: FilePatch,
  occurrences: number,
): string | undefined {
  if (occurrences === 0) {
    const hints = closestLines(content, patch.search);
    return `Patch text was not found in '${displayPath}'.${
      hints.length ? ` Closest lines: ${hints.join("; ")}.` : ""
    } Re-read the file with read_range and copy the text exactly; whitespace matters.`;
  }
  if (patch.count === undefined && occurrences > 1) {
    return `Patch text occurs ${occurrences} times in '${displayPath}' (lines ${occurrenceLines(content, patch.search).join(", ")}${
      occurrences > 5 ? ", ..." : ""
    }). Add surrounding context so it matches once, or set count to replace the first N occurrences.`;
  }
  return undefined;
}

export async function applyFileChanges(
  root: string,
  changes: FileChange[],
  dryRun = false,
  protection?: PathProtectionConfig,
): Promise<AppliedFileChange[]> {
  if (changes.length === 0) throw new Error("At least one change is required.");

  const resolvedRoot = await fs.realpath(root);
  const seen = new Set<string>();
  const prepared: PreparedFileChange[] = [];

  for (const change of changes) {
    if (typeof change.path !== "string" || !change.path)
      throw new Error("Every change needs a non-empty string path.");
    let target: string;
    try {
      target = await safePath(resolvedRoot, change.path, change.kind === "write");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error(`'${change.path}' does not exist.`);
      throw error;
    }
    const protectedProblem = protectedPathProblem(path.relative(resolvedRoot, target), protection);
    if (protectedProblem) throw new Error(protectedProblem);
    if (seen.has(target)) throw new Error(`Duplicate change path: '${change.path}'.`);
    seen.add(target);

    let previous: Buffer | undefined;
    let mode: number | undefined;
    try {
      previous = await fs.readFile(target);
      mode = (await fs.stat(target)).mode & 0o7777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || change.kind !== "write")
        throw error;
    }
    const existed = previous !== undefined;
    const base = {
      kind: change.kind,
      path: change.path,
      target,
      existed,
      ...(previous === undefined ? {} : { previous, previousContent: previous.toString("utf8") }),
      ...(mode === undefined ? {} : { mode }),
      ...(dryRun ? { dryRun: true } : {}),
    };

    if (change.kind === "write") {
      prepared.push({
        ...base,
        content: change.content,
        changed: previous === undefined || !previous.equals(Buffer.from(change.content, "utf8")),
      });
      continue;
    }

    if (change.kind === "patch") {
      if (!previous) throw new Error(`'${change.path}' does not exist.`);
      if (previous.includes(0))
        throw new Error(`'${change.path}' looks like a binary file and cannot be patched.`);
      if (change.patches.length === 0) throw new Error("At least one patch is required.");
      const original = previous.toString("utf8");
      let content = original;
      for (const patch of change.patches) {
        if (!patch.search) throw new Error("Patch search text cannot be empty.");
        const occurrences = content.split(patch.search).length - 1;
        const problem = describePatchProblems(content, change.path, patch, occurrences);
        if (problem) throw new Error(problem);
        const count = patch.count ?? 1;
        if (!Number.isInteger(count) || count < 1)
          throw new Error("Patch count must be a positive integer.");
        if (occurrences < count)
          throw new Error(
            `Patch text occurs ${occurrences} time(s), but ${count} replacement(s) were requested.`,
          );
        let offset = 0;
        for (let i = 0; i < count; i++) {
          const index = content.indexOf(patch.search, offset);
          content =
            content.slice(0, index) + patch.replace + content.slice(index + patch.search.length);
          offset = index + patch.replace.length;
        }
      }
      prepared.push({ ...base, content, changed: content !== original });
      continue;
    }

    if (!previous) throw new Error(`'${change.path}' does not exist.`);
    prepared.push({ ...base, changed: true });
  }

  const strip = ({
    target: _target,
    previous: _previous,
    mode: _mode,
    ...change
  }: PreparedFileChange) => change;
  if (dryRun) return prepared.map(strip);

  const applied: PreparedFileChange[] = [];
  try {
    for (const change of prepared) {
      if (!change.changed) {
        applied.push(change);
        continue;
      }
      if (change.kind === "delete") await fs.unlink(change.target);
      else {
        await fs.mkdir(path.dirname(change.target), { recursive: true });
        await writeFileAtomic(change.target, change.content ?? "", change.mode);
      }
      applied.push(change);
    }
  } catch (error) {
    for (const change of applied.reverse()) {
      try {
        if (change.existed && change.previous !== undefined) {
          await fs.mkdir(path.dirname(change.target), { recursive: true });
          await writeFileAtomic(change.target, change.previous, change.mode);
        } else {
          await fs.rm(change.target, { force: true });
        }
      } catch {
        // Preserve the original error; rollback is best effort.
      }
    }
    throw new Error(
      `Atomic file change failed; completed changes were rolled back. ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return prepared.map(strip);
}
