export type GuidanceVariant = "table" | "terse" | "search-footer";

export function guidanceVariant(value = process.env.AGENT_DIR_GUIDANCE): GuidanceVariant {
  if (value === "terse" || value === "search-footer") return value;
  return "table";
}
