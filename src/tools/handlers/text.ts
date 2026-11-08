export function truncateText(
  value: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
  if (maxBytes <= 32) return { text: "", truncated: true };
  const buffer = Buffer.from(value, "utf8");
  return {
    text: `${buffer.subarray(0, Math.max(0, maxBytes - 32)).toString("utf8")}\n…[truncated]`,
    truncated: true,
  };
}
