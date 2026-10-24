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
  previousContent?: string;
  existed: boolean;
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
    const changeTarget = await safePath(resolvedRoot, change.path, change.kind === "write");
    const protectedProblem = protectedPathProblem(
      path.relative(resolvedRoot, changeTarget),
      protection,
    );
    if (protectedProblem) throw new Error(protectedProblem);
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
