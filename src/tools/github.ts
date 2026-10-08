import { spawn } from "node:child_process";

export interface GitHubResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

function validateValue(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty.`);
}

function validateNumber(value: number, name: string, max: number): void {
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new Error(`${name} must be an integer between 1 and ${max}.`);
}

function runGh(root: string, args: string[], timeoutMs = 30_000): Promise<GitHubResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { cwd: root, shell: false, env: process.env });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill("SIGTERM");
      reject(new Error(`gh ${args.join(" ")} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ command: ["gh", ...args].join(" "), exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function boundedResult(result: GitHubResult, maxBytes: number): GitHubResult {
  if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 1_000_000)
    throw new Error("maxBytes must be an integer between 1024 and 1000000.");

  const truncate = (value: string, budget: number): string => {
    if (Buffer.byteLength(value, "utf8") <= budget) return value;
    return `${Buffer.from(value, "utf8")
      .subarray(0, Math.max(0, budget - 32))
      .toString("utf8")}\n…[truncated]`;
  };

  let stdoutBudget = Buffer.byteLength(result.stdout, "utf8");
  let stderrBudget = Buffer.byteLength(result.stderr, "utf8");
  while (
    Buffer.byteLength(
      JSON.stringify({
        ...result,
        stdout: truncate(result.stdout, stdoutBudget),
        stderr: truncate(result.stderr, stderrBudget),
      }),
      "utf8",
    ) > maxBytes &&
    (stdoutBudget > 0 || stderrBudget > 0)
  ) {
    if (stdoutBudget >= stderrBudget && stdoutBudget > 0)
      stdoutBudget = Math.max(0, stdoutBudget - 1024);
    else stderrBudget = Math.max(0, stderrBudget - 1024);
  }

  return {
    ...result,
    stdout: truncate(result.stdout, stdoutBudget),
    stderr: truncate(result.stderr, stderrBudget),
  };
}

export function ghRepoView(root: string, maxBytes = 32_000): Promise<GitHubResult> {
  return runGh(root, [
    "repo",
    "view",
    "--json",
    "nameWithOwner,name,owner,defaultBranchRef,isPrivate,isFork,url",
  ]).then((r) => boundedResult(r, maxBytes));
}

export function ghPrList(
  root: string,
  state = "open",
  limit = 20,
  maxBytes = 32_000,
): Promise<GitHubResult> {
  if (!["open", "closed", "merged", "all"].includes(state))
    throw new Error("state must be open, closed, merged, or all.");
  validateNumber(limit, "limit", 100);
  return runGh(root, [
    "pr",
    "list",
    "--state",
    state,
    "--limit",
    String(limit),
    "--json",
    "number,title,state,author,headRefName,baseRefName,isDraft,url,reviewDecision,statusCheckRollup",
  ]).then((r) => boundedResult(r, maxBytes));
}

export function ghPrView(root: string, number: number, maxBytes = 32_000): Promise<GitHubResult> {
  validateNumber(number, "number", 1_000_000_000);
  return runGh(root, [
    "pr",
    "view",
    String(number),
    "--json",
    "number,title,body,state,author,headRefName,baseRefName,isDraft,mergeable,reviewDecision,statusCheckRollup,reviewRequests,latestReviews,files,commits,url",
  ]).then((r) => boundedResult(r, maxBytes));
}

export function ghPrDiff(root: string, number: number, maxBytes = 32_000): Promise<GitHubResult> {
  validateNumber(number, "number", 1_000_000_000);
  return runGh(root, ["pr", "diff", String(number), "--color=never"]).then((r) =>
    boundedResult(r, maxBytes),
  );
}

export function ghPrChecks(root: string, number: number, maxBytes = 32_000): Promise<GitHubResult> {
  validateNumber(number, "number", 1_000_000_000);
  return runGh(root, ["pr", "checks", String(number)]).then((r) => boundedResult(r, maxBytes));
}

