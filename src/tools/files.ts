import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

const IGNORED = new Set([".git", "node_modules", ".next", "dist", "build", "coverage"]);

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
  const resolvedRoot = await fs.realpath(root);
  const walk = async (dir: string, depth = 0): Promise<FileEntry[]> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const result: FileEntry[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (IGNORED.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const relative = path.relative(resolvedRoot, full) || entry.name;
      if (entry.isDirectory()) {
        result.push({ path: relative, type: "directory" });
        if (depth < 5) result.push(...(await walk(full, depth + 1)));
      } else result.push({ path: relative, type: "file" });
    }
    return result;
  };
  return walk(resolvedRoot);
}

export function readFile(root: string, relativePath: string): Promise<string> {
  return safePath(root, relativePath).then((target) => fs.readFile(target, "utf8"));
}

export async function readRange(
  root: string,
  relativePath: string,
  startLine: number,
  endLine: number,
  maxBytes = 8_000,
): Promise<{
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  truncated: boolean;
}> {
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  )
    throw new Error("Line range must use positive integers with endLine >= startLine.");
  if (endLine - startLine > 2000) throw new Error("A read range may contain at most 2000 lines.");
  if (!Number.isInteger(maxBytes) || maxBytes < 1)
    throw new Error("maxBytes must be a positive integer.");
  const target = await safePath(root, relativePath);
  const decoder = new StringDecoder("utf8");
  const stream = createReadStream(target, { highWaterMark: 64 * 1024 });
  const output: string[] = [];
  let line = "";
  let lineNumber = 1;
  let outputBytes = 0;
  let truncated = false;
  const marker = "…[truncated]";
  const finishLine = () => {
    if (lineNumber >= startLine && lineNumber <= endLine) {
      if (truncated && line.endsWith(marker)) {
        output.push(line);
        outputBytes = maxBytes;
        lineNumber++;
        line = "";
        return;
      }
      const value = line.endsWith("\r") ? line.slice(0, -1) : line;
      const separatorBytes = output.length ? 1 : 0;
      const remaining = maxBytes - outputBytes - separatorBytes;
      if (Buffer.byteLength(value, "utf8") > remaining) {
        const allowance = Math.max(0, remaining - Buffer.byteLength(marker, "utf8") - 1);
        let clipped = Buffer.from(value, "utf8").subarray(0, allowance).toString("utf8");
        while (clipped.endsWith("\uFFFD")) clipped = clipped.slice(0, -1);
        output.push(`${clipped}\n${marker}`);
        outputBytes = maxBytes;
        truncated = true;
      } else {
        output.push(value);
        outputBytes += separatorBytes + Buffer.byteLength(value, "utf8");
      }
    }
    lineNumber++;
    line = "";
  };
  for await (const chunk of stream) {
    const text = decoder.write(chunk as Buffer);
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf("\n", offset);
      const end = newline === -1 ? text.length : newline;
      if (lineNumber >= startLine && lineNumber <= endLine && !truncated) {
        const piece = text.slice(offset, end);
        const remaining = maxBytes - outputBytes - Buffer.byteLength(line, "utf8");
        if (remaining <= 0) {
          line = "";
          truncated = true;
          break;
        }
        if (Buffer.byteLength(piece, "utf8") > remaining) {
          const allowance = Math.max(0, remaining - Buffer.byteLength(marker, "utf8") - 1);
          let clipped = Buffer.from(piece, "utf8").subarray(0, allowance).toString("utf8");
          while (clipped.endsWith("\uFFFD")) clipped = clipped.slice(0, -1);
          line += `${clipped}\n${marker}`;
          truncated = true;
        } else line += piece;
      }
      if (newline === -1) break;
      finishLine();
      offset = newline + 1;
    }
    if (lineNumber > endLine || truncated) break;
  }
  stream.destroy();
  const tail = decoder.end();
  if (tail && lineNumber >= startLine && lineNumber <= endLine && !truncated) line += tail;
  if (lineNumber >= startLine && lineNumber <= endLine && !(truncated && line.length === 0))
    finishLine();
  return {
    path: relativePath,
    startLine,
    endLine: Math.min(endLine, lineNumber - 1),
    content: output.join("\n"),
    truncated,
  };
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
  previousContent?: string;
  existed: boolean;
}

export async function applyFileChanges(
  root: string,
  changes: FileChange[],
  dryRun = false,
): Promise<AppliedFileChange[]> {
  if (changes.length === 0) throw new Error("At least one change is required.");

  const resolvedRoot = await fs.realpath(root);
  const seen = new Set<string>();
  const prepared: PreparedFileChange[] = [];

  for (const change of changes) {
    const changeTarget = await safePath(resolvedRoot, change.path, change.kind === "write");
    if (seen.has(changeTarget)) throw new Error(`Duplicate change path: '${change.path}'.`);
    seen.add(changeTarget);

    if (change.kind === "write") {
      const target = changeTarget;
      let previousContent: string | undefined;
      let existed = false;
      try {
        previousContent = await fs.readFile(target, "utf8");
        existed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      prepared.push({
        kind: change.kind,
        path: change.path,
        target,
        content: change.content,
        ...(previousContent === undefined ? {} : { previousContent }),
        existed,
        changed: previousContent !== change.content,
        ...(dryRun ? { dryRun: true } : {}),
      });
      continue;
    }

    const target = changeTarget;
    const previousContent = await fs.readFile(target, "utf8");

    if (change.kind === "patch") {
      if (change.patches.length === 0) throw new Error("At least one patch is required.");
      let content = previousContent;
      for (const patch of change.patches) {
        if (!patch.search) throw new Error("Patch search text cannot be empty.");
        const occurrences = content.split(patch.search).length - 1;
        if (occurrences === 0) throw new Error(`Patch text was not found in '${change.path}'.`);
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
      prepared.push({
        kind: change.kind,
        path: change.path,
        target,
        content,
        previousContent,
        existed: true,
        changed: content !== previousContent,
        ...(dryRun ? { dryRun: true } : {}),
      });
      continue;
    }

    prepared.push({
      kind: change.kind,
      path: change.path,
      target,
      previousContent,
      existed: true,
      changed: true,
      ...(dryRun ? { dryRun: true } : {}),
    });
  }

  if (dryRun) return prepared.map(({ target: _target, ...change }) => change);

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
        await fs.writeFile(change.target, change.content ?? "", "utf8");
      }
      applied.push(change);
    }
  } catch (error) {
    for (const change of applied.reverse()) {
      try {
        if (change.existed) {
          await fs.mkdir(path.dirname(change.target), { recursive: true });
          await fs.writeFile(change.target, change.previousContent ?? "", "utf8");
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

  return prepared.map(({ target: _target, ...change }) => change);
}
