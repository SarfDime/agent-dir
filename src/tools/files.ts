import { promises as fs } from "node:fs";
import path from "node:path";

const IGNORED = new Set([".git", "node_modules", ".next", "dist", "build", "coverage"]);

async function safePath(root: string, relativePath = ".", allowMissing = false): Promise<string> {
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

export async function listDir(root: string, relativePath = "."): Promise<FileEntry[]> {
  const resolvedRoot = await fs.realpath(root);
  const directory = await safePath(resolvedRoot, relativePath);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => !IGNORED.has(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({
      path: path.relative(resolvedRoot, path.join(directory, entry.name)),
      type: entry.isDirectory() ? "directory" : "file",
    }));
}

export async function listDirs(
  root: string,
  relativePaths: string[],
): Promise<Array<{ path: string; entries: FileEntry[] }>> {
  if (relativePaths.length === 0) throw new Error("At least one directory is required.");
  return Promise.all(
    relativePaths.map(async (relativePath) => ({
      path: relativePath,
      entries: await listDir(root, relativePath),
    })),
  );
}

export function readFile(root: string, relativePath: string): Promise<string> {
  return safePath(root, relativePath).then((target) => fs.readFile(target, "utf8"));
}

export async function writeFile(
  root: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const target = await safePath(root, relativePath, true);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

export async function patchFiles(
  root: string,
  files: Array<{ path: string; patches: FilePatch[] }>,
): Promise<Array<{ path: string; applied: number; content: string }>> {
  if (files.length === 0) throw new Error("At least one file is required.");
  return Promise.all(
    files.map(({ path: relativePath, patches }) => patchFile(root, relativePath, patches)),
  );
}

export async function patchFile(
  root: string,
  relativePath: string,
  patches: FilePatch[],
): Promise<{ path: string; applied: number; content: string }> {
  if (patches.length === 0) throw new Error("At least one patch is required.");
  const target = await safePath(root, relativePath);
  let content = await fs.readFile(target, "utf8");
  for (const patch of patches) {
    if (!patch.search) throw new Error("Patch search text cannot be empty.");
    const occurrences = content.split(patch.search).length - 1;
    if (occurrences === 0) throw new Error(`Patch text was not found in '${relativePath}'.`);
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
  await fs.writeFile(target, content, "utf8");
  return { path: relativePath, applied: patches.length, content };
}

export async function deleteFile(root: string, relativePath: string): Promise<void> {
  const target = await safePath(root, relativePath);
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error("delete_file only deletes files.");
  await fs.unlink(target);
}
