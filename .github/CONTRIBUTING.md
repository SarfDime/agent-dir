# Contributing to agent-dir

Thank you for contributing to agent-dir.

## Before you start

- Search existing issues and pull requests before opening a new one.
- For security vulnerabilities, do **not** open a public issue. Follow [SECURITY.md](SECURITY.md).
- Keep changes focused and avoid unrelated refactors.
- Preserve the security model: project-root path safety, explicit command allowlists, and non-shell command execution.
- Do not commit tokens, credentials, private keys, local configuration, or other secrets.

## Development

Requirements:

- Node.js 24 LTS or newer
- npm

Install dependencies:

```bash
npm ci
```

Run the full verification suite:

```bash
npm run check
npm test
```

Before a release, also inspect the package contents:

```bash
npm pack --dry-run
```

## Pull requests

A good pull request should:

1. Explain what changed and why.
2. Include or update tests for behavioral changes.
3. Update documentation when user-visible behavior changes.
4. Keep MCP compatibility behavior explicit and covered by regression tests.
5. Pass `npm run check` and `npm test`.
6. Avoid changing release/version metadata unless the change is intentionally a release.

### MCP changes

Changes to MCP transport, protocol negotiation, request validation, or compatibility behavior should include regression coverage in `test/modern.test.ts`.

Do not make implementation-specific HTTP headers mandatory for standard Streamable HTTP clients merely to satisfy one client. Preserve both the modern stateless MCP path and the legacy initialize-based compatibility path unless a deliberate breaking change is being made.

### Commit and release changes

Do not move, delete, or reuse an existing release tag. Package versions must match their release tags.

The npm publish workflow verifies that:

```text
v<package.json version>
```

matches the Git tag. Release changes should therefore be made deliberately and separately from normal feature/fix commits.

## Style

Follow the existing TypeScript, Biome, and project conventions. Prefer small, explicit changes over clever abstractions.

For security-sensitive changes, explain the threat model and the invariant being preserved in the pull request description.
