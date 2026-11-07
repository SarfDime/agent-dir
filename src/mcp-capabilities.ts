import type { CodeGraphCapability } from "./codegraph.js";
import { type GuidanceVariant, guidanceVariant } from "./guidance.js";
import { packageVersion } from "./version.js";
export const INSTRUCTIONS_URI = "agent-dir://instructions";
export const CAPABILITIES_URI = "agent-dir://capabilities";

interface CapabilityDocument {
  version: string;
  tools: string[];
  resources: string[];
  integrations: {
    codegraph: { status: string; detail?: string; tools: string[] };
  };
  execution: {
    allowedScripts: string[];
    commands: string[];
    blacklistedCommands: string[];
  };
  efficiency: {
    preferred: Record<string, unknown>;
    avoid: string[];
  };
  guidanceVariant: GuidanceVariant;
}

interface CapabilityModel {
  document: CapabilityDocument;
  instructions: string;
}

const INLINE_LIST_LIMIT = 12;

function inlineList(items: string[]): string {
  if (items.length === 0) return "none";
  if (items.length <= INLINE_LIST_LIMIT) return items.join(", ");
  return `${items.slice(0, INLINE_LIST_LIMIT).join(", ")} and ${items.length - INLINE_LIST_LIMIT} more`;
}

function bulletList(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- none";
}

/** Preferred workflow and anti-patterns, shared by every capability surface. */
export function efficiencyModel(
  codeGraphAvailable: boolean,
  analyticsEnabled: boolean,
): CapabilityDocument["efficiency"] {
  return {
    preferred: {
      orientation: "project_context",
      ...(codeGraphAvailable ? { structuralAnalysis: "codegraph_explore" } : {}),
      focusedReading: "read_range",
      discovery: ["find_files", "search_code"],
      symbolNavigation: ["find_symbol", "find_references"],
      reading: ["read_range"],
      editing: ["apply_changes"],
      validation: ["targeted package script"],
      ...(analyticsEnabled ? { telemetryAnalytics: "telemetry_analytics" } : {}),
    },
    avoid: [
      "recursive discovery when targeted search is enough",
      "whole-file reads when a line range is enough",
      "full-repository diffs when a path-scoped diff is enough",
      "expensive validation when a targeted check answers the question",
      "generic command execution when a dedicated Agent Dir tool exists, except allowlisted Git operations",
      ...(codeGraphAvailable
        ? ["repeated grep/read loops for structural questions already answered by CodeGraph"]
        : []),
    ],
  };
}

/** The short guidance every client gets; long-form details live in the instructions resource. */
function capabilityInstructions(
  document: CapabilityDocument,
  variant: GuidanceVariant = guidanceVariant(),
): string {
  const graphAvailable = document.integrations.codegraph.status === "available";
  const scripts = inlineList(document.execution.allowedScripts);
  const commands = inlineList(document.execution.commands);
  const blocked = inlineList(document.execution.blacklistedCommands);
  if (variant === "terse") {
    return `Agent Dir is the primary project interface: fewest calls, smallest output. Orient with project_context; locate with search_code or find_files; read with read_range; edit with apply_changes; verify with a targeted package script.${graphAvailable ? " Use codegraph_explore for behaviour, call flow and impact." : ""} Search before reading, read only the range you need, batch related calls, and never repeat a discovery. Scripts: ${scripts}. Commands: ${commands}. Blocked: ${blocked}.`;
  }
  return `Use Agent Dir as the primary project interface: fewest calls, smallest output.

- Orient, package, policy: project_context
- Find files: find_files. Find text or regex: search_code
- Definitions and usages: find_symbol, find_references${graphAvailable ? "\n- Behaviour, call flow, impact: codegraph_explore" : ""}
- Read: read_range. Edit: apply_changes. Check: a targeted package script
- Scripts: run_package_scripts_batch. Commands: run_command_batch

Search before reading, read only the range you need, batch related calls, and never repeat a discovery that already answered the question.

Allowed scripts: ${scripts}
Allowed commands: ${commands}
Blocked prefixes: ${blocked}`;
}

/**
 * One capability model. `initialize`, `server/discover`, the `agent-dir://capabilities` resource
 * and `project_context` all render it, so the four surfaces cannot disagree.
 */
export function capabilityModel(input: {
  tools: string[];
  codeGraph: CodeGraphCapability;
  analyticsEnabled: boolean;
  allowedScripts: string[];
  allowedCommands: string[];
  blacklistedCommands: string[];
}): CapabilityModel {
  const graphAvailable = input.codeGraph.status === "available";
  const variant = guidanceVariant();
  const document: CapabilityDocument = {
    version: packageVersion,
    tools: [...input.tools],
    resources: [INSTRUCTIONS_URI, CAPABILITIES_URI],
    integrations: {
      codegraph: {
        status: input.codeGraph.status,
        ...(input.codeGraph.detail ? { detail: input.codeGraph.detail } : {}),
        tools: graphAvailable ? ["codegraph_explore"] : [],
      },
    },
    execution: {
      allowedScripts: [...input.allowedScripts],
      commands: [...input.allowedCommands],
      blacklistedCommands: [...input.blacklistedCommands],
    },
    efficiency: efficiencyModel(graphAvailable, input.analyticsEnabled),
    guidanceVariant: variant,
  };
  return { document, instructions: capabilityInstructions(document, variant) };
}

