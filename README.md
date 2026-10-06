<div align="center">

<img src="assets/agent-dir-banner.svg" alt="AGENT-DIR — Expose a local project to AI agents through authenticated MCP." width="100%">

</div>

> **`agent-dir` turns a trusted local project directory into a controlled, authenticated MCP endpoint for AI agents.**

`agent-dir` is a cross-platform TypeScript CLI that exposes a local project to an AI agent through an authenticated MCP server. It provides controlled file access, targeted file patches, and explicitly allowlisted development commands, with optional tunneling through [Wormhole](https://wormhole.bar/).

> **Security:** this is a remote-control development tool. Only expose directories you trust, keep the authentication token private, and allow only commands you actually need.

## Requirements

- Node.js 24 LTS or newer
- npm
- Wormhole CLI if remote access is needed

Node.js 24 is the supported LTS baseline. The project currently tracks TypeScript 7 and Biome 2.5.

## Quick start

```bash
npm install -g agent-dir
agent-dir .
```

Or run it without a global install:

```bash
npx agent-dir .
```

For remote MCP access with Wormhole:

```bash
agent-dir . --tunnel wormhole --subdomain my-project-x7k4m2
```

### Wormhole domains

When using a custom Wormhole subdomain, choose a distinctive name such as `my-project-x7k4m2`. Avoid generic names such as `project`, `test`, `dev`, or `scriptr` to reduce collisions and make the public endpoint less predictable.

The Wormhole URL is only the transport endpoint. `agent-dir` authentication is enforced by the local HTTP server; Wormhole does not provide the Bearer-token authentication described below.

> **Wormhole subdomain limit:** Wormhole limits how many subdomains a user can have registered/active at once. If you see an error such as `Subdomain limit reached (max 3 per user)`, the tunnel is being rejected by Wormhole, not by `agent-dir`. Release an existing Wormhole subdomain or use `--random` to let Wormhole choose a temporary random URL.
>
> A subdomain can remain registered while another `wormhole` process is still running, so stop unused Wormhole tunnels before creating another one. If a configured subdomain is unavailable, `agent-dir` will report the Wormhole registration failure instead of silently starting without a tunnel.

## Profiles

Profiles save settings you use repeatedly: project directory, tunnel, Wormhole subdomain, port, npm scripts, and allowed non-npm commands.

```bash
agent-dir config add my-project \
  --directory ~/src/my-project \
  --tunnel wormhole \
  --subdomain my-project-x7k4m2 \
  --npm typecheck,lint,format,test,build \
  --command grep,find,rg,git
```

Then:

```bash
agent-dir my-project
```

Manage profiles with:

```bash
agent-dir config list
agent-dir config show my-project
agent-dir config remove my-project
```

Profiles are stored per-user at `~/.config/agent-dir/config.json`, not in the project repository. The config directory and file are written with user-only permissions. Command-line options can override saved values for one run.

## MCP transport and compatibility

The HTTP MCP endpoint is `POST /mcp`. The implementation supports two protocol compatibility paths:

### Modern stateless MCP

The native protocol path uses MCP `2026-07-28`. Requests carry the protocol version and client capabilities in `params._meta`. The server does not require an initialize handshake or `Mcp-Session-Id` for this path.

Standard Streamable HTTP requests do **not** need the implementation-specific `MCP-Protocol-Version`, `Mcp-Method`, or `Mcp-Name` headers. If a client sends those optional headers, `agent-dir` validates them against the JSON-RPC request and metadata instead of requiring them.

The modern implementation includes:

- `server/discover`
- cursor pagination for list-style methods
- `subscriptions/listen` for tool, prompt, and resource change events
- resource subscriptions and filesystem change notifications
- cache metadata
- structured tool results with `resultType`
- `outputSchema` for tools
- the stable `io.modelcontextprotocol/skills` extension

### Legacy MCP compatibility

Clients using the MCP `2025-11-25` initialize-based lifecycle are also supported. A legacy client can:

1. send `initialize` with `params.protocolVersion: "2025-11-25"`, `capabilities`, and `clientInfo`;
2. negotiate `2025-11-25`;
3. send subsequent requests with `MCP-Protocol-Version: 2025-11-25` without the modern `params._meta` object.

This compatibility path is intentionally narrow. It does not weaken the modern protocol validation, and conflicting protocol headers are rejected.

The compatibility layer exists for clients such as MCP integrations that still perform the standard `initialize` handshake instead of using the native stateless lifecycle.

### Authentication and protocol troubleshooting

Authentication is independent of protocol negotiation. A valid Bearer token is still required before MCP handling:

```http
Authorization: Bearer <token>
```

For clients that cannot send an Authorization header, the server also accepts:

```text
https://your-subdomain.wormhole.bar/mcp?token=<token>
```

If a client reports that the server needs sign-in, inspect the server's request log before changing credentials. A `400` from MCP can be a protocol compatibility error rather than an authentication failure. Request logs now include the MCP error message and, for JSON-RPC failures, safe diagnostic context such as the method, request id, parameter names, metadata presence, protocol version, and protocol header. Parameter values are not logged.

The server log distinguishes protocol/header validation from MCP handler errors. This makes transient client interoperability failures diagnosable without exposing request payloads or secrets.

## MCP tools

| Tool | Purpose |
|---|---|
| `list_files` | Recursive project discovery |
| `list_dirs` | Direct directory discovery for one or more directories |
| `read_range` | Read a bounded line range from one UTF-8 file |
| `read_files` | Read one or more UTF-8 files in one call |
| `write_files` | Create or replace one or more files in one call |
| `patch_files` | Apply targeted text replacements to one or more files |
| `delete_files` | Delete one or more files in one call |
| `search_files` / `find_files` | Search file contents or find paths by glob |
| `search_code` | Search source-like files |
| `find_symbol` / `find_definition` | Locate likely symbol definitions |
| `find_references` | Locate symbol references |
| `find_imports` / `find_exports` | Inspect source dependencies and exports |
| `git_status` / `git_diff` / `git_log` | Git inspection |
| `git_stage` / `git_unstage` | Stage or unstage paths |
| `git_commit` | Commit staged changes |
| `git_restore` | Restore paths, discarding unstaged changes |
| `git_push` | Push the current branch to a remote |
| `project_overview` | Project structure, languages, package managers, and Git state |
| `package_info` / `file_info` | Project and filesystem metadata |
| `diagnostics` | Project-independent diagnostics; does not run tests, lint, or typecheck |
| `run_npm_batch` | Run one or more explicitly allowlisted npm scripts sequentially |
| `run_command_batch` | Run one or more explicitly allowlisted executables sequentially without a shell |

Batch operations execute sequentially and stop on the first failed command. Tool calls return modern `structuredContent` alongside a serialized text representation, and tools that return structured data advertise an `outputSchema`. List-style protocol methods use opaque cursors when more than 50 entries are available.

Modern `subscriptions/listen` replaces the legacy GET/SSE notification model. Clients can subscribe to tool, prompt, resource-list, and resource-specific change events; filesystem mutations publish resource-change events to active subscribers.

### Command permissions

npm scripts must be explicitly enabled:

```text
--npm typecheck,lint,format,test,build
```

Normal executables use a separate allowlist:

```text
--command grep,find,rg,git
```

Commands are launched with `shell: false`; the MCP client supplies the executable and arguments separately. An executable that is not in the allowlist is rejected.

Avoid allowing `sh`, `bash`, `zsh`, `cmd`, `node`, or `python` unless you intentionally want to grant a much broader execution capability.

## Agent Skills

The server implements the stable MCP Skills extension (`io.modelcontextprotocol/skills`) over the standard Resources primitive. It discovers project-local `SKILL.md` files under:

```text
skills/
.agents/skills/
.claude/skills/
.github/skills/
```

Skills are exposed through `skills/list`, `skills/get`, `resources/list`, and `resources/read`. Skill entries contain parsed frontmatter plus SHA-256 digests and byte sizes for every served file. Skill manifests enforce the 512-resource and 16 MiB limits. Binary supporting files are returned as MCP blobs. `resources/directory/read` lists direct children of a skill resource directory. The extension advertises `directoryRead: true`.

This repository now includes a maintainer-facing compatibility skill at `skills/agent-dir-maintainer/SKILL.md`. It documents the modern and legacy MCP paths, troubleshooting signals, and release/test expectations for agents working on this project.

## Authentication

By default, `agent-dir` generates a random Bearer token when the server starts. The token protects both the MCP endpoint and the HTTP file API.

Clients should authenticate with:

```http
Authorization: Bearer <token>
```

The CLI also supports explicitly configured profile tokens and the `--token` option. There is no `--no-auth` option; authentication cannot be disabled through the CLI. Keep the token secret and do not commit it to a repository or publish it alongside a tunnel URL.

For clients that cannot send an `Authorization` header, the HTTP server also accepts the token as a query parameter:

```text
https://your-subdomain.wormhole.bar/mcp?token=<token>
```

Query-string tokens may be exposed in URL logs and should be treated as less secure than the Authorization header.

## REST API

The MCP server is the primary interface, but the HTTP server also exposes:

```text
GET     /__tree
GET     /path/to/file
PUT     /path/to/file
DELETE  /path/to/file
POST    /mcp
```

All HTTP endpoints are authenticated by default.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for development setup, testing requirements, MCP compatibility guidance, and pull-request expectations.

Use the GitHub issue templates for bug reports, feature requests, and usage questions. Security vulnerabilities should be reported privately through the process in [SECURITY.md](SECURITY.md), not through a public issue.

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community participation guidelines.

## Development

The application source and tests are fully TypeScript. JavaScript is generated into `dist/` for execution and publishing. The published package contains only the built CLI/runtime, README, and license; development sources and tests are excluded from the npm tarball.

```bash
npm run build
npm run typecheck
npm test
npm run format
npm run lint
npm run check
```

`npm run check` runs Biome plus TypeScript. Before publishing:

```bash
npm run check
npm test
npm pack --dry-run
```

Review the `npm pack --dry-run` file list before publishing to confirm no local configuration, credentials, source-only files, or development artifacts are included.

## Toolchain

- **Node.js:** 24 LTS baseline
- **TypeScript:** 7.x
- **Biome:** 2.5.x
- **Module system:** native Node ESM with `NodeNext`
- **Formatting/linting:** Biome with strict recommended rules and import organization

The TypeScript configuration uses strict checking, exact optional properties, unchecked indexed access, isolated modules, explicit Node typings, and consistent module resolution.

## Security model

File access is rooted at the shared directory and resolves existing paths through their real filesystem targets, preventing symlinks from escaping the exposed root. HTTP request bodies are limited to 10 MiB. npm scripts and external executables use explicit allowlists, and external commands are not passed through a shell.

Because file writes, deletion, command execution, and Git write operations can modify a project or remote repository, expose only directories and capabilities you intend an AI agent to control. Git write tools are intentionally explicit: staging, unstaging, committing, restoring, and pushing are separate operations. `git_restore` discards unstaged changes, and `git_push` can modify a remote repository. If you do not want Git mutation, do not use the Git write tools and do not allow `git` through the generic command allowlist.

The diagnostics tool is deliberately project-independent. It checks conditions such as invalid JSON, broken symlinks, and unresolved merge-conflict markers instead of assuming a particular test runner, linter, compiler, or package ecosystem. Never share directories containing credentials, SSH keys, private certificates, production secrets, or unrelated personal data.

## Credits

Remote tunneling support is provided through [Wormhole](https://wormhole.bar/), a project of the Wormhole team. `agent-dir` invokes the Wormhole CLI and does not provide the tunneling service itself.

## License

MIT
