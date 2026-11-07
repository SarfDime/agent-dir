import type { PackageManager } from "../../types.js";
import { type BatchOnError, runBatch } from "../batch.js";
import { checkCommand, spawnCapture } from "../commands.js";
import {
  packageScriptArgsProblem,
  packageScriptCapture,
  packageScriptLabel,
  packageScriptProblem,
} from "../package-scripts.js";
import type { CommandPolicyConfig } from "../policy.js";
import { objectArray, outputBytesArg } from "./arguments.js";
import type { ToolCallOutput } from "./types.js";

function scriptRequests(value: unknown): Array<{ script: string; args?: string[] }> {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(
      "scripts must be a non-empty array of script names or { script, args } objects.",
    );
  return value.map((item) => {
    if (typeof item === "string") return { script: item };
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      const request = item as Record<string, unknown>;
      if (typeof request.script === "string")
        return {
          script: request.script,
          ...(request.args === undefined ? {} : { args: request.args as string[] }),
        };
    }
    throw new Error(
      "Each script must be a name or an object with a script name and optional args.",
    );
  });
}

function timeoutMsArg(value: unknown): number {
  if (value === undefined) return 120000;
  if (!Number.isInteger(value) || (value as number) < 1000 || (value as number) > 600000)
    throw new Error("timeoutMs must be an integer between 1000 and 600000.");
  return value as number;
}

function batchOnError(value: unknown, fallback: BatchOnError): BatchOnError {
  if (value === undefined) return fallback;
  if (value === "continue" || value === "stop") return value;
  throw new Error("onError must be 'continue' or 'stop'.");
}

function okExitCodesArg(value: unknown): number[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 8 ||
    value.some((code) => !Number.isInteger(code) || Number(code) < 0 || Number(code) > 255)
  )
    throw new Error("okExitCodes must be 1 to 8 integers between 0 and 255.");
  return value as number[];
}

interface PackageScriptsDependencies {
  root: string;
  allowedScripts: string[];
  packageManager: PackageManager;
  argumentScripts: string[];
}

export async function handlePackageScriptsBatch(
  args: Record<string, unknown>,
  { root, allowedScripts, packageManager, argumentScripts }: PackageScriptsDependencies,
  signal?: AbortSignal,
): Promise<ToolCallOutput> {
  const requested = scriptRequests(args.scripts);
  const timeoutMs = timeoutMsArg(args.timeoutMs);
  if (requested.length > 10)
    throw new Error("run_package_scripts_batch accepts at most 10 scripts per call.");
  return {
    payload: {
      ...(await runBatch(
        requested.map(({ script, args: scriptArgs }) => ({
          label: packageScriptLabel(packageManager, script, scriptArgs ?? []),
          preflight: async () =>
            (await packageScriptProblem(root, script, allowedScripts)) ??
            packageScriptArgsProblem(script, scriptArgs, argumentScripts),
          execute: () =>
            packageScriptCapture(root, script, {
              timeoutMs,
              packageManager,
              ...(scriptArgs?.length ? { args: scriptArgs } : {}),
              ...(signal ? { signal } : {}),
            }),
        })),
        {
          onError: batchOnError(args.onError, "stop"),
          maxBytes: outputBytesArg(args.maxBytes),
          ...(args.maxBytes === undefined ? { successfulOutputLines: 20 } : {}),
        },
      )),
    },
  };
}

interface CommandBatchDependencies {
  root: string;
  allowedScripts: string[];
  allowedCommands: string[];
  blacklistedCommands: string[];
  commandPolicy: CommandPolicyConfig | undefined;
}

export async function handleCommandBatch(
  args: Record<string, unknown>,
  {
    root,
    allowedScripts,
    allowedCommands,
    blacklistedCommands,
    commandPolicy,
  }: CommandBatchDependencies,
  signal?: AbortSignal,
): Promise<ToolCallOutput> {
  const commands = objectArray(args.commands, "commands");
  const timeoutMs = timeoutMsArg(args.timeoutMs);
  if (commands.length > 10)
    throw new Error("run_command_batch accepts at most 10 commands per call.");
  const defaultOkExitCodes = okExitCodesArg(args.okExitCodes);
  return {
    payload: {
      ...(await runBatch(
        commands.map((item) => {
          const command = typeof item.command === "string" ? item.command : "";
          const commandArgs = Array.isArray(item.args) ? (item.args as string[]) : [];
          const okExitCodes = okExitCodesArg(item.okExitCodes) ?? defaultOkExitCodes;
          return {
            label: [command, ...commandArgs.map(String)].join(" "),
            ...(okExitCodes ? { okExitCodes } : {}),
            preflight: () =>
              typeof item.command !== "string"
                ? "command must be a string."
                : checkCommand(root, command, commandArgs, {
                    allowedCommands,
                    blacklistedCommands,
                    allowedScripts,
                    ...(commandPolicy ? { policy: commandPolicy } : {}),
                  }),
            execute: () =>
              spawnCapture(root, command, commandArgs, {
                timeoutMs,
                ...(signal ? { signal } : {}),
              }),
          };
        }),
        {
          onError: batchOnError(args.onError, "continue"),
          maxBytes: outputBytesArg(args.maxBytes),
        },
      )),
    },
  };
}
