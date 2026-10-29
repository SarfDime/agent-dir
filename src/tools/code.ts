import { matchesGlob } from "./glob.js";
import { runSearch, type SearchBackend, type SearchRequest } from "./search.js";
import { listProjectFiles } from "./walk.js";

export interface SearchItem {
  path: string;
  line: number;
  /** Present when the match spans several lines. */
  endLine?: number;
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
  /** Candidate files searched, so an empty result can say what it looked at. */
  scanned?: number;
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
  multiline?: boolean;
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
  endLine: number;
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
  if (match.endLine > match.line) item.endLine = match.endLine;
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
  const maxBytes = options.maxBytes ?? DEFAULT_OUTPUT_BYTES;
  // Notes explain empty and truncated results; they come out of the same budget as the items.
  const NOTES_RESERVE_BYTES = 420;
  const fitted = fitItems(items, Math.max(256, maxBytes - NOTES_RESERVE_BYTES));
  const truncated = fitted.cut || outcome.moreAvailable;
  const notes = [...outcome.notes];
  if (fitted.kept.length === 0)
    notes.push(
      `No match for ${describeQuery(request)} in ${outcome.scanned} searched ${
        outcome.scanned === 1 ? "file" : "files"
      }. Literal match unless regex is set; case-insensitive unless caseSensitive is set; generated files, binaries and files over 1 MB are skipped. Check the spelling, widen paths/globs, set includeGenerated, or use find_symbol for definitions.`,
    );
  if (truncated && fitted.cut)
    notes.push(
      `Results were cut by maxBytes after ${fitted.kept.length} of ${items.length} matches; raise maxBytes, lower context, or narrow with paths/globs.`,
    );
  else if (truncated)
    notes.push(
      `More than ${fitted.kept.length} matches exist; narrow with paths/globs or raise maxResults.`,
    );
  return {
    items: fitted.kept,
    returned: fitted.kept.length,
    truncated,
    ...(truncated
      ? { truncationReason: fitted.cut ? ("maxBytes" as const) : ("maxResults" as const) }
      : {}),
    backend: outcome.backend,
    scanned: outcome.scanned,
    ...(outcome.incomplete ? { incomplete: true } : {}),
    ...(notes.length ? { notes } : {}),
  };
}

/** Quotes the query so a note reads clearly whatever the user typed. */
function describeQuery(request: SearchRequest): string {
  const shown = request.query.length > 80 ? `${request.query.slice(0, 77)}...` : request.query;
  return `'${shown}'`;
}

/**
 * Renders a search envelope as grep-style lines instead of JSON. Matched text is what an agent
 * uses; the JSON keys around it were 43% of the payload on a measured sample.
 */
export function formatSearchEnvelope(envelope: SearchEnvelope): string {
  const files = new Set(envelope.items.map((item) => item.path)).size;
  const header = `${envelope.returned} ${
    envelope.returned === 1 ? "match" : "matches"
  } in ${files} ${files === 1 ? "file" : "files"} (${envelope.backend}${
    envelope.truncated ? `, truncated: ${envelope.truncationReason}` : ""
  }${envelope.incomplete ? ", incomplete" : ""})`;
  const lines: string[] = [header];
  for (const item of envelope.items) {
    const range = item.endLine === undefined ? `${item.line}` : `${item.line}-${item.endLine}`;
    lines.push(`${item.path}:${range}:${item.column} ${item.text}`);
    for (const before of item.before ?? []) lines.push(`  | ${before}`);
    for (const after of item.after ?? []) lines.push(`  | ${after}`);
  }
  for (const note of envelope.notes ?? []) lines.push(`note: ${note}`);
  return lines.join("\n");
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
      ...(options.multiline ? { multiline: true } : {}),
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
): Promise<{ files: string[]; truncated: boolean; scanned?: number; note?: string }> {
  if (!pattern.trim()) throw new Error("File pattern cannot be empty.");
  const listing = await listProjectFiles(root);
  const matching = listing.files.filter((file) => matchesGlob(pattern, file));
  const truncated = matching.length > maxResults;
  const files = matching.slice(0, maxResults);
  const note =
    matching.length === 0
      ? `No file matched '${pattern}' among ${listing.files.length} project files. Patterns match project-relative paths; '*' does not cross '/', so use '**' or a bare name such as 'mcp.ts'. Files ignored by .gitignore, node_modules and build output are not listed.`
      : truncated
        ? `Showing ${files.length} of ${matching.length} matching files; raise maxResults or narrow the pattern.`
        : undefined;
  return {
    files,
    truncated,
    scanned: listing.files.length,
    ...(note ? { note } : {}),
  };
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
 * Ruby, PHP). They are lexical heuristics, not a parser.
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
