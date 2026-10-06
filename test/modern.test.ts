import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createMcpHandler, validateMcpParamHeaders } from "../src/mcp.js";
import { getMcpLog, validateMcpHeaders } from "../src/server.js";

test("CLI reports its package version", () => {
  const output = execFileSync(process.execPath, ["dist/bin/agent-dir.js", "--version"], {
    encoding: "utf8",
  });
  assert.equal(output.trim(), "0.1.3");
});

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};

function requestFor(id: number, method: string, params: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(method === "tools/call" || method === "resources/read"
        ? { "mcp-name": method === "tools/call" ? String(params.name) : String(params.uri) }
        : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: META } }),
  });
}

test("allowed_commands reports the active command policy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root, {
      npm: { allowedScripts: ["check", "test"] },
      commands: ["git", "node", "npm"],
    });
    const response = await handler(
      requestFor(1, "tools/call", {
        name: "allowed_commands",
        arguments: {},
      }),
    );
    assert.equal(response.status, 200);
    const result = (await response.json()) as {
      result: { structuredContent: { npmScripts: string[]; commands: string[] } };
    };
    assert.deepEqual(result.result.structuredContent, {
      npmScripts: ["check", "test"],
      commands: ["git", "node", "npm"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allowed_commands defaults to empty policy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root);
    const response = await handler(
      requestFor(1, "tools/call", {
        name: "allowed_commands",
        arguments: {},
      }),
    );
    const result = (await response.json()) as {
      result: { structuredContent: { npmScripts: string[]; commands: string[] } };
    };
    assert.deepEqual(result.result.structuredContent, { npmScripts: [], commands: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP request logging describes initialize and non-tool methods", () => {
  const legacy = getMcpLog(
    Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: { roots: {}, sampling: {} },
          clientInfo: { name: "Test Client", version: "1.2.3" },
        },
      }),
    ),
  );
  assert.deepEqual(legacy, {
    name: "initialize",
    detail: "protocol: 2025-11-25 • client: Test Client v1.2.3 • capabilities: roots, sampling",
  });

  const modern = getMcpLog(
    Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          },
          capabilities: { roots: {} },
          clientInfo: { name: "Modern Client" },
        },
      }),
    ),
  );
  assert.deepEqual(modern, {
    name: "initialize",
    detail: "protocol: 2026-07-28 • client: Modern Client • capabilities: roots",
  });

  assert.deepEqual(
    getMcpLog(
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/list",
          params: {},
        }),
      ),
    ),
    { name: "tools/list", detail: "list tools" },
  );

  assert.deepEqual(
    getMcpLog(
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "subscriptions/listen",
          params: {
            notifications: {
              resourcesListChanged: true,
              resourceSubscriptions: ["skill://demo/SKILL.md", "skill://demo/README.md"],
            },
          },
        }),
      ),
    ),
    {
      name: "subscriptions/listen",
      detail: "resources list changes • 2 resource subscriptions",
    },
  );
});

test("Mcp-Param headers validate annotated arguments", () => {
  const schema = {
    type: "object",
    properties: {
      region: { type: "string", "x-mcp-header": "Region" },
      count: { type: "integer", "x-mcp-header": "Count" },
      enabled: { type: "boolean", "x-mcp-header": "Enabled" },
    },
  };

  const headers = new Headers({
    "Mcp-Param-Region": "Europe",
    "Mcp-Param-Count": "3",
    "Mcp-Param-Enabled": "true",
  });
  assert.equal(
    validateMcpParamHeaders(schema, { region: "Europe", count: 3, enabled: true }, headers),
    undefined,
  );

  assert.match(
    validateMcpParamHeaders(schema, { region: "Europe", count: 4, enabled: true }, headers) ?? "",
    /Mcp-Param-Count/,
  );
  assert.match(
    validateMcpParamHeaders(schema, { region: "Europe", count: 3, enabled: true }, new Headers()) ??
      "",
    /required/,
  );

  const encoded = new Headers({
    "Mcp-Param-Region": "=?base64?UsO8ZA==?=",
    "Mcp-Param-Count": "03",
    "Mcp-Param-Enabled": "true",
  });
  assert.equal(
    validateMcpParamHeaders(schema, { region: "Rüd", count: 3, enabled: true }, encoded),
    undefined,
  );
});

test("legacy initialize handshake is accepted without modern metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root);
    const response = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "claude", version: "1.0.0" },
          },
        }),
      }),
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { result: Record<string, unknown> };
    assert.equal(body.result.protocolVersion, "2025-11-25");
    assert.deepEqual(body.result.capabilities, {
      tools: { listChanged: true },
      resources: { listChanged: true, subscribe: true },
      extensions: { "io.modelcontextprotocol/skills": { directoryRead: true } },
    });
    assert.deepEqual(body.result.serverInfo, { name: "agent-dir", version: "0.1.3" });
    assert.match(String(body.result.instructions), /minimum necessary tool calls/);
    assert.match(String(body.result.instructions), /Allowed npm scripts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy initialize rejects a conflicting protocol header", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root);
    const response = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "claude", version: "1.0.0" },
          },
        }),
      }),
    );
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: { code: number } }).error.code, -32020);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy requests can use the negotiated protocol without modern metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root);
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
        "mcp-method": "tools/list",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    const response = await handler(request);
    assert.equal(response.status, 200);
    const result = (await response.json()) as { result: { tools: Array<{ name: string }> } };
    assert.ok(result.result.tools.some((tool) => tool.name === "read_files"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing protocol version metadata returns invalid params", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root);
    const response = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "server/discover",
          params: { _meta: { "io.modelcontextprotocol/clientCapabilities": {} } },
        }),
      }),
    );
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: { code: number } }).error.code, -32602);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported protocol versions negotiate with -32022", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root);
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
        "mcp-method": "server/discover",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2025-11-25",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    const response = await handler(request);
    assert.equal(response.status, 400);
    const result = (await response.json()) as {
      error: { code: number; data: { supported: string[]; requested: string } };
    };
    assert.equal(result.error.code, -32022);
    assert.deepEqual(result.error.data.supported, ["2026-07-28"]);
    assert.equal(result.error.data.requested, "2025-11-25");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP protocol header must agree with request metadata", async () => {
  const request = new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "server/discover",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2025-11-25" } },
    }),
  });
  const response = validateMcpHeaders(
    request,
    JSON.parse(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2025-11-25" } },
      }),
    ) as Record<string, unknown>,
  );
  assert.equal(response?.status, 400);
  assert.match(await response?.text(), /does not match/);
});

test("standard Streamable HTTP requests do not require optional MCP headers", () => {
  const request = new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
    }),
  });
  const response = validateMcpHeaders(request, {
    jsonrpc: "2.0",
    id: 1,
    method: "server/discover",
    params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
  });
  assert.equal(response, undefined);
});

test("modern notification POSTs do not require standard MCP headers", async () => {
  const request = new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/test", params: {} }),
  });
  const response = validateMcpHeaders(
    request,
    JSON.parse(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/test", params: {} }),
    ) as Record<string, unknown>,
  );
  assert.equal(response, undefined);

  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root);
    const accepted = await handler(request);
    assert.equal(accepted.status, 202);
    assert.equal(await accepted.text(), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("method parameters reject malformed tools and resource arguments", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root);
    const missingName = await handler(requestFor(1, "tools/call", {}));
    assert.equal(missingName.status, 400);
    assert.equal(((await missingName.json()) as { error: { code: number } }).error.code, -32602);

    const badArguments = await handler(
      requestFor(2, "tools/call", {
        name: "read_files",
        arguments: [] as unknown as Record<string, unknown>,
      }),
    );
    assert.equal(badArguments.status, 400);
    assert.equal(((await badArguments.json()) as { error: { code: number } }).error.code, -32602);

    const missingUri = await handler(requestFor(3, "resources/read", {}));
    assert.equal(missingUri.status, 400);
    assert.equal(((await missingUri.json()) as { error: { code: number } }).error.code, -32602);

    const badUri = await handler(requestFor(4, "resources/read", { uri: 42 as unknown as string }));
    assert.equal(badUri.status, 400);
    assert.equal(((await badUri.json()) as { error: { code: number } }).error.code, -32602);

    const missingSkillUri = await handler(requestFor(5, "skills/get", {}));
    assert.equal(missingSkillUri.status, 400);
    assert.equal(
      ((await missingSkillUri.json()) as { error: { code: number } }).error.code,
      -32602,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid JSON-RPC request envelopes are rejected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root);
    const response = await handler(requestFor(1, "server/discover"));
    assert.equal(response.status, 200);

    const invalid = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          method: "server/discover",
          params: { _meta: META },
        }),
      }),
    );
    assert.equal(invalid.status, 400);
    const result = (await invalid.json()) as { error: { code: number } };
    assert.equal(result.error.code, -32600);

    const invalidId = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: true,
          method: "server/discover",
          params: { _meta: META },
        }),
      }),
    );
    assert.equal(invalidId.status, 400);
    assert.equal(((await invalidId.json()) as { error: { code: number } }).error.code, -32600);

    const invalidCapabilities = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "server/discover",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": [],
            },
          },
        }),
      }),
    );
    assert.equal(invalidCapabilities.status, 400);
    assert.equal(
      ((await invalidCapabilities.json()) as { error: { code: number } }).error.code,
      -32602,
    );

    const invalidParams = await handler(
      new Request("http://localhost/mcp", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "server/discover",
          params: "invalid",
        }),
      }),
    );
    assert.equal(invalidParams.status, 400);
    assert.equal(((await invalidParams.json()) as { error: { code: number } }).error.code, -32602);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("modern HTTP accepts URI-mirroring methods without optional Mcp-Name", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    for (const method of ["skills/get", "resources/directory/read"]) {
      const request = requestFor(1, method, { uri: "skill://demo" });
      request.headers.delete("mcp-name");
      const response = validateMcpHeaders(
        request,
        JSON.parse(await request.clone().text()) as Record<string, unknown>,
      );
      assert.equal(response, undefined);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("modern HTTP accepts Base64-sentinel Mcp-Name values", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "resources/read",
        "mcp-name": `=?base64?${Buffer.from("skill://demo/SKILL.md").toString("base64")}?=`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: {
          uri: "skill://demo/SKILL.md",
          _meta: META,
        },
      }),
    });
    const response = validateMcpHeaders(
      request,
      JSON.parse(await request.clone().text()) as Record<string, unknown>,
    );
    assert.equal(response, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid x-mcp-header annotations are rejected", () => {
  assert.throws(
    () =>
      validateMcpParamHeaders(
        {
          type: "object",
          properties: {
            value: { type: "array", "x-mcp-header": "Value" },
          },
        },
        { value: ["x"] },
        new Headers(),
      ),
    /Invalid x-mcp-header type/,
  );

  assert.throws(
    () =>
      validateMcpParamHeaders(
        {
          type: "object",
          properties: {
            first: { type: "string", "x-mcp-header": "Value" },
            second: { type: "string", "x-mcp-header": "value" },
          },
        },
        { first: "a", second: "b" },
        new Headers(),
      ),
    /Duplicate x-mcp-header/,
  );
});

