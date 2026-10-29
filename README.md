<div align="center">

<img src="assets/agent-dir-banner.svg" alt="AGENT-DIR — Expose a local project to AI agents through authenticated MCP." width="100%">

</div>

# agent-dir

**Expose a trusted local project to AI agents through a controlled, authenticated MCP endpoint.**

Agent Dir is a cross-platform TypeScript CLI for bounded project-file access, targeted edits, and explicitly allowlisted development commands. Optional tunnels let an agent connect remotely while the local server retains authentication and filesystem boundaries.

> **Security:** this is a remote-control development tool. Expose only directories you trust, keep authentication and tunnel tokens private, and allow only commands you need.

## Requirements

- Node.js 24 or newer
- npm
- Wormhole CLI or `cloudflared` if remote access is required

## Quick start

Install globally:

```bash
npm install -g agent-dir
agent-dir .
```

Or use it without a global installation:

```bash
npx agent-dir .
```

The server starts with a generated Bearer token. Configure an MCP client to connect to the displayed `/mcp` endpoint and send:

```http
Authorization: Bearer <token>
```

Use the Authorization header rather than putting tokens in URLs. Authentication cannot be disabled.

## Remote access

For a temporary Wormhole endpoint:

```bash
agent-dir . --random --tunnel wormhole
```

To expose local telemetry analytics to the connected agent, opt in explicitly when starting Agent Dir:

```bash
agent-dir . --analytics
```

This grants the connected agent access to persisted Agent Dir telemetry across profiles and sessions. Keep it disabled unless the remote agent needs telemetry analysis. It does not enable telemetry collection; configure telemetry separately with `agent-dir telemetry enable <level>`.

For a configured Wormhole subdomain:

```bash
agent-dir . --tunnel wormhole --subdomain my-project-x7k4m2
```

For Cloudflare Tunnel, configure its DNS and ingress route first, then launch with a hostname:

```bash
agent-dir . --tunnel cloudflared --hostname mcp.example.com
```

See [Configuration and tunnel setup](docs/CONFIGURATION.md) for the setup wizard, saved profiles, authentication tokens, tunnel configuration, and command permissions.

## What it provides

- A compact MCP toolset for project context, file discovery, source search, bounded reads, targeted changes, and validation.
- Authenticated, stateless MCP over `POST /mcp`.
- Explicit package-script and executable allowlists; commands run without a shell.
- Optional CodeGraph code intelligence when CodeGraph is installed and the project is indexed.
- One representation per tool result: a single compact text payload, with no duplicated structured content and no output schemas to pay for on every request.
- Optional local-only telemetry, disabled by default.

See [MCP interface and security model](docs/MCP.md) for the supported protocol, tools, authentication, command policy, and the optional CodeGraph integration.

## Documentation

- [Configuration and tunnel setup](docs/CONFIGURATION.md) — setup wizard, profiles, Cloudflare Tunnel, Wormhole, tokens, and command allowlists.
- [MCP interface and security model](docs/MCP.md) — supported endpoint, protocol behavior, tools, authentication, command execution, and the optional CodeGraph integration.
- [Migrating to 2.0](docs/MIGRATION.md) — breaking changes: removed and renamed tools, single-payload results, result shapes, batch semantics, and configuration keys.
- [Telemetry interpretation](docs/telemetry.md) — privacy levels, event model, metric definitions, and interpretation guidance.
- [Release procedure](docs/RELEASING.md) — validation, branch/PR flow, semantic-release, and npm publishing.
- [Contributing guide](https://github.com/SarfDime/agent-dir/blob/main/.github/CONTRIBUTING.md) — development setup, checks, and pull-request expectations.
- [Security policy](SECURITY.md) — supported versions and private vulnerability reporting.
- [Maintainer skill](https://github.com/SarfDime/agent-dir/blob/main/skills/agent-dir-maintainer/SKILL.md) — repository-specific guidance for coding agents.

## Development checks

```bash
npm ci
npm run check
npm test
npm pack --dry-run
```

Review the package file list from `npm pack --dry-run` before publishing. Releases are automated from `main`; do not manually bump the package version or publish from a local machine. See the [release procedure](docs/RELEASING.md).

## License

[MIT](LICENSE)
