# Security Policy

## Supported versions

Security fixes are generally made against the latest published version.

If you are running an unreleased checkout, include the commit or tag when reporting a vulnerability.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Use GitHub's private security advisory flow:

https://github.com/SarfDime/agent-dir/security/advisories/new

Include:

- a clear description of the vulnerability;
- affected version or commit;
- reproduction steps or a proof of concept;
- security impact;
- any suggested mitigation.

Please remove secrets, credentials, personal data, and unrelated sensitive information from the report.

## Security model

agent-dir is designed to expose a trusted local project to an authenticated AI agent. Important security boundaries include:

- file access is rooted at the configured project directory;
- existing paths are resolved through their real filesystem targets to prevent symlink escapes;
- MCP and HTTP endpoints require authentication;
- Package scripts and generic executables are explicitly allowlisted;
- external commands are launched without a shell;
- Git commands are available only when the `git` executable is allowlisted, with configured blacklist prefixes taking precedence;
- unauthenticated requests are rejected before any request body is read;
- browser requests are accepted only from the same origin or from origins a profile explicitly lists (`allowedOrigins` / `--allow-origin`), which limits DNS-rebinding style attacks from arbitrary pages;
- request diagnostics avoid logging arbitrary request parameter values.

When contributing, preserve these boundaries. A compatibility fix must not become an authentication bypass, path traversal, command-execution expansion, or sensitive-data logging change.

## What agent-dir does not protect against

**agent-dir is not a security boundary against a hostile or prompt-injected agent.** The executable allowlist, the blacklist, the command guardrails and the protected paths reduce accidents and common bypasses; they do not sandbox the agent. An allowlist of executable names alone is not a complete security system:

- allowing an interpreter or build tool (`node`, `python`, `npm`, `make`, a test runner) lets the agent run arbitrary code, because the agent can also write the files those programs run;
- many ordinary tools have execution or write modes hidden in their arguments (`find -exec`, `rg --pre`, `git -c core.sshCommand=...`, `sed -i`, `tee`, package scripts that call anything);
- file edits and allowed scripts can change project configuration, CI workflows and build scripts;
- commands run with your user account, your network access and your credentials (for example `gh`, `git` and registry logins stored on disk).

Treat any agent that can run commands as having the same access as the user running agent-dir. Run it against a project you are willing to expose, use a separate low-privilege account or container for untrusted work, and keep secrets out of the project directory and the environment.

### Guardrails that are built in

These are on by default and can be extended per profile (see `docs/CONFIGURATION.md`):

- **Argument-aware command rules.** Global options placed before a subcommand no longer bypass a blacklist entry (`git -C . push` matches `git push`). Built-in rules also block git execution vectors (`-c` with executable settings, `--exec-path`, `--upload-pack`, writing `git config`, `-C`/`--git-dir`/`--work-tree` outside the project), registry and account changes through package managers (`publish`, `login`, `token`, ...), remote code execution helpers (`exec`, `dlx`, `create`), package scripts that are not in the profile's allowed scripts, `gh api` writes and destructive `gh` subcommands, `rg --pre`, and `find -exec`/`-delete`.
- **Protected paths for edits.** `apply_changes` refuses `.git` internals, `.env` files (except `.env.example`-style templates) and `.npmrc` by default.
- **Credential-shaped environment variables** are not passed to child processes.

An OS-level sandbox (container, separate user, or bubblewrap) is a possible future enhancement and is the right tool when the agent is not fully trusted.
