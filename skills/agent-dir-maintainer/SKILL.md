---
name: agent-dir-maintainer
description: Maintain and troubleshoot agent-dir MCP compatibility, transport behavior, request diagnostics, Agent Skills, tests, and releases.
---

# Agent Dir Maintainer

Use this skill when changing or troubleshooting the `agent-dir` project.

## MCP compatibility contract

`POST /mcp` supports two protocol paths:

- **Modern stateless:** MCP `2026-07-28`. Requests must carry `params._meta.io.modelcontextprotocol/protocolVersion` and `params._meta.io.modelcontextprotocol/clientCapabilities`. No initialize handshake or session id is required.
- **Legacy initialize-based:** MCP `2025-11-25`. The client sends `initialize` with `protocolVersion`, `capabilities`, and `clientInfo`, then subsequent requests use `MCP-Protocol-Version: 2025-11-25` without the modern `_meta` object.

Do not collapse these paths into one protocol implementation. The compatibility boundary is deliberate.

## Streamable HTTP headers

The implementation-specific `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` headers are optional for standard Streamable HTTP requests.

When a client supplies them, validation still applies:

- protocol header must agree with the body metadata when both exist;
- `Mcp-Method` must agree with the JSON-RPC method;
- `Mcp-Name` must agree with the relevant request parameter when supplied.

Do not make these headers mandatory again merely to satisfy an individual client.

## Authentication troubleshooting

Authentication is checked before MCP request handling. A `401` indicates authentication failure; a `400` from the MCP handler may instead indicate protocol or request-shape incompatibility.

When debugging a client connection:

1. confirm the Bearer token or query token;
2. inspect the request log;
3. distinguish HTTP/header validation from MCP handler errors;
4. inspect the logged method, id, parameter names, metadata presence, protocol version, and protocol header;
5. never log arbitrary parameter values or credentials.

The request logger deliberately exposes diagnostic structure without dumping request payloads.

## Tests

Compatibility changes belong in `test/modern.test.ts`. Keep regression coverage for:

- legacy initialize acceptance;
- legacy protocol-header conflicts;
- legacy post-initialize requests;
- modern requests without optional implementation-specific headers;
- modern header/body agreement;
- malformed request metadata;
- URI-mirroring methods without `Mcp-Name` when that header is absent.

Run:

```bash
npm run check
npm test
```

Both must pass before release.

## Agent Skills

Project-local skills are discovered from:

```text
skills/
.agents/skills/
.claude/skills/
.github/skills/
```

The maintainer skill itself lives at `skills/agent-dir-maintainer/SKILL.md`. Keep its compatibility contract synchronized with `src/mcp.ts`, `src/server.ts`, and the corresponding regression tests.

## Release discipline

The npm package version must match its release tag. The publish workflow verifies:

```text
v<package.json version>
```

Do not create a new release solely because a GitHub Actions runner was blocked before starting. First verify whether the package version was actually published. Keep unpublished compatibility changes separate from an already-created release tag.

## Security

Do not add an authentication bypass, log request payloads, or broaden command execution while fixing MCP interoperability. Preserve project-root path safety, explicit command allowlists, and non-shell command execution.
