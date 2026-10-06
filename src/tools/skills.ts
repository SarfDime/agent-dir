import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { listFiles } from "./files.js";

const SKILL_ROOTS = ["skills", ".agents/skills", ".claude/skills", ".github/skills"];
const MAX_RESOURCES = 512;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

export interface SkillResource {
  uri: string;
  digest: string;
  size: number;
}
export interface SkillEntry {
  uri: string;
  frontmatter: Record<string, unknown> & { name: string; description: string };
  resources: SkillResource[] | "dynamic";
}
interface ParsedSkill {
  entry: SkillEntry;
  resources: Map<string, string>;
}

export async function listSkills(root: string): Promise<SkillEntry[]> {
  return (await discoverSkills(root)).map((skill) => skill.entry);
}
export async function getSkill(root: string, uri: string): Promise<SkillEntry> {
  const skill = (await discoverSkills(root)).find((item) => item.entry.uri === uri);
  if (!skill) throw new Error(`Unknown skill: ${uri}`);
  return skill.entry;
}
export async function readSkillResource(
  root: string,
  uri: string,
): Promise<{ uri: string; mimeType: string; text?: string; blob?: string }> {
  for (const skill of await discoverSkills(root)) {
    const filePath = skill.resources.get(uri);
    if (!filePath) continue;
    const bytes = await fs.readFile(filePath);
    const text = bytes.toString("utf8");
    if (Buffer.from(text, "utf8").equals(bytes)) {
      return { uri, mimeType: mimeTypeFor(filePath), text };
    }
    return { uri, mimeType: mimeTypeFor(filePath), blob: bytes.toString("base64") };
  }
  throw new Error(`Unknown skill resource: ${uri}`);
}
export async function readSkillDirectory(
  root: string,
  uri: string,
): Promise<Array<{ uri: string; name: string; mimeType: string }>> {
  const prefix = "skill://";
  if (!uri.startsWith(prefix) || uri.endsWith("/") || uri === prefix)
    throw new Error(`Unknown skill directory: ${uri}`);
  const relativeDirectory = uri.slice(prefix.length);
  const resolvedRoot = await fs.realpath(root);
  for (const skillRoot of SKILL_ROOTS) {
    const directoryPath = path.join(resolvedRoot, skillRoot, ...relativeDirectory.split("/"));
    const candidate = path.resolve(directoryPath);
    if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${path.sep}`)) continue;
    try {
      const resolvedDirectory = await fs.realpath(candidate);
      if (
        resolvedDirectory !== resolvedRoot &&
        !resolvedDirectory.startsWith(`${resolvedRoot}${path.sep}`)
      )
        continue;
      const stats = await fs.stat(resolvedDirectory);
      if (!stats.isDirectory()) continue;
      const entries = await fs.readdir(resolvedDirectory, { withFileTypes: true });
      return entries
        .map((entry) => {
          const childUri = `${uri}/${entry.name}`;
          return {
            uri: childUri,
            name: entry.name,
            mimeType: entry.isDirectory() ? "inode/directory" : mimeTypeFor(entry.name),
          };
        })
        .sort((a, b) => a.uri.localeCompare(b.uri));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(`Unknown skill directory: ${uri}`);
}

export async function listSkillResources(
  root: string,
): Promise<Array<{ uri: string; name: string; mimeType: string }>> {
  return (await discoverSkills(root)).flatMap((skill) =>
    [...skill.resources.entries()].map(([uri, filePath]) => ({
      uri,
      name: path.basename(filePath),
      mimeType: mimeTypeFor(filePath),
    })),
  );
}

export async function skillResourceUrisForPath(
  root: string,
  relativePath: string,
): Promise<string[]> {
  const resolvedRoot = await fs.realpath(root);
  const target = path.resolve(resolvedRoot, relativePath);
  const matches = new Set<string>();
  for (const skill of await discoverSkills(root)) {
    for (const [uri, filePath] of skill.resources) {
      if (path.resolve(filePath) === target) matches.add(uri);
    }
  }
  return [...matches].sort();
}

async function discoverSkills(root: string): Promise<ParsedSkill[]> {
  const resolvedRoot = await fs.realpath(root);
  const entries = await listFiles(root);
  const skills: ParsedSkill[] = [];

  for (const skillFile of entries.filter(
    (entry) => entry.type === "file" && path.basename(entry.path) === "SKILL.md",
  )) {
    const normalizedSkillFile = skillFile.path.replaceAll(path.sep, "/");
    const skillRoot = SKILL_ROOTS.find(
      (rootName) =>
        normalizedSkillFile === `${rootName}/SKILL.md` ||
        normalizedSkillFile.startsWith(`${rootName}/`),
    );
    if (!skillRoot) continue;

    const skillPath = path.posix.dirname(normalizedSkillFile);
    const relativeSkillPath = path.posix.relative(skillRoot, skillPath);
    if (
      !relativeSkillPath ||
      relativeSkillPath === "." ||
      relativeSkillPath.startsWith("../") ||
      path.posix.isAbsolute(relativeSkillPath)
    )
      continue;

    const markdown = await fs.readFile(path.join(resolvedRoot, skillFile.path), "utf8");
    const parsedFrontmatter = parseFrontmatter(markdown);
    if (!parsedFrontmatter) continue;

    const nameValue = parsedFrontmatter.values.name;
    const descriptionValue = parsedFrontmatter.values.description;
    if (typeof nameValue !== "string" || typeof descriptionValue !== "string") continue;
    if (
      nameValue !== path.posix.basename(skillPath) ||
      !SKILL_NAME_PATTERN.test(nameValue) ||
      nameValue.length > MAX_SKILL_NAME_LENGTH ||
      descriptionValue.length === 0 ||
      descriptionValue.length > MAX_DESCRIPTION_LENGTH
    )
      continue;

    const skillUriPath = relativeSkillPath;
    const skillUri = `skill://${skillUriPath}`;
    const resources: SkillResource[] = [];
    const resourceMap = new Map<string, string>();
    const descendants = entries.filter(
      (entry) =>
        entry.type === "file" &&
        (entry.path === skillFile.path ||
          entry.path.replaceAll(path.sep, "/").startsWith(`${skillPath}/`)),
    );
    if (descendants.length > MAX_RESOURCES) continue;

    let totalBytes = 0;
    for (const resource of descendants) {
      const normalizedResourcePath = resource.path.replaceAll(path.sep, "/");
      const relative = path.posix.relative(skillPath, normalizedResourcePath);
      const uri = `${skillUri}/${relative}`;
      const filePath = path.join(resolvedRoot, resource.path);
      const bytes = await fs.readFile(filePath);
      totalBytes += bytes.length;
      if (totalBytes > MAX_TOTAL_BYTES) {
        totalBytes = -1;
        break;
      }
      resources.push({
        uri,
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        size: bytes.length,
      });
      resourceMap.set(uri, filePath);
    }
    if (totalBytes < 0 || resources.length === 0) continue;

    resources.sort((a, b) => a.uri.localeCompare(b.uri));
    skills.push({
      entry: {
        uri: `${skillUri}/SKILL.md`,
        frontmatter: parsedFrontmatter.values as Record<string, unknown> & {
          name: string;
          description: string;
        },
        resources,
      },
      resources: resourceMap,
    });
  }

  return skills.sort((a, b) => a.entry.uri.localeCompare(b.entry.uri));
}

function parseFrontmatter(
  markdown: string,
): { raw: string; values: Record<string, unknown> } | undefined {
  const lines = markdown.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") return undefined;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return undefined;

  const result: Record<string, unknown> = {};
  for (let index = 1; index < end; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim()) continue;
    const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!match) return undefined;
    const key = match[1] ?? "";
    if (Object.hasOwn(result, key)) return undefined;
    const raw = match[2] ?? "";
    result[key] = parseScalar(raw);
  }
  return { raw: lines.slice(1, end).join("\n"), values: result };
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("{") && trimmed.endsWith("}"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function mimeTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".md":
      return "text/markdown";
    case ".json":
      return "application/json";
    case ".yaml":
    case ".yml":
      return "text/yaml";
    case ".js":
    case ".mjs":
    case ".cjs":
    case ".ts":
    case ".mts":
    case ".cts":
      return "text/javascript";
    case ".css":
      return "text/css";
    case ".html":
      return "text/html";
    case ".py":
      return "text/x-python";
    default:
      return "text/plain";
  }
}