export function ghPrCreate(
  root: string,
  title: string,
  body?: string,
  base?: string,
  head?: string,
  draft = false,
  maxBytes = 32_000,
): Promise<GitHubResult> {
  validateValue(title, "title");
  const args = ["pr", "create", "--title", title];
  if (body !== undefined) args.push("--body", body);
  if (base !== undefined) {
    validateValue(base, "base");
    args.push("--base", base);
  }
  if (head !== undefined) {
    validateValue(head, "head");
    args.push("--head", head);
  }
  if (draft) args.push("--draft");
  return runGh(root, args).then((r) => boundedResult(r, maxBytes));
}

export function ghPrComment(
  root: string,
  number: number,
  body: string,
  maxBytes = 32_000,
): Promise<GitHubResult> {
  validateNumber(number, "number", 1_000_000_000);
  validateValue(body, "body");
  return runGh(root, ["pr", "comment", String(number), "--body", body]).then((r) =>
    boundedResult(r, maxBytes),
  );
}

export function ghPrReview(
  root: string,
  number: number,
  event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES",
  body?: string,
  maxBytes = 32_000,
): Promise<GitHubResult> {
  validateNumber(number, "number", 1_000_000_000);
  if (event !== "APPROVE" && event !== "COMMENT" && event !== "REQUEST_CHANGES")
    throw new Error("event must be APPROVE, COMMENT, or REQUEST_CHANGES.");
  if (event !== "APPROVE") validateValue(body ?? "", "body");
  const args = ["pr", "review", String(number), `--${event.toLowerCase().replace("_", "-")}`];
  if (body !== undefined) args.push("--body", body);
  return runGh(root, args).then((r) => boundedResult(r, maxBytes));
}

export function ghIssueList(
  root: string,
  state = "open",
  limit = 20,
  maxBytes = 32_000,
): Promise<GitHubResult> {
  if (!["open", "closed", "all"].includes(state))
    throw new Error("state must be open, closed, or all.");
  validateNumber(limit, "limit", 100);
  return runGh(root, [
    "issue",
    "list",
    "--state",
    state,
    "--limit",
    String(limit),
    "--json",
    "number,title,state,author,labels,assignees,url",
  ]).then((r) => boundedResult(r, maxBytes));
}

export function ghIssueView(
  root: string,
  number: number,
  maxBytes = 32_000,
): Promise<GitHubResult> {
  validateNumber(number, "number", 1_000_000_000);
  return runGh(root, [
    "issue",
    "view",
    String(number),
    "--json",
    "number,title,body,state,author,labels,assignees,comments,url",
  ]).then((r) => boundedResult(r, maxBytes));
}

export function ghIssueCreate(
  root: string,
  title: string,
  body?: string,
  maxBytes = 32_000,
): Promise<GitHubResult> {
  validateValue(title, "title");
  const args = ["issue", "create", "--title", title];
  if (body !== undefined) args.push("--body", body);
  return runGh(root, args).then((r) => boundedResult(r, maxBytes));
}

export function ghRunList(root: string, limit = 20, maxBytes = 32_000): Promise<GitHubResult> {
  validateNumber(limit, "limit", 100);
  return runGh(root, [
    "run",
    "list",
    "--limit",
    String(limit),
    "--json",
    "databaseId,workflowName,displayTitle,status,conclusion,event,headBranch,headSha,url,createdAt,updatedAt",
  ]).then((r) => boundedResult(r, maxBytes));
}

export function ghRunView(root: string, runId: number, maxBytes = 32_000): Promise<GitHubResult> {
  validateNumber(runId, "runId", 1_000_000_000_000);
  return runGh(root, [
    "run",
    "view",
    String(runId),
    "--json",
    "databaseId,workflowName,displayTitle,status,conclusion,event,headBranch,headSha,jobs,url,createdAt,updatedAt",
  ]).then((r) => boundedResult(r, maxBytes));
}

export function ghWorkflowList(root: string, maxBytes = 32_000): Promise<GitHubResult> {
  return runGh(root, ["workflow", "list"]).then((r) => boundedResult(r, maxBytes));
}
