# Agent instructions for agent-dir

Entry point for agents working in this repository. Load only the scoped document for the task at hand instead of the whole rule set.

## Load only what you need

| Task | Read |
|---|---|
| Branching, pull requests, merging | [docs/AGENTS-WORKFLOW.md](docs/AGENTS-WORKFLOW.md) |
| Running checks before a PR | [docs/AGENTS-VALIDATION.md](docs/AGENTS-VALIDATION.md) |
| Commit messages and release impact | [docs/AGENTS-COMMITS.md](docs/AGENTS-COMMITS.md) |
| Publishing and release automation | [docs/AGENTS-PUBLISHING.md](docs/AGENTS-PUBLISHING.md) |
| A release failed or looks wrong | [docs/AGENTS-RELEASE-TROUBLESHOOTING.md](docs/AGENTS-RELEASE-TROUBLESHOOTING.md) |
| MCP protocol, transport, auth debugging | [skills/agent-dir-maintainer/SKILL.md](skills/agent-dir-maintainer/SKILL.md) |
| Security policy and vulnerability reporting | [docs/SECURITY.md](docs/SECURITY.md) |
| Code of conduct | [docs/CODE_OF_CONDUCT.md](docs/CODE_OF_CONDUCT.md) |
| Full release invariants | [docs/RELEASING.md](docs/RELEASING.md) |
| Configuration, MCP surface, migration, telemetry | [docs/CONFIGURATION.md](docs/CONFIGURATION.md), [docs/MCP.md](docs/MCP.md), [docs/MIGRATION.md](docs/MIGRATION.md), [docs/telemetry.md](docs/telemetry.md) |

## Where the rest of the docs live

Everything below lives under `docs/`. Nothing else at the repository root is documentation besides this file and `README.md`.

Agent-facing rules, split out of this file:

- [docs/AGENTS-WORKFLOW.md](docs/AGENTS-WORKFLOW.md) - branching, pull requests, merging, branch protection.
- [docs/AGENTS-VALIDATION.md](docs/AGENTS-VALIDATION.md) - the checks to run before opening or merging a PR.
- [docs/AGENTS-COMMITS.md](docs/AGENTS-COMMITS.md) - Conventional Commits and their release impact.
- [docs/AGENTS-PUBLISHING.md](docs/AGENTS-PUBLISHING.md) - semantic-release, npm Trusted Publishing, tags.
- [docs/AGENTS-RELEASE-TROUBLESHOOTING.md](docs/AGENTS-RELEASE-TROUBLESHOOTING.md) - what to inspect when a release fails.

Project reference:

- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) - profiles, tunnels, tokens, command allowlists.
- [docs/MCP.md](docs/MCP.md) - MCP endpoint, protocol behavior, tools, authentication.
- [docs/MIGRATION.md](docs/MIGRATION.md) - breaking changes when upgrading to 2.0.
- [docs/telemetry.md](docs/telemetry.md) - privacy levels, event model, metrics.
- [docs/RELEASING.md](docs/RELEASING.md) - full release invariants.
- [docs/SECURITY.md](docs/SECURITY.md) - security policy and private vulnerability reporting.
- [docs/CODE_OF_CONDUCT.md](docs/CODE_OF_CONDUCT.md) - community expectations.
- [docs/AUDIT-EFFICIENCY.md](docs/AUDIT-EFFICIENCY.md), [docs/AUDIT-PROGRESS.md](docs/AUDIT-PROGRESS.md) - audit notes.

Agent skills live under `skills/`:

- [skills/agent-dir-maintainer/SKILL.md](skills/agent-dir-maintainer/SKILL.md) - repository-specific guidance, MCP transport and auth debugging.
- [skills/agent-dir-tools/SKILL.md](skills/agent-dir-tools/SKILL.md) - how to drive the Agent Dir tools themselves.

## Non-negotiables

Preserve these in every change:

- authentication is checked before MCP request handling; never add a bypass;
- every path resolves inside the exposed project root; `..` stays rejected;
- commands come from explicit allowlists, run without a shell, one command per item;
- protected paths stay non-editable;
- request payloads, tokens and credentials are never logged;
- every tool result stays bounded and reports `truncated`.

Security, validation at trust boundaries and data-loss handling are never traded for brevity.

## Global code quality directives

These apply to every change in this repository.

### SOLID, applied here

- Single responsibility. One tool per module under `src/tools/`. Policy lives in `src/tools/policy.ts`, path safety in `src/tools/protected-paths.ts`, walking in `src/tools/walk.ts`. Do not fold a second concern into an existing tool module.
- Open for extension, closed for modification. A new tool is a new module plus registration. Do not grow a switch or branch chain inside an existing handler.
- Substitutability. Every tool result conforms to the shared bounded envelope. Do not invent a per-tool result shape that callers must special-case.
- Interface segregation. A tool validates and accepts only the arguments it needs. Do not thread one god config object through unrelated modules.
- Dependency inversion. Depend on the execution policy and the filesystem helpers, not on `process.spawn` or `fs` called inline in feature code.

### Do not over-abstract

Three similar lines beat a premature abstraction. Add an interface only when a second implementation exists today. No wrapper, option or config nobody asked for.

### Types and validation

- No `any`. Reuse the existing types in `src/types.ts`.
- Validate at trust boundaries, before use. Client-supplied arguments are untrusted.
- Invalid input returns a correctable tool result. Reserve thrown errors for genuine failures.

### Bounded output

Every list, search and read stays bounded by `maxResults` and `maxBytes` and reports truncation honestly. Never imply full coverage when a result was cut.

### Tests

Non-trivial logic (branches, parsers, policy decisions) leaves a test. A bug fix adds regression coverage at the root cause, not at the call site.

### Comments

Comment only the why the code cannot show, in one line. A known limit gets a comment in the form: `shortcut: LIMIT, WHEN TO UPGRADE`.

### Formatting

Biome formats TypeScript and JSON only. Markdown and `.serena/` are excluded on purpose: a Biome Markdown pass rewrites whole tables. Keep `npm run check` green instead of reformatting docs.

## Before you edit

Orient with `project_context`, read the module you touch, and trace callers with `find_references` before changing a shared function.
