import { matchesGlob } from "./glob.js";
import { runSearch, type SearchBackend, type SearchRequest } from "./search.js";
import { listProjectFiles } from "./walk.js";

export interface SearchItem {
  path: string;
  line: number;
  column: number;
  text: string;
  before?: string[];
  after?: string[];
}
export interface SymbolMatch extends SearchItem {
  symbol: string;
  kind: string;
}

/** Every search tool returns an object so truncation is always reported. */
export interface SearchEnvelope<T extends SearchItem = SearchItem> {
  items: T[];
  returned: number;
  truncated: boolean;
  /** Why results were cut: the result-count limit or the byte budget. */
  truncationReason?: "maxResults" | "maxBytes";
  backend: SearchBackend;
  /** True when the file list or search was cut short, so results may be missing. */
  incomplete?: boolean;
  notes?: string[];
}

export interface SearchCodeOptions {
  regex?: boolean;
  caseSensitive?: boolean;
  paths?: string[];
  globs?: string[];
  context?: number;
  maxResults?: number;
  maxBytes?: number;
  includeGenerated?: boolean;
  backend?: SearchBackend;
}

const DEFAULT_OUTPUT_BYTES = 8_000;
const MAX_TEXT_BYTES = 512;
const MAX_CONTEXT_BYTES = 256;
const ENVELOPE_OVERHEAD_BYTES = 200;

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const marker = "\n…[truncated]";
  let end = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  while (end > 0) {
    const candidate = `${value.slice(0, end)}${marker}`;
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) return candidate;
    end -= Math.max(1, Math.ceil((Buffer.byteLength(candidate, "utf8") - maxBytes) / 2));
  }
  return marker.trim().slice(0, maxBytes);
}

function fitItems<T extends SearchItem>(items: T[], maxBytes: number): { kept: T[]; cut: boolean } {
  const kept: T[] = [];
  let bytes = ENVELOPE_OVERHEAD_BYTES + 2;
  for (const item of items) {
    const skeleton = { ...item, text: "", before: undefined, after: undefined };
    const baseBytes = Buffer.byteLength(JSON.stringify(skeleton), "utf8");
    const separator = kept.length ? 1 : 0;
    const textBudget = maxBytes - bytes - separator - baseBytes;
    if (textBudget <= 0) return { kept, cut: true };
    const perMatch = Math.min(MAX_TEXT_BYTES, Math.max(64, Math.floor(maxBytes / 4)));
    const candidate: T = {
      ...item,
      text: truncateUtf8(item.text, Math.min(textBudget, perMatch)),
    };
    const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
    if (bytes + separator + candidateBytes > maxBytes) return { kept, cut: true };
    kept.push(candidate);
    bytes += separator + candidateBytes;
  }
  return { kept, cut: false };
}

function toItem(match: {
  path: string;
  line: number;
  column: number;
  raw: string;
  before: string[];
  after: string[];
}): SearchItem {
  const item: SearchItem = {
    path: match.path,
    line: match.line,
    column: match.column,
    text: match.raw.trim(),
  };
  if (match.before.length)
    item.before = match.before.map((line) => truncateUtf8(line.trim(), MAX_CONTEXT_BYTES));
  if (match.after.length)
    item.after = match.after.map((line) => truncateUtf8(line.trim(), MAX_CONTEXT_BYTES));
  return item;
}

async function search<T extends SearchItem>(
  root: string,
  request: SearchRequest,
  options: { maxBytes?: number; backend?: SearchBackend },
  decorate: (item: SearchItem) => T,
): Promise<SearchEnvelope<T>> {
  const outcome = await runSearch(root, request, options.backend);
  const items = outcome.matches.map((match) => decorate(toItem(match)));
  const fitted = fitItems(items, options.maxBytes ?? DEFAULT_OUTPUT_BYTES);
  const truncated = fitted.cut || outcome.moreAvailable;
  return {
    items: fitted.kept,
    returned: fitted.kept.length,
    truncated,
    ...(truncated
      ? { truncationReason: fitted.cut ? ("maxBytes" as const) : ("maxResults" as const) }
      : {}),
    backend: outcome.backend,
    ...(outcome.incomplete ? { incomplete: true } : {}),
    ...(outcome.notes.length ? { notes: outcome.notes } : {}),
  };
}

export function searchCode(
  root: string,
  query: string,
  options: SearchCodeOptions = {},
): Promise<SearchEnvelope> {
  return search(
    root,
    {
      query,
      regex: options.regex ?? false,
      caseSensitive: options.caseSensitive ?? false,
      paths: options.paths ?? [],
      globs: options.globs ?? [],
      context: Math.min(5, Math.max(0, options.context ?? 0)),
      maxResults: options.maxResults ?? 200,
      includeGenerated: options.includeGenerated ?? false,
    },
    {
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      ...(options.backend ? { backend: options.backend } : {}),
    },
    (item) => item,
  );
}

