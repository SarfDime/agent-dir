import type { CodeGraphIntegration } from "../../codegraph.js";
import type { PackageManager } from "../../types.js";
import type { CommandPolicyConfig } from "../policy.js";
import type { PathProtectionConfig } from "../protected-paths.js";
import type { ReadRangeHistory } from "../read.js";
import { handleApplyChanges } from "./apply-changes.js";
import { handleCodeGraphExplore } from "./codegraph-explore.js";
import { handleCommandBatch, handlePackageScriptsBatch } from "./command-batches.js";
import { handleFileInfo } from "./file-info.js";
import { handleFindFiles } from "./find-files.js";
import { handleFindReferences } from "./find-references.js";
import { handleFindSymbol } from "./find-symbol.js";
import { handleProjectContext } from "./project-context.js";
import { handleReadRange } from "./read-range.js";
import { handleSearchCode } from "./search-code.js";
import { handleTelemetryAnalytics } from "./telemetry-analytics.js";
import type { ToolHandler } from "./types.js";

interface ToolHandlerDependencies {
  root: string;
  allowedScripts: string[];
  packageManager: PackageManager;
  allowedCommands: string[];
  blacklistedCommands: string[];
  commandPolicy: CommandPolicyConfig | undefined;
  pathProtection: PathProtectionConfig | undefined;
  argumentScripts: string[];
  notify: (event: { type: "tools" | "prompts" | "resources"; uri?: string }) => void;
  readHistoryForSession: (sessionKey: string) => ReadRangeHistory;
  invalidateReadHistory: (relativePath: string) => Promise<void>;
  codeGraph: CodeGraphIntegration;
  analyticsEnabled: boolean;
  efficiencyModel: (codeGraphAvailable: boolean, analyticsEnabled: boolean) => unknown;
  measureEnvelope: (value: Record<string, unknown>) => number;
}

export function createToolHandlerTable({
  root,
  allowedScripts,
  packageManager,
  allowedCommands,
  blacklistedCommands,
  commandPolicy,
  pathProtection,
  argumentScripts,
  notify,
  readHistoryForSession,
  invalidateReadHistory,
  codeGraph,
  analyticsEnabled,
  efficiencyModel,
  measureEnvelope,
}: ToolHandlerDependencies): Record<string, ToolHandler> {
  return {
    read_range: (args, request) =>
      handleReadRange(args, root, readHistoryForSession(request.sessionKey)),
    apply_changes: (args) =>
      handleApplyChanges(args, { root, pathProtection, notify, invalidateReadHistory }),
    find_files: (args) => handleFindFiles(args, root),
    search_code: (args) => handleSearchCode(args, root),
    find_symbol: (args) => handleFindSymbol(args, root),
    find_references: (args) => handleFindReferences(args, root),
    project_context: (args) =>
      handleProjectContext(args, {
        root,
        allowedScripts,
        allowedCommands,
        blacklistedCommands,
        codeGraph,
        analyticsEnabled,
        efficiencyModel,
      }),
    file_info: (args) => handleFileInfo(args, root),
    run_package_scripts_batch: (args, request) =>
      handlePackageScriptsBatch(
        args,
        { root, allowedScripts, packageManager, argumentScripts },
        request.signal,
      ),
    run_command_batch: (args, request) =>
      handleCommandBatch(
        args,
        { root, allowedScripts, allowedCommands, blacklistedCommands, commandPolicy },
        request.signal,
      ),
    codegraph_explore: (args) => handleCodeGraphExplore(args, codeGraph),
    telemetry_analytics: (args) =>
      handleTelemetryAnalytics(args, analyticsEnabled, measureEnvelope),
  };
}
