import { isRecord } from "../../validation.js";
import { applyFileChanges } from "../files.js";
import type { PathProtectionConfig } from "../protected-paths.js";
import { invalidateSkillDiscoveryCache, skillResourceUrisForPath } from "../skills.js";
import { invalidateProjectFiles } from "../walk.js";
import { objectArray } from "./arguments.js";
import type { ToolCallOutput } from "./types.js";

type ResourceNotify = (event: { type: "tools" | "prompts" | "resources"; uri?: string }) => void;

async function notifyResourceChange(
  notify: ResourceNotify,
  root: string,
  pathValue: string,
  before: string[],
): Promise<void> {
  const after = await skillResourceUrisForPath(root, pathValue);
  if (before.length === 0 && after.length === 0) return;
  if (before.length === 0 || after.length === 0) {
    notify({ type: "resources" });
    return;
  }
  for (const uri of after) notify({ type: "resources", uri });
}

interface ApplyChangesDependencies {
  root: string;
  pathProtection: PathProtectionConfig | undefined;
  notify: ResourceNotify;
  invalidateReadHistory: (relativePath: string) => Promise<void>;
}

export async function handleApplyChanges(
  args: Record<string, unknown>,
  { root, pathProtection, notify, invalidateReadHistory }: ApplyChangesDependencies,
): Promise<ToolCallOutput> {
  const changes = objectArray(args.changes, "changes").map((change) => {
    const kind = String(change.kind);
    if (kind !== "write" && kind !== "patch" && kind !== "delete")
      throw new Error("Change kind must be write, patch, or delete.");
    if (kind === "write" && typeof change.content !== "string")
      throw new Error("write changes require content.");
    if (kind === "patch" && !Array.isArray(change.patches))
      throw new Error("patch changes require patches.");
    return {
      kind,
      path: String(change.path),
      ...(kind === "write" ? { content: String(change.content) } : {}),
      ...(kind === "patch"
        ? {
            patches: objectArray(change.patches, "patches").map((patch) => ({
              search: String(patch.search),
              replace: String(patch.replace),
              ...(patch.count === undefined ? {} : { count: Number(patch.count) }),
            })),
          }
        : {}),
    } as
      | { kind: "write"; path: string; content: string }
      | {
          kind: "patch";
          path: string;
          patches: Array<{ search: string; replace: string; count?: number }>;
        }
      | { kind: "delete"; path: string };
  });
  const dryRun = args.dryRun === true;
  const affected = [...new Set(changes.map((change) => change.path))];
  const before = new Map<string, string[]>();
  for (const path of affected) before.set(path, await skillResourceUrisForPath(root, path));
  const applied = await applyFileChanges(root, changes, dryRun, pathProtection);
  const payload = {
    items: applied.map((item) => {
      if (!isRecord(item)) return item;
      const { content: _content, previousContent: _previousContent, ...summary } = item;
      return summary;
    }),
    dryRun,
  };
  if (!dryRun) {
    invalidateProjectFiles(root);
    invalidateSkillDiscoveryCache(root);
    for (const path of affected) {
      await invalidateReadHistory(path);
      await notifyResourceChange(notify, root, path, before.get(path) ?? []);
    }
  }
  return { payload };
}
