import { promises as fs } from "node:fs";
import path from "node:path";
import { listFiles } from "./files.js";
import { gitStatus } from "./git.js";

export interface ProjectOverview {
  root: string;
  files: number;
  directories: number;
  languages: Array<{ extension: string; files: number }>;
  packageManagers: string[];
  projectFiles: string[];
  git: { available: boolean; branch?: string; clean?: boolean };
}

export async function fileInfo(
  root: string,
  relativePath: string,
): Promise<Record<string, unknown>> {
  const resolvedRoot = await fs.realpath(root);
  const target = path.resolve(resolvedRoot, relativePath);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`))
    throw new Error("Path escapes the exposed project directory.");
  const stat = await fs.lstat(target);
  return {
    path: relativePath,
    type: stat.isDirectory()
      ? "directory"
      : stat.isFile()
        ? "file"
        : stat.isSymbolicLink()
          ? "symlink"
          : "other",
    size: stat.size,
    mode: (stat.mode & 0o777).toString(8),
    modifiedAt: stat.mtime.toISOString(),
    createdAt: stat.birthtime.toISOString(),
  };
}

export async function packageInfo(root: string): Promise<Record<string, unknown>> {
  const packagePath = path.join(await fs.realpath(root), "package.json");
  try {
    const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8")) as Record<
      string,
      unknown
    >;
    return {
      path: "package.json",
      name: packageJson.name ?? null,
      version: packageJson.version ?? null,
      description: packageJson.description ?? null,
      packageManager: packageJson.packageManager ?? null,
      engines: packageJson.engines ?? null,
      scripts: packageJson.scripts ?? {},
      dependencies: packageJson.dependencies ?? {},
      devDependencies: packageJson.devDependencies ?? {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { path: "package.json", exists: false };
    throw new Error("package.json exists but is not valid JSON.");
  }
}

export async function projectOverview(root: string): Promise<ProjectOverview> {
  const entries = await listFiles(root);
  const files = entries.filter((entry) => entry.type === "file");
  const directories = entries.filter((entry) => entry.type === "directory");
  const counts = new Map<string, number>();
  for (const file of files) {
    const extension = path.extname(file.path).toLowerCase() || "[no extension]";
    counts.set(extension, (counts.get(extension) ?? 0) + 1);
  }
  const rootEntries = await fs.readdir(await fs.realpath(root));
  const packageManagerPairs: Array<[string, string]> = [
    ["package-lock.json", "npm"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["Cargo.lock", "cargo"],
    ["go.sum", "go"],
    ["poetry.lock", "poetry"],
    ["uv.lock", "uv"],
  ];
  const packageManagers = packageManagerPairs
    .filter(([file]) => rootEntries.includes(file))
    .map(([, manager]) => manager);
  const projectFiles = rootEntries.filter((name) =>
    /^(README|LICENSE|CONTRIBUTING|CHANGELOG)(?:\.|$)|^(package|tsconfig|pyproject|Cargo|go\.mod)/i.test(
      name,
    ),
  );
  let git: ProjectOverview["git"] = { available: false };
  try {
    const status = await gitStatus(root);
    if (status.exitCode === 0) {
      const firstLine = status.stdout.split(/\r?\n/)[0] ?? "";
      const branch = firstLine.match(/^##\s+(.+?)(?:\.\.\.|$)/)?.[1];
      git = {
        available: true,
        ...(branch ? { branch } : {}),
        clean: status.stdout.split(/\r?\n/).filter(Boolean).length <= 1,
      };
    }
  } catch {
    git = { available: false };
  }
  return {
    root,
    files: files.length,
    directories: directories.length,
    languages: [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([extension, count]) => ({ extension, files: count })),
    packageManagers,
    projectFiles,
    git,
  };
}
