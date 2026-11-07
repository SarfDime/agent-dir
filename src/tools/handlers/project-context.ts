import type { CodeGraphIntegration } from "../../codegraph.js";
import { readFile } from "../files.js";
import { projectOverview } from "../metadata.js";
import { detectSearchBackend } from "../search.js";
import { outputBytesArg } from "./arguments.js";
import { truncateText } from "./text.js";
import type { ToolCallOutput } from "./types.js";

interface ProjectContextDependencies {
  root: string;
  allowedScripts: string[];
  allowedCommands: string[];
  blacklistedCommands: string[];
  codeGraph?: CodeGraphIntegration;
  analyticsEnabled: boolean;
  efficiencyModel: (graphAvailable: boolean, analyticsEnabled: boolean) => unknown;
}

export async function handleProjectContext(
  args: Record<string, unknown>,
  {
    root,
    allowedScripts,
    allowedCommands,
    blacklistedCommands,
    codeGraph,
    analyticsEnabled,
    efficiencyModel,
  }: ProjectContextDependencies,
): Promise<ToolCallOutput> {
  const overview = await projectOverview(root);
  let pkg: Record<string, unknown> = { path: "package.json", exists: false };
  try {
    const packageJson = JSON.parse(await readFile(root, "package.json")) as Record<string, unknown>;
    pkg = {
      path: "package.json",
      name: packageJson.name ?? null,
      version: packageJson.version ?? null,
      description: packageJson.description ?? null,
      packageManager: packageJson.packageManager ?? null,
      scripts: packageJson.scripts ?? {},
    };
  } catch {
    // Package metadata is optional; project context remains useful without it.
  }
  const maxBytes = outputBytesArg(args.maxBytes);
  const graphAvailable = (await codeGraph?.capability())?.status === "available";
  const bounded = truncateText(
    JSON.stringify({
      ...overview,
      package: pkg,
      execution: {
        allowedScripts: [...allowedScripts],
        commands: [...allowedCommands],
        blacklistedCommands: [...blacklistedCommands],
      },
      efficiency: efficiencyModel(graphAvailable, analyticsEnabled),
      search: detectSearchBackend(),
    }),
    Math.max(1, maxBytes - 128),
  );
  const payload: Record<string, unknown> = bounded.truncated
    ? { result: bounded.text, truncated: true }
    : (JSON.parse(bounded.text) as Record<string, unknown>);
  return { payload };
}
