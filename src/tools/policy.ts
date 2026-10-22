import path from "node:path";

/**
 * Argument-aware command guardrails.
 *
 * These rules catch common accidents and bypasses of the executable allowlist (global options
 * placed before a subcommand, registry publishing, remote code execution helpers, and execution
 * modes hidden in arguments). They are guardrails, NOT a security boundary: an agent that may run
 * an interpreter or write project files can still run arbitrary code. See SECURITY.md.
 */
export interface CommandPolicyRule {
  /** When set, only these first subcommands are allowed for the executable. */
  allowSubcommands?: string[];
  /** First subcommand, or `first second` pair, that is never allowed. */
  denySubcommands?: string[];
  /** Options (matched as `--name` or `--name=value`) that are never allowed. */
  denyOptions?: string[];
}

export interface CommandPolicyConfig {
  /** Extra per-executable rules, applied after the built-in guardrails. */
  rules?: Record<string, CommandPolicyRule>;
  /** Built-in guardrails are on by default; set to false to disable them explicitly. */
  builtinGuardrails?: boolean;
}

export interface PolicyContext {
  root: string;
  /** Package scripts the profile allows; used to keep `npm run` consistent with the scripts tool. */
  allowedScripts?: string[];
  policy?: CommandPolicyConfig;
}

/** Validates a user-supplied `commandPolicy` object from a profile. */
export function isCommandPolicy(value: unknown): value is CommandPolicyConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  if (policy.builtinGuardrails !== undefined && typeof policy.builtinGuardrails !== "boolean")
    return false;
  if (policy.rules === undefined) return true;
  if (policy.rules === null || typeof policy.rules !== "object" || Array.isArray(policy.rules))
    return false;
  const strings = (item: unknown): boolean =>
    item === undefined || (Array.isArray(item) && item.every((entry) => typeof entry === "string"));
  return Object.values(policy.rules as Record<string, unknown>).every((rule) => {
    if (rule === null || typeof rule !== "object" || Array.isArray(rule)) return false;
    const record = rule as Record<string, unknown>;
    return (
      strings(record.allowSubcommands) &&
      strings(record.denySubcommands) &&
      strings(record.denyOptions)
    );
  });
}

/** Scripts whose names suggest they rewrite files (formatters and fixers). */
export function mutatingScripts(scripts: string[]): string[] {
  return scripts.filter((script) => /(^|[:_-])(fix|write|format|fmt)($|[:_-])/i.test(script));
}

export function mutatingScriptsWarning(scripts: string[]): string | undefined {
  const names = mutatingScripts(scripts);
  if (names.length === 0) return undefined;
  return `These allowed scripts appear to modify files: ${names.join(", ")}. They run outside apply_changes, so protected-path checks do not apply to what they write.`;
}

const GLOBAL_VALUE_OPTIONS: Record<string, string[]> = {
  git: [
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace",
    "--exec-path",
    "--config-env",
    "--super-prefix",
    "--attr-source",
  ],
  npm: [
    "--prefix",
    "-C",
    "--workspace",
    "-w",
    "--registry",
    "--userconfig",
    "--globalconfig",
    "--cache",
    "--loglevel",
    "--otp",
  ],
  pnpm: ["-C", "--dir", "--filter", "-F", "--reporter", "--loglevel"],
  yarn: ["--cwd"],
  bun: ["--cwd", "--config", "-c"],
};

export interface GlobalOption {
  name: string;
  value?: string;
}

/**
 * Splits leading global options (those placed before the subcommand) from the rest of the
 * arguments, so `git -C . push` and `npm --prefix x publish` are seen as `push` and `publish`.
 */
export function stripGlobalOptions(
  command: string,
  args: string[],
): { rest: string[]; options: GlobalOption[] } {
  const valueOptions = new Set(GLOBAL_VALUE_OPTIONS[command] ?? []);
  if (valueOptions.size === 0) return { rest: args, options: [] };
  const options: GlobalOption[] = [];
  let index = 0;
  while (index < args.length) {
    const token = args[index] as string;
    if (token === "--" || !token.startsWith("-") || token === "-") break;
    const equals = token.indexOf("=");
    if (token.startsWith("--") && equals > 2) {
      options.push({ name: token.slice(0, equals), value: token.slice(equals + 1) });
      index += 1;
      continue;
    }
    if (valueOptions.has(token)) {
      const value = args[index + 1];
      options.push(value === undefined ? { name: token } : { name: token, value });
      index += 2;
      continue;
    }
    // Attached short form such as `-cfoo=bar` or `-Cdir`.
    if (/^-[a-zA-Z]./.test(token) && valueOptions.has(token.slice(0, 2))) {
      options.push({ name: token.slice(0, 2), value: token.slice(2) });
      index += 1;
      continue;
    }
    options.push({ name: token });
    index += 1;
  }
  return { rest: args.slice(index), options };
}

