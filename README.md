# agent-dir

`agent-dir` is a cross-platform TypeScript CLI that exposes a local project to an AI agent through an authenticated MCP server. It provides controlled file access, targeted file patches, and explicitly allowlisted development commands, with optional Wormhole tunneling.

> **Security:** this is a remote-control development tool. Only expose directories you trust, keep the Bearer token private, and allow only commands you actually need.

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

**Always use a distinctive, hard-to-guess Wormhole subdomain, especially when authentication is disabled or an endpoint is otherwise exposed without authentication.** Avoid generic names such as `project`, `test`, `dev`, or `scriptr`.

A unique domain reduces accidental collisions and makes the endpoint harder to guess. It is **not a replacement for authentication**.

## Profiles

Profiles save settings you use repeatedly: project directory, tunnel, Wormhole subdomain, port, npm scripts, and allowed non-npm commands.

```bash
agent-dir config add scriptr \
  --directory ~/src/scriptr \
  --tunnel wormhole \
  --subdomain scriptr-x7k4m2 \
  --npm typecheck,lint,format,test,build \
  --command grep,find,rg,git
```

Then:

```bash
agent-dir scriptr
```

Manage profiles with:

```bash
agent-dir config list
agent-dir config show scriptr
agent-dir config remove scriptr
```

Profiles are stored per-user at `~/.config/agent-dir/config.json`, not in the project repository. The config directory and file are written with user-only permissions. Command-line options can override saved values for one run.

## MCP tools

The HTTP MCP transport currently implements the legacy `2025-06-18` initialize handshake over authenticated `POST /mcp`. Clients that support automatic legacy fallback can use it; the newer `2026-07-28` stateless MCP lifecycle is not implemented yet.

| Tool | Purpose |
|---|---|
| `list_files` | List files and directories recursively |
| `list_dir` | List one directory directly |
| `list_dirs` | List multiple directories directly |
| `read_file` / `read_files` | Read one or many UTF-8 files |
| `write_file` / `write_files` | Create or completely replace one or many files |
| `patch_file` / `patch_files` | Apply targeted text replacements without replacing the whole file |
| `delete_file` / `delete_files` | Delete one or many files |
| `run_npm` / `run_npm_batch` | Run allowlisted npm scripts |
| `run_command` / `run_command_batch` | Run allowlisted executables without a shell |

Batch operations execute sequentially and stop on the first failed command.

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

## Authentication

A random Bearer token is generated when the server starts. MCP and REST requests must provide:

```http
Authorization: Bearer <token>
```

For clients that cannot send a custom `Authorization` header, HTTP endpoints also accept the token as a query parameter:

```text
https://your-subdomain.wormhole.bar/mcp?token=<token>
```

The Bearer header remains preferred. Query-string tokens can appear in URL logs and should be treated as less secure. Do not commit the token or publish it alongside a tunnel URL.

## REST API

The MCP server is the primary interface, but the HTTP server also exposes:

```text
GET     /__tree
GET     /path/to/file
PUT     /path/to/file
DELETE  /path/to/file
POST    /mcp
```

All endpoints are authenticated by default.

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

Because file writes, deletion, and command execution can modify a project or execute programs, expose only directories and capabilities you intend an AI agent to control. Never share directories containing credentials, SSH keys, private certificates, production secrets, or unrelated personal data.

## License

MIT