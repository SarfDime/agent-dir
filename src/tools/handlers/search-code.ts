import { formatSearchEnvelope, searchCode } from "../code.js";
import { numberArg, outputBytesArg } from "./arguments.js";
import { intArg, optionalStringArray } from "./search-arguments.js";
import type { ToolCallOutput } from "./types.js";

export async function handleSearchCode(
  args: Record<string, unknown>,
  root: string,
): Promise<ToolCallOutput> {
  const paths = optionalStringArray(args.paths, "paths", 20);
  const globs = optionalStringArray(args.globs, "globs", 20);
  const queries = optionalStringArray(args.queries, "queries", 5);
  const maxBytes = outputBytesArg(args.maxBytes);
  const options = {
    regex: args.regex === true,
    caseSensitive: args.caseSensitive === true,
    includeGenerated: args.includeGenerated === true,
    multiline: args.multiline === true,
    context: intArg(args.context, 0, 0, 5, "context"),
    maxResults: numberArg(args.maxResults, 200, 1000),
    ...(paths ? { paths } : {}),
    ...(globs ? { globs } : {}),
  };
  const asText = args.format !== "json";
  if (queries && queries.length > 0) {
    const share = Math.max(1024, Math.floor(maxBytes / queries.length));
    const envelopes = await Promise.all(
      queries.map((query) => searchCode(root, query, { ...options, maxBytes: share })),
    );
    const payload = {
      queries,
      returned: envelopes.reduce((total, envelope) => total + envelope.returned, 0),
      groups: envelopes,
      truncated: envelopes.some((envelope) => envelope.truncated),
    };
    const text = asText
      ? envelopes
          .map((envelope, index) => `## ${queries[index]}\n${formatSearchEnvelope(envelope)}`)
          .join("\n\n")
      : undefined;
    return { payload, ...(text === undefined ? {} : { text }) };
  }
  const envelope = await searchCode(root, String(args.query), { ...options, maxBytes });
  return {
    payload: { ...envelope },
    ...(asText ? { text: formatSearchEnvelope(envelope) } : {}),
  };
}
