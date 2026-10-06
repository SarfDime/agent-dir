import { promises as fs } from "node:fs";
import path from "node:path";
import { listFiles, safePath } from "./files.js";

const CODE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".json",
  ".kt",
  ".mjs",
  ".mts",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
]);

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}
export interface SymbolMatch extends SearchMatch {
  symbol: string;
  kind: string;
}
export interface ImportMatch extends SearchMatch {
  module: string;
  kind: "import" | "require";
}
export interface ExportMatch extends SearchMatch {
  symbol: string;
  kind: "export";
}

const DEFAULT_OUTPUT_BYTES = 32_000;

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let end = Math.max(0, maxBytes - Buffer.byteLength("\n…[truncated]", "utf8"));
  while (end > 0) {
    const candidate = `${value.slice(0, end)}\n…[truncated]`;
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) return candidate;
    end -= Math.max(1, Math.ceil((Buffer.byteLength(candidate, "utf8") - maxBytes) / 2));
  }
  return "…[truncated]".slice(0, maxBytes);
}

function boundMatches<T extends SearchMatch>(items: T[], maxBytes: number): T[] {
  const bounded: T[] = [];
  let bytes = 2;
  for (const item of items) {
    const base = { ...item, text: "" };
    const baseBytes = Buffer.byteLength(JSON.stringify(base), "utf8");
    const separatorBytes = bounded.length ? 1 : 0;
    const textBudget = maxBytes - bytes - separatorBytes - baseBytes;
    if (textBudget <= 0) break;
    const candidate = { ...item, text: truncateUtf8(item.text, textBudget) };
    const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
    if (bytes + separatorBytes + candidateBytes > maxBytes) break;
    bounded.push(candidate);
    bytes += separatorBytes + candidateBytes;
  }
  return bounded;
}

async function codePaths(root: string): Promise<string[]> {
  return (await listFiles(root))
    .filter(
      (entry) =>
        entry.type === "file" && CODE_EXTENSIONS.has(path.extname(entry.path).toLowerCase()),
    )
    .map((entry) => entry.path);
}

async function readMatches(
  root: string,
  query: string,
  options: { codeOnly?: boolean; regex?: boolean; maxResults?: number } = {},
): Promise<SearchMatch[]> {
  const files = options.codeOnly
    ? await codePaths(root)
    : (await listFiles(root)).filter((entry) => entry.type === "file").map((entry) => entry.path);
  const maxResults = options.maxResults ?? 200;
  const matcher = options.regex ? new RegExp(query, "i") : null;
  const normalizedQuery = query.toLowerCase();
  const matches: SearchMatch[] = [];
  for (const relativePath of files) {
    if (matches.length >= maxResults) break;
    let content: string;
    try {
      content = await fs.readFile(await safePath(root, relativePath), "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length && matches.length < maxResults; index += 1) {
      const line = lines[index] ?? "";
      const hit = matcher ? matcher.exec(line) : line.toLowerCase().indexOf(normalizedQuery);
      if (hit === null || hit === -1) continue;
      const column = typeof hit === "number" ? hit : hit.index;
      matches.push({ path: relativePath, line: index + 1, column: column + 1, text: line.trim() });
    }
  }
  return matches;
}

export async function searchFiles(
  root: string,
  query: string,
  regex = false,
  maxResults = 200,
  maxBytes = DEFAULT_OUTPUT_BYTES,
): Promise<SearchMatch[]> {
  if (!query.trim()) throw new Error("Search query cannot be empty.");
  return boundMatches(await readMatches(root, query, { regex, maxResults }), maxBytes);
}

export async function searchCode(
  root: string,
  query: string,
  regex = false,
  maxResults = 200,
  maxBytes = DEFAULT_OUTPUT_BYTES,
): Promise<SearchMatch[]> {
  if (!query.trim()) throw new Error("Search query cannot be empty.");
  return boundMatches(
    await readMatches(root, query, { codeOnly: true, regex, maxResults }),
    maxBytes,
  );
}

export async function findFiles(
  root: string,
  pattern: string,
  maxResults = 200,
): Promise<string[]> {
  if (!pattern.trim()) throw new Error("File pattern cannot be empty.");
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  const matcher = new RegExp(`^${escaped}$`, "i");
  return (await listFiles(root))
    .filter((entry) => entry.type === "file" && matcher.test(entry.path))
    .map((entry) => entry.path)
    .slice(0, maxResults);
}

export async function findSymbol(
  root: string,
  symbol: string,
  maxResults = 100,
  maxBytes = DEFAULT_OUTPUT_BYTES,
): Promise<SymbolMatch[]> {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol))
    throw new Error("Symbol must be a valid identifier.");
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|class|interface|type|enum|const|let|var)\\s+${escaped}\\b|(?:def|class)\\s+${escaped}\\b|(?:fn|struct|enum|trait)\\s+${escaped}\\b`,
    "i",
  );
  const matches = (
    await readMatches(root, pattern.source, { codeOnly: true, regex: true, maxResults })
  ).map((match) => ({ ...match, symbol, kind: symbolKind(match.text) }));
  return boundMatches(matches, maxBytes);
}

export function findDefinition(
  root: string,
  symbol: string,
  maxResults = 100,
  maxBytes = DEFAULT_OUTPUT_BYTES,
): Promise<SymbolMatch[]> {
  return findSymbol(root, symbol, maxResults, maxBytes);
}

export function findReferences(
  root: string,
  symbol: string,
  maxResults = 200,
  maxBytes = DEFAULT_OUTPUT_BYTES,
): Promise<SearchMatch[]> {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol))
    throw new Error("Symbol must be a valid identifier.");
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return searchCode(root, `\\b${escaped}\\b`, true, maxResults, maxBytes);
}

export async function findImports(
  root: string,
  maxResults = 200,
  maxBytes = DEFAULT_OUTPUT_BYTES,
): Promise<ImportMatch[]> {
  const matches = await readMatches(
    root,
    String.raw`(?:^|[;{}])\\s*import(?:[^"'\\n]*?from\\s*)?["']([^"']+)["']|require\\(\\s*["']([^"']+)["']\\s*\\)`,
    { codeOnly: true, regex: true, maxResults },
  );
  return boundMatches(
    matches.map((match) => {
      const captured = match.text.match(
        /(?:from\s*)?["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/,
      );
      return {
        ...match,
        module: captured?.[1] ?? captured?.[2] ?? match.text,
        kind: /require\s*\(/.test(match.text) ? "require" : "import",
      };
    }),
    maxBytes,
  );
}

export async function findExports(
  root: string,
  maxResults = 200,
  maxBytes = DEFAULT_OUTPUT_BYTES,
): Promise<ExportMatch[]> {
  const matches = await readMatches(
    root,
    String.raw`\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)`,
    { codeOnly: true, regex: true, maxResults },
  );
  return boundMatches(
    matches.map((match) => ({
      ...match,
      symbol:
        match.text.match(
          /(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
        )?.[1] ?? "default",
      kind: "export",
    })),
    maxBytes,
  );
}

function symbolKind(line: string): string {
  if (/\bclass\b/i.test(line)) return "class";
  if (/\binterface\b/i.test(line)) return "interface";
  if (/\btype\b/i.test(line)) return "type";
  if (/\benum\b/i.test(line)) return "enum";
  if (/\b(?:function|def|fn)\b/i.test(line)) return "function";
  if (/\b(?:const|let|var)\b/i.test(line)) return "variable";
  if (/\b(?:struct|trait)\b/i.test(line)) return "type";
  return "symbol";
}
