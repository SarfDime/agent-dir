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
- npm scripts and generic executables are explicitly allowlisted;
- external commands are launched without a shell;
- Git write operations are explicit tools rather than implicit side effects;
- request diagnostics avoid logging arbitrary request parameter values.

When contributing, preserve these boundaries. A compatibility fix must not become an authentication bypass, path traversal, command-execution expansion, or sensitive-data logging change.
