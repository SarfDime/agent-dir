# Configuration and tunnel setup

This guide covers first-run setup, saved profiles, authentication tokens, tunnels, and command permissions.

## Requirements

- Node.js 24 or newer
- npm
- Wormhole CLI or `cloudflared` CLI for remote access

## First-run setup

When run interactively for the first time without an existing config, Agent Dir offers a setup wizard. It collects a profile name, project directory, and port, then optionally configures Cloudflare Tunnel and Wormhole. Cloudflare connector tokens are entered without being echoed. You can enable either provider, both, or neither; Cloudflare is the default when both are configured.

Run the wizard directly at any time:

```bash
agent-dir setup
```

The wizard saves the profile and exits without starting a tunnel. Non-interactive invocations and invocations with explicit launch options do not start the wizard.

To skip profile setup and start a temporary random Wormhole tunnel:

```bash
agent-dir . --random --tunnel wormhole
```

## Profiles

Profiles store the project directory, port, tunnel settings, allowed npm scripts, allowed non-npm commands, and blocked command prefixes.

```bash
agent-dir config add my-project \
  --directory ~/src/my-project \
  --tunnel wormhole \
  --subdomain my-project-x7k4m2 \
  --npm typecheck,lint,format,test,build \
  --command grep,find,rg,git \
  --blacklist "git commit,git push --force"
```

Start a saved profile by name:

```bash
agent-dir my-project
```

Manage profiles:

```bash
agent-dir config list
agent-dir config show my-project
agent-dir config delete my-project
agent-dir config delete --all
```

Deletion asks for confirmation by default. Use `--yes` for automation. The older `config remove <name>` command is an alias for `config delete <name>`.

Profile configuration is stored at `~/.config/agent-dir/config.json`, outside the project repository, with user-only permissions. CLI options can override saved values for a single run. `config show` redacts configured tunnel tokens.

### Example profile

```json
{
  "directory": "~/src/my-project",
  "port": 3002,
  "tunnel": "cloudflared",
  "defaultTunnel": "cloudflared",
  "tunnels": {
    "wormhole": { "subdomain": "my-project-x7k4m2" },
    "cloudflared": {
      "hostname": "mcp.example.com",
      "token": "CLOUDFLARE_TUNNEL_TOKEN"
    }
  }
}
```

The Cloudflare connector token is separate from the Agent Dir MCP Bearer token. Avoid passing secrets as command-line arguments because they may appear in shell history or process listings; prefer the interactive prompt when possible.

## Tunnel setup

### Wormhole

Temporary random URL:

```bash
agent-dir . --random --tunnel wormhole
```

Custom subdomain:

```bash
agent-dir . --tunnel wormhole --subdomain my-project-x7k4m2
```

Choose a distinctive subdomain to reduce collisions. Wormhole limits how many subdomains a user can have registered or active. If registration fails with a subdomain limit error, stop unused Wormhole processes, release an existing subdomain, or use `--random`.

The tunnel is only transport; Agent Dir's local server still enforces its own authentication.

### Cloudflare Tunnel

Configure a Cloudflare Tunnel and DNS/ingress route for the hostname before launching Agent Dir:

```bash
agent-dir . --tunnel cloudflared --hostname mcp.example.com
```

For saved profiles, Cloudflare is selected by default when a `tunnels.cloudflared` entry exists. Use `-c` to explicitly select Cloudflare or `-w` to select Wormhole:

```bash
agent-dir my-project -c
agent-dir my-project -w
```

The `--hostname` value is the public URL Agent Dir displays; the named tunnel's DNS and ingress configuration must already exist. Agent Dir monitors `cloudflared tunnel run` and restarts the process if it disconnects. See the [Cloudflare Tunnel setup guide](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/).

## Authentication tokens

Agent Dir generates a random Bearer token when the server starts unless a profile token or `--token` is configured. Authentication cannot be disabled.

Retrieve or rotate a profile token:

```bash
agent-dir config token my-project
agent-dir config token my-project --rotate
```

The token command intentionally prints the secret. Do not share or commit its output.

Clients should send `Authorization: Bearer <token>`. Query-string tokens are supported for clients that cannot set headers, but are less secure because URLs may be recorded in logs or copied.

## Command permissions

npm scripts and general executables have separate allowlists.

Allow npm scripts:

```text
--npm typecheck,lint,format,test,build
```

Allow executables:

```text
--command grep,find,rg,git
```

Commands are launched with `shell: false`; executable and arguments are passed separately. Git uses the same allowlisted command interface as other executables; there are no dedicated Git MCP tools.

A configured `blacklistedCommands` entry overrides the allowlist and blocks matching command/argument prefixes. For example, allowing `git` while blacklisting `git commit` and `git push --force` still permits `git status`. Prefix entries are separated by commas.

Avoid allowing `sh`, `bash`, `zsh`, `cmd`, `node`, or `python` unless you intentionally want to grant much broader execution capability.