/** Result of find_files: matching project paths and whether more existed. */
export async function findFiles(
  root: string,
  pattern: string,
  maxResults = 200,
): Promise<{ files: string[]; truncated: boolean }> {
  if (!pattern.trim()) throw new Error("File pattern cannot be empty.");
  const listing = await listProjectFiles(root);
  const matching = listing.files.filter((file) => matchesGlob(pattern, file));
  return { files: matching.slice(0, maxResults), truncated: matching.length > maxResults };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertIdentifier(symbol: string): void {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol))
    throw new Error("Symbol must be a valid identifier.");
}

const MODIFIERS =
  "(?:public|private|protected|internal|static|final|abstract|override|virtual|async|sealed|synchronized|readonly|extern|unsafe|partial|open|data|inline|suspend|export|default|declare)";

/**
 * Definition patterns for common languages (JS/TS, Python, Rust, Go, Java, C#, Kotlin, Swift,
 * Ruby, PHP). They are heuristics; use serena_find_symbol or ast_grep_search for precision.
 * Written to be valid in both JavaScript and Rust regex syntax.
 */
function symbolPattern(symbol: string): string {
  const name = escapeRegex(symbol);
  const start = symbol.startsWith("$") ? "(?:^|[^\\w$])" : "\\b";
  const end = symbol.endsWith("$") ? "(?:[^\\w$]|$)" : "\\b";
  return [
    `(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\*?|class|interface|type|enum|namespace|module|const|let|var)\\s+${name}${end}`,
    `\\b(?:def|class|object|trait|struct|protocol|extension|actor|record|package|impl|fn|func|fun|sub|proc|method)\\s+(?:\\([^)]*\\)\\s*)?(?:self\\.|[A-Za-z_][\\w.]*\\.)?${name}${end}`,
    `^\\s*(?:@[\\w.]+(?:\\([^)]*\\))?\\s*)*(?:${MODIFIERS}\\s+)+[\\w<>\\[\\],.?:*&\\s]*?${start}${name}\\s*[(<=;{:]`,
    `^\\s*(?:(?:get|set|async|static)\\s+)*${name}\\s*(?:<[^>]*>)?\\([^)]*\\)\\s*(?::\\s*[^{;=]+)?\\s*\\{\\s*$`,
  ].join("|");
}

function symbolKind(line: string): string {
  if (/\bclass\b/i.test(line)) return "class";
  if (/\binterface\b/i.test(line)) return "interface";
  if (/\b(?:type|typealias)\b/i.test(line)) return "type";
  if (/\benum\b/i.test(line)) return "enum";
  if (/\b(?:function|def|fn|func|fun|sub|proc)\b/i.test(line)) return "function";
  if (/\b(?:struct|trait|protocol|actor|record|object)\b/i.test(line)) return "type";
  if (/\b(?:const|let|var)\b/i.test(line)) return "variable";
  if (/\)\s*(?::\s*[^{;=]+)?\s*\{\s*$/.test(line) || /\(/.test(line)) return "method";
  return "symbol";
}

export function findSymbol(
  root: string,
  symbol: string,
  options: { maxResults?: number; maxBytes?: number; backend?: SearchBackend } = {},
): Promise<SearchEnvelope<SymbolMatch>> {
  assertIdentifier(symbol);
  return search(
    root,
    {
      query: symbolPattern(symbol),
      regex: true,
      caseSensitive: true,
      paths: [],
      globs: [],
      context: 0,
      maxResults: options.maxResults ?? 100,
      includeGenerated: false,
    },
    {
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      ...(options.backend ? { backend: options.backend } : {}),
    },
    (item) => ({ ...item, symbol, kind: symbolKind(item.text) }),
  );
}

const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;

/**
 * Lexical references: whole-identifier occurrences, case-sensitive (this includes comments,
 * strings and same-named identifiers; it is not semantic).
 */
export function findReferences(
  root: string,
  symbol: string,
  options: { maxResults?: number; maxBytes?: number; backend?: SearchBackend } = {},
): Promise<SearchEnvelope> {
  assertIdentifier(symbol);
  return search(
    root,
    {
      query: symbol,
      regex: false,
      caseSensitive: true,
      paths: [],
      globs: [],
      context: 0,
      maxResults: options.maxResults ?? 200,
      includeGenerated: false,
      accept: (line, index) => {
        const before = line[index - 1];
        const after = line[index + symbol.length];
        return !(before && IDENTIFIER_CHAR.test(before)) && !(after && IDENTIFIER_CHAR.test(after));
      },
    },
    {
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      ...(options.backend ? { backend: options.backend } : {}),
    },
    (item) => item,
  );
}