/** True when a blacklist entry (space-separated tokens) matches the start of an invocation. */
export function matchesBlacklistEntry(entry: string, invocation: string[]): boolean {
  const tokens = entry.trim().split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((token, index) => invocation[index] === token);
}

/** The raw invocation plus the invocation with global options removed. */
export function blacklistCandidates(command: string, args: string[]): string[][] {
  const { rest } = stripGlobalOptions(command, args);
  const raw = [command, ...args];
  return rest.length === args.length ? [raw] : [raw, [command, ...rest]];
}

const UNSAFE_GIT_CONFIG =
  /^(alias\.|core\.(sshcommand|pager|editor|fsmonitor|hookspath|askpass|gitproxy|attributesfile)|credential\.|diff\.external|diff\..*\.(command|textconv)|merge\..*\.driver|filter\..*\.(clean|smudge|process)|gpg\.|sequence\.editor|uploadpack\.|receive\.|protocol\.|url\.|http\.|sendemail\.|difftool\.|mergetool\.|submodule\.|include\.|includeif\.)/i;

const GIT_CONFIG_READ_FLAGS = new Set([
  "--get",
  "--get-all",
  "--get-regexp",
  "--list",
  "-l",
  "--show-origin",
  "--show-scope",
  "--name-only",
]);
const GIT_CONFIG_WRITE_FLAGS = new Set([
  "--unset",
  "--unset-all",
  "--add",
  "--replace-all",
  "--edit",
  "-e",
  "--rename-section",
  "--remove-section",
  "--file",
  "-f",
]);

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const REGISTRY_MUTATIONS = new Set([
  "publish",
  "unpublish",
  "deprecate",
  "dist-tag",
  "owner",
  "access",
  "token",
  "login",
  "logout",
  "adduser",
  "org",
  "team",
  "hook",
]);
const REMOTE_EXECUTION = new Set(["exec", "x", "dlx", "create", "init"]);
const SCRIPT_SHORTHANDS = new Set(["test", "t", "tst", "start", "stop", "restart"]);

const GH_DENIED: string[][] = [
  ["auth", "token"],
  ["repo", "delete"],
  ["secret"],
  ["ssh-key"],
  ["gpg-key"],
  ["codespace", "delete"],
  ["release", "delete"],
  ["extension", "install"],
  ["extension", "exec"],
  ["alias", "set"],
  ["alias", "import"],
];
const GH_API_MUTATING = new Set(["-f", "-F", "--field", "--raw-field", "--input"]);

const FIND_EXECUTION = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);