test("Agent Dir instruction resources reflect the active execution policy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root, {
      npm: { allowedScripts: ["check", "test"] },
      commands: ["git", "rg"],
    });
    const listed = await handler(requestFor(1, "resources/list"));
    const listedResult = (await listed.json()) as { result: { resources: Array<{ uri: string }> } };
    assert.ok(
      listedResult.result.resources.some((resource) => resource.uri === "agent-dir://instructions"),
    );
    assert.ok(
      listedResult.result.resources.some((resource) => resource.uri === "agent-dir://capabilities"),
    );

    const instructions = await handler(
      requestFor(2, "resources/read", { uri: "agent-dir://instructions" }),
    );
    const instructionsResult = (await instructions.json()) as {
      result: { contents: Array<{ text: string }> };
    };
    const instructionText = instructionsResult.result.contents[0]?.text;
    assert.ok(instructionText);
    assert.match(instructionText, /minimum necessary tool calls/);
    assert.ok(instructionText.includes("- check\n- test"));
    assert.ok(instructionText.includes("- git\n- rg"));

    const capabilities = await handler(
      requestFor(3, "resources/read", { uri: "agent-dir://capabilities" }),
    );
    const capabilitiesResult = (await capabilities.json()) as {
      result: { contents: Array<{ text: string }> };
    };
    const capabilityText = capabilitiesResult.result.contents[0]?.text;
    assert.ok(capabilityText);
    const capabilityDocument = JSON.parse(capabilityText) as {
      execution: { npmScripts: string[]; commands: string[] };
      efficiency: { preferred: { orientation: string } };
    };
    assert.deepEqual(capabilityDocument.execution, {
      npmScripts: ["check", "test"],
      commands: ["git", "rg"],
    });
    assert.equal(capabilityDocument.efficiency.preferred.orientation, "project_overview");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skills preserve nested URI paths and complete manifests", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    await mkdir(path.join(root, "skills", "acme", "billing"), { recursive: true });
    await mkdir(path.join(root, "skills", "acme", "billing", "refunds"), { recursive: true });
    await writeFile(
      path.join(root, "skills", "acme", "billing", "SKILL.md"),
      "---\nname: billing\ndescription: Billing workflows\n---\n",
    );
    await writeFile(path.join(root, "skills", "acme", "billing", "README.md"), "billing");
    await writeFile(
      path.join(root, "skills", "acme", "billing", "refunds", "SKILL.md"),
      "---\nname: refunds\ndescription: Refund workflows\n---\n",
    );

    const handler = createMcpHandler(root);
    const response = await handler(requestFor(1, "skills/list"));
    const result = (await response.json()) as {
      result: { skills: Array<{ uri: string; resources: Array<{ uri: string }> }> };
    };
    const billing = result.result.skills.find(
      (skill) => skill.uri === "skill://acme/billing/SKILL.md",
    );
    const refunds = result.result.skills.find(
      (skill) => skill.uri === "skill://acme/billing/refunds/SKILL.md",
    );
    assert.ok(billing);
    assert.ok(refunds);
    assert.deepEqual(
      billing.resources.map((resource) => resource.uri),
      [
        "skill://acme/billing/README.md",
        "skill://acme/billing/refunds/SKILL.md",
        "skill://acme/billing/SKILL.md",
      ],
    );
    assert.deepEqual(
      refunds.resources.map((resource) => resource.uri),
      ["skill://acme/billing/refunds/SKILL.md"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid skill frontmatter and oversized skills are excluded", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    await mkdir(path.join(root, "skills", "bad-name"), { recursive: true });
    await writeFile(
      path.join(root, "skills", "bad-name", "SKILL.md"),
      "---\nname: Bad_Name\ndescription: invalid\n---\n",
    );
    await mkdir(path.join(root, "skills", "missing-description"), { recursive: true });
    await writeFile(
      path.join(root, "skills", "missing-description", "SKILL.md"),
      "---\nname: missing-description\n---\n",
    );
    await mkdir(path.join(root, "skills", "duplicate-key"), { recursive: true });
    await writeFile(
      path.join(root, "skills", "duplicate-key", "SKILL.md"),
      "---\nname: duplicate-key\nname: duplicate-key\ndescription: invalid\n---\n",
    );

    await mkdir(path.join(root, "skills", "too-many"), { recursive: true });
    await writeFile(
      path.join(root, "skills", "too-many", "SKILL.md"),
      "---\nname: too-many\ndescription: too many resources\n---\n",
    );
    await Promise.all(
      Array.from({ length: 512 }, (_, index) =>
        writeFile(path.join(root, "skills", "too-many", `file-${index}.txt`), ""),
      ),
    );

    const handler = createMcpHandler(root);
    const response = await handler(requestFor(1, "skills/list"));
    const result = (await response.json()) as {
      result: { skills: Array<{ uri: string }> };
    };
    assert.deepEqual(result.result.skills, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resources/directory/read lists direct skill children", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    await mkdir(path.join(root, "skills", "billing", "templates", "regional"), { recursive: true });
    await writeFile(
      path.join(root, "skills", "billing", "SKILL.md"),
      "---\nname: billing\ndescription: Billing\n---\n",
    );
    await writeFile(path.join(root, "skills", "billing", "templates", "invoice.md"), "invoice");
    await writeFile(path.join(root, "skills", "billing", "templates", "regional", "eu.md"), "eu");
    const handler = createMcpHandler(root);
    const response = await handler(
      requestFor(1, "resources/directory/read", { uri: "skill://billing/templates" }),
    );
    const result = (await response.json()) as {
      result: {
        resultType: string;
        resources: Array<{ uri: string; name: string; mimeType: string }>;
        ttlMs: number;
        cacheScope: string;
      };
    };
    assert.equal(result.result.resultType, "complete");
    assert.deepEqual(result.result.resources, [
      {
        uri: "skill://billing/templates/invoice.md",
        name: "invoice.md",
        mimeType: "text/markdown",
      },
      { uri: "skill://billing/templates/regional", name: "regional", mimeType: "inode/directory" },
    ]);
    assert.equal((result.result as { ttlMs: number }).ttlMs, 0);
    assert.equal((result.result as { cacheScope: string }).cacheScope, "private");

    const discover = await handler(requestFor(2, "server/discover"));
    const discoverResult = (await discover.json()) as {
      result: { capabilities: { extensions: Record<string, unknown> } };
    };
    assert.deepEqual(
      discoverResult.result.capabilities.extensions["io.modelcontextprotocol/skills"],
      { directoryRead: true },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resources/directory/read rejects traversal outside the project root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-skill-traversal-"));
  const outside = await mkdtemp(path.join(tmpdir(), "agent-dir-outside-"));
  try {
    await mkdir(path.join(root, "skills", "demo"), { recursive: true });
    await writeFile(
      path.join(root, "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demo\n---\n",
    );
    await writeFile(path.join(outside, "secret.txt"), "secret");

    const handler = createMcpHandler(root);
    const response = await handler(
      requestFor(1, "resources/directory/read", {
        uri: "skill://../../agent-dir-outside-should-not-be-visible",
      }),
    );
    assert.equal(response.status, 400);
  } finally {
    await rm(outside, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("resources/directory/read rejects unknown directories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root);
    const response = await handler(
      requestFor(1, "resources/directory/read", { uri: "skill://missing" }),
    );
    assert.equal(response.status, 400);
    const result = (await response.json()) as { error: { code: number } };
    assert.equal(result.error.code, -32602);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skills/list paginates with opaque cursors", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    for (let index = 0; index < 51; index += 1) {
      const name = `skill-${String(index).padStart(2, "0")}`;
      await mkdir(path.join(root, "skills", name), { recursive: true });
      await writeFile(
        path.join(root, "skills", name, "SKILL.md"),
        `---\nname: ${name}\ndescription: Skill ${index}\n---\n`,
      );
    }
    const handler = createMcpHandler(root);
    const first = await handler(requestFor(1, "skills/list"));
    const firstResult = (await first.json()) as {
      result: { skills: unknown[]; nextCursor?: string };
    };
    assert.equal(firstResult.result.skills.length, 50);
    assert.equal(typeof firstResult.result.nextCursor, "string");

    const second = await handler(
      requestFor(2, "skills/list", { cursor: firstResult.result.nextCursor }),
    );
    const secondResult = (await second.json()) as {
      result: { skills: unknown[]; nextCursor?: string };
    };
    assert.equal(secondResult.result.skills.length, 1);
    assert.equal(secondResult.result.nextCursor, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("subscriptions/listen rejects malformed notification filters", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root);
    const badBoolean = await handler(
      requestFor(1, "subscriptions/listen", {
        notifications: { resourcesListChanged: "yes" },
      }),
    );
    assert.equal(badBoolean.status, 400);
    assert.equal(((await badBoolean.json()) as { error: { code: number } }).error.code, -32602);

    const badResources = await handler(
      requestFor(2, "subscriptions/listen", {
        notifications: { resourceSubscriptions: ["skill://ok", 42] },
      }),
    );
    assert.equal(badResources.status, 400);
    assert.equal(((await badResources.json()) as { error: { code: number } }).error.code, -32602);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("subscriptions/listen advertises resource subscriptions and stamps notifications", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root);
    const response = await handler(
      requestFor(7, "subscriptions/listen", {
        notifications: {
          resourcesListChanged: true,
          resourceSubscriptions: ["skill://demo/SKILL.md"],
        },
      }),
    );
    const reader = response.body?.getReader();
    assert.ok(reader);
    const first = await reader.read();
    const acknowledgement = new TextDecoder().decode(first.value);
    assert.match(acknowledgement, /resourceSubscriptions/);
    assert.match(acknowledgement, /skill:\/\/demo\/SKILL.md/);
    await reader.cancel();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("subscriptions/listen sends targeted resource updates only to matching subscribers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    await mkdir(path.join(root, "skills", "demo"), { recursive: true });
    await writeFile(
      path.join(root, "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demo\n---\n",
    );
    await writeFile(path.join(root, "skills", "demo", "README.md"), "before");

    const handler = createMcpHandler(root);
    const target = await handler(
      requestFor(1, "subscriptions/listen", {
        notifications: { resourceSubscriptions: ["skill://demo/README.md"] },
      }),
    );
    const other = await handler(
      requestFor(2, "subscriptions/listen", {
        notifications: { resourceSubscriptions: ["skill://demo/SKILL.md"] },
      }),
    );
    const targetReader = target.body?.getReader();
    const otherReader = other.body?.getReader();
    assert.ok(targetReader);
    assert.ok(otherReader);

    await targetReader.read();
    await otherReader.read();

    const writeResponse = await handler(
      requestFor(3, "tools/call", {
        name: "write_files",
        arguments: { files: [{ path: "skills/demo/README.md", content: "after" }] },
      }),
    );
    assert.equal(writeResponse.status, 200);

    const targetEvent = new TextDecoder().decode((await targetReader.read()).value);
    assert.match(targetEvent, /notifications\/resources\/updated/);
    assert.match(targetEvent, /skill:\/\/demo\/README.md/);

    const unrelated = await Promise.race([
      otherReader.read().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    assert.equal(unrelated, false);

    await targetReader.cancel();
    await otherReader.cancel();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("subscriptions/listen uses list_changed for resource collection changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root);
    const response = await handler(
      requestFor(1, "subscriptions/listen", {
        notifications: { resourcesListChanged: true },
      }),
    );
    const reader = response.body?.getReader();
    assert.ok(reader);
    await reader.read();

    await mkdir(path.join(root, "skills", "demo"), { recursive: true });
    const createResponse = await handler(
      requestFor(2, "tools/call", {
        name: "write_files",
        arguments: {
          files: [
            {
              path: "skills/demo/SKILL.md",
              content: "---\nname: demo\ndescription: Demo\n---\n",
            },
          ],
        },
      }),
    );
    assert.equal(createResponse.status, 200);

    const created = new TextDecoder().decode((await reader.read()).value);
    assert.match(created, /notifications\/resources\/list_changed/);
    assert.doesNotMatch(created, /notifications\/resources\/updated/);

    const deleteResponse = await handler(
      requestFor(3, "tools/call", {
        name: "delete_files",
        arguments: { paths: ["skills/demo/SKILL.md"] },
      }),
    );
    assert.equal(deleteResponse.status, 200);

    const deleted = new TextDecoder().decode((await reader.read()).value);
    assert.match(deleted, /notifications\/resources\/list_changed/);
    assert.doesNotMatch(deleted, /notifications\/resources\/updated/);
    await reader.cancel();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("subscriptions/listen closes gracefully with server metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    const handler = createMcpHandler(root);
    const response = await handler(
      requestFor(1, "subscriptions/listen", {
        notifications: { resourcesListChanged: true },
      }),
    );
    const reader = response.body?.getReader();
    assert.ok(reader);
    await reader.read();

    handler.closeSubscriptions();
    const closing = new TextDecoder().decode((await reader.read()).value);
    assert.match(closing, /"resultType":"complete"/);
    assert.match(closing, /io\.modelcontextprotocol\/serverInfo/);
    assert.match(closing, /io\.modelcontextprotocol\/subscriptionId/);
    assert.equal((await reader.read()).done, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("subscriptions/listen removes canceled streams before resource notifications", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-modern-"));
  try {
    await mkdir(path.join(root, "skills", "demo"), { recursive: true });
    await writeFile(
      path.join(root, "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demo\n---\n",
    );
    await writeFile(path.join(root, "skills", "demo", "README.md"), "before");

    const handler = createMcpHandler(root);
    const response = await handler(
      requestFor(1, "subscriptions/listen", {
        notifications: { resourceSubscriptions: ["skill://demo/README.md"] },
      }),
    );
    const reader = response.body?.getReader();
    assert.ok(reader);
    await reader.read();
    await reader.cancel();

    const writeResponse = await handler(
      requestFor(2, "tools/call", {
        name: "write_files",
        arguments: { files: [{ path: "skills/demo/README.md", content: "after" }] },
      }),
    );
    assert.equal(writeResponse.status, 200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