/** Long-form instructions served from the `agent-dir://instructions` resource. */
export function buildAgentInstructions(
  document: CapabilityDocument,
  codeGraph: CodeGraphCapability,
  analyticsEnabled = false,
): string {
  const scripts = bulletList(document.execution.allowedScripts);
  const commands = bulletList(document.execution.commands);
  const blacklist = bulletList(document.execution.blacklistedCommands);
  const codeGraphSection =
    codeGraph.status === "available" ||
    codeGraph.status === "startup_failed" ||
    codeGraph.status === "runtime_failed"
      ? "\n\n## CodeGraph\n- CodeGraph is an optional code-intelligence backend for this project.\n- For non-trivial code understanding, call `codegraph_explore` before grep/search/read loops to explain behavior, trace call/data flow, map symbol relationships, or assess change impact. - Treat returned source as already read; do not re-run searches without a concrete gap.\n- Agent Dir pins CodeGraph to this project root; do not attempt to select another project.\n- Current status: " +
        codeGraph.status +
        (codeGraph.detail ? ` — ${codeGraph.detail}` : "") +
        "."
      : "";
  return `# Agent Dir operating instructions\n\nUse Agent Dir as the primary project interface. Optimize for correctness with the minimum necessary tool calls, filesystem reads, command output, and context.\n\n## Efficiency rules\n- Start with the narrowest operation that can answer the question. Do not dump the repository, large files, or full command output when a targeted operation is sufficient.\n- Prefer project_context for initial orientation; it combines project structure, package metadata, and execution policy in one call. \n- Prefer find_files for known filename patterns\n- Prefer search_code before reading files. Search first, then read only the relevant ranges.\n- Use CodeGraph first for non-trivial behavior, call/data flow, relationships, and impact analysis when available. If unavailable or failing, continue with native search tools.\n- Prefer read_range for a bounded section.\n- Prefer apply_changes for atomic writes, patches, and deletions. Do not rewrite an entire file when a small exact replacement is sufficient.\n- Batch related reads, writes, patches, searches, and commands into one tool call when practical.\n- Keep maxResults small unless the initial result is insufficient.\n- Prefer dedicated Agent Dir tools over run_command_batch because dedicated tools return structured, bounded results.\n- Run the narrowest relevant validation after a change; escalate only when required by the task or release workflow.\n- Never repeat a successful discovery/read just because another tool can provide the same information.\n\n## Preferred workflow\n1. Orient: project_context.\n2. Locate: find_files/search_code/find_symbol as appropriate.\n3. Read: read_range.\n4. Modify: apply_changes for atomic writes, patches, and deletes.\n5. Validate: run the narrowest allowed package script that checks the change.\n6. Review: use allowlisted Git commands through run_command_batch when \`git\` is enabled.\n\n## Execution policy\nAllowed package scripts:\n${scripts}\n\nAllowed executables:\n${commands}\n\nBlacklisted command prefixes:\n${blacklist}\n\nOnly use commands from the execution policy. A blacklisted command prefix overrides an allowed executable. Do not attempt to bypass it with shells or alternate executables.\n\n## Git operations\nUse \`run_command_batch\` for Git commands only when \`git\` is in the allowed executable list. The command allowlist and blacklist still apply; avoid destructive operations unless explicitly requested.\n\n## Tool selection\n- Behavior/call-flow/impact: codegraph_explore first when available.\n- Semantic symbol navigation and callers: find_symbol, then find_references; fall back to search_code on empty or failed results.\n- Literal text and regex: search_code.\n- File discovery: project_context > find_files.\n- File reading: read_range.\n- Editing: apply_changes for atomic multi-file edits.\n- Validation: targeted package script > full check/test.\n- Git operations: run_command_batch with the allowed \`git\` executable, respecting the configured blacklist.\n\n${analyticsEnabled ? "\n\n## Telemetry analytics\n- telemetry_analytics is enabled for this connector. Use mode=summary for cross-session metrics, mode=sessions for per-session tool counts and failures, and mode=events for bounded event sequences. Filter by profile/time/session before requesting event detail." : ""}\n\nThe execution policy and this guidance are generated from the running Agent Dir configuration; do not maintain a separate client-specific copy.${codeGraphSection}`;
}

export function capabilities(): Record<string, unknown> {
  return {
    tools: { listChanged: true },
    resources: { listChanged: true, subscribe: true },
    extensions: { "io.modelcontextprotocol/skills": { directoryRead: true } },
  };
}