function hasOption(args: string[], name: string): boolean {
  return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function guardrail(why: string): string {
  return `Blocked by command guardrail: ${why}. If this is intended, adjust 'commandPolicy' in the profile (see docs/CONFIGURATION.md).`;
}

function insideRoot(root: string, value: string | undefined): boolean {
  if (!value) return false;
  const resolved = path.resolve(root, value);
  const relative = path.relative(path.resolve(root), resolved);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function gitGuardrails(root: string, options: GlobalOption[], rest: string[]): string | undefined {
  for (const option of options) {
    if (option.name === "-c") {
      const key = (option.value ?? "").split("=")[0] ?? "";
      if (UNSAFE_GIT_CONFIG.test(key))
        return guardrail(`git -c ${key} can run programs or rewrite remotes`);
    } else if (option.name === "--config-env") {
      return guardrail("git --config-env can inject executable configuration");
    } else if (option.name === "--exec-path") {
      return guardrail("git --exec-path replaces the git helper programs");
    } else if (
      option.name === "-C" ||
      option.name === "--git-dir" ||
      option.name === "--work-tree"
    ) {
      if (!insideRoot(root, option.value))
        return guardrail(`git ${option.name} must point inside the project root`);
    }
  }
  if (rest.some((arg) => /^--(upload-pack|receive-pack|exec)(=|$)/.test(arg)))
    return guardrail("git --upload-pack/--receive-pack/--exec run a program on the remote side");
  if (rest[0] === "config") {
    const flags = rest.slice(1);
    const writes = flags.some((flag) => GIT_CONFIG_WRITE_FLAGS.has(flag));
    const reads = flags.some((flag) => GIT_CONFIG_READ_FLAGS.has(flag));
    if (writes || !reads)
      return guardrail(
        "git config can create aliases and hooks that execute programs; only read forms (--get, --list) are allowed",
      );
  }
  return undefined;
}

function packageManagerGuardrails(
  command: string,
  rest: string[],
  allowedScripts: string[] | undefined,
): string | undefined {
  const sub = rest[0];
  if (!sub) return undefined;
  if (REGISTRY_MUTATIONS.has(sub))
    return guardrail(
      `${command} ${sub} changes registry or account state; releases run through the release workflow`,
    );
  if (REMOTE_EXECUTION.has(sub))
    return guardrail(`${command} ${sub} downloads and runs remote code`);
  if (allowedScripts !== undefined) {
    const isRun = sub === "run" || sub === "run-script";
    const script = isRun ? rest.slice(1).find((arg) => !arg.startsWith("-")) : sub;
    if ((isRun || SCRIPT_SHORTHANDS.has(sub)) && script && !allowedScripts.includes(script))
      return guardrail(
        `package script '${script}' is not in this profile's allowed scripts; use run_package_scripts_batch`,
      );
  }
  return undefined;
}

function ghGuardrails(rest: string[]): string | undefined {
  if (rest[0] === "api") {
    const args = rest.slice(1);
    const methodIndex = args.findIndex((arg) => arg === "-X" || arg === "--method");
    const method = methodIndex >= 0 ? args[methodIndex + 1] : undefined;
    const inlineMethod = args.find((arg) => arg.startsWith("--method="))?.slice(9);
    const effective = (method ?? inlineMethod ?? "GET").toUpperCase();
    if (effective !== "GET")
      return guardrail(`gh api with method ${effective} can modify remote state`);
    if (args.some((arg) => GH_API_MUTATING.has(arg) || /^--(field|raw-field|input)=/.test(arg)))
      return guardrail("gh api with request fields or input implies a write");
  }
  for (const denied of GH_DENIED) {
    if (denied.every((word, index) => rest[index] === word))
      return guardrail(`gh ${denied.join(" ")} is not available to agents`);
  }
  return undefined;
}

function builtinGuardrails(
  command: string,
  args: string[],
  rest: string[],
  options: GlobalOption[],
  context: PolicyContext,
): string | undefined {
  if (command === "git") return gitGuardrails(context.root, options, rest);
  if (PACKAGE_MANAGERS.has(command))
    return packageManagerGuardrails(command, rest, context.allowedScripts);
  if (command === "gh") return ghGuardrails(rest);
  if (command === "rg") {
    for (const option of ["--pre", "--hostname-bin"]) {
      if (hasOption(args, option))
        return guardrail(`rg ${option} runs an external program for every file`);
    }
  }
  if (command === "find") {
    const blocked = args.find((arg) => FIND_EXECUTION.has(arg));
    if (blocked) return guardrail(`find ${blocked} runs programs or modifies files`);
  }
  return undefined;
}

function userRules(
  command: string,
  args: string[],
  rest: string[],
  rule: CommandPolicyRule | undefined,
): string | undefined {
  if (!rule) return undefined;
  for (const option of rule.denyOptions ?? []) {
    if (hasOption(args, option)) return guardrail(`${command} ${option} is denied by this profile`);
  }
  const first = rest[0];
  const pair = rest.length > 1 ? `${rest[0]} ${rest[1]}` : undefined;
  for (const denied of rule.denySubcommands ?? []) {
    if (denied === first || denied === pair)
      return guardrail(`${command} ${denied} is denied by this profile`);
  }
  if (rule.allowSubcommands && (first === undefined || !rule.allowSubcommands.includes(first)))
    return guardrail(
      `${command} ${first ?? "(no subcommand)"} is not in this profile's allowed subcommands (${rule.allowSubcommands.join(", ")})`,
    );
  return undefined;
}

/** Returns a denial reason, or undefined when the invocation passes the guardrails. */
export function evaluateCommandPolicy(
  command: string,
  args: string[],
  context: PolicyContext,
): string | undefined {
  const { rest, options } = stripGlobalOptions(command, args);
  if (context.policy?.builtinGuardrails !== false) {
    const reason = builtinGuardrails(command, args, rest, options, context);
    if (reason) return reason;
  }
  return userRules(command, args, rest, context.policy?.rules?.[command]);
}
