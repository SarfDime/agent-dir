import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SerenaIntegration } from "../src/serena.js";

async function fakeSerena(): Promise<{ bin: string; restore: () => void }> {
  const bin = await mkdtemp(path.join(tmpdir(), "agent-dir-serena-bin-"));
  const executable = path.join(bin, "serena");
  const script = [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    'if (args[0] === "--help") process.exit(0);',
    'if (args[0] === "project" && args[1] === "index") { const fs = require("node:fs"); const path = require("node:path"); const cache = path.join(args[2], ".serena", "cache", "typescript"); fs.mkdirSync(cache, {recursive:true}); fs.writeFileSync(path.join(cache, "document_symbols.pkl"), "indexed"); process.exit(0); }',
    'if (args[0] !== "start-mcp-server") process.exit(2);',
    'let buffer = ""; process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", chunk => { buffer += chunk; while (true) { const n = buffer.indexOf("\\n"); if (n < 0) return; const line = buffer.slice(0, n).trim(); buffer = buffer.slice(n + 1); if (!line) continue; const m = JSON.parse(line);',
    'if (m.method === "initialize") process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{protocolVersion:"2025-11-25",capabilities:{tools:{}},serverInfo:{name:"serena",version:"test"}}})+"\\n");',
    'else if (m.method === "tools/list") process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{tools:[{name:"find_symbol",description:"Find symbol",inputSchema:{type:"object",properties:{name:{type:"string"}}}},{name:"replace_symbol_body",description:"Replace symbol body",inputSchema:{type:"object"}},{name:"rename_symbol",description:"Rename symbol",inputSchema:{type:"object"}},{name:"insert_before_symbol",description:"Insert before symbol",inputSchema:{type:"object"}},{name:"create_text_file",description:"Create file",inputSchema:{type:"object"}},{name:"execute_shell_command",description:"Shell execution",inputSchema:{type:"object"}},{name:"find_referencing_symbols",description:"Find refs",inputSchema:{type:"object"}}]}})+"\\n");',
    'else if (m.method === "tools/call") process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{content:[{type:"text",text:"ok"}],structuredContent:{name:m.params.name,args:m.params.arguments}}})+"\\n");',
    "} });",
  ].join("\n");
  await writeFile(executable, script, "utf8");
  await chmod(executable, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + (oldPath ?? "");
  return {
    bin,
    restore: () => {
      process.env.PATH = oldPath;
    },
  };
}

test("Serena exposes read-only navigation and selected semantic edits, but no general write or shell tools", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-serena-"));
  const fake = await fakeSerena();
  try {
    await mkdir(path.join(root, ".serena"), { recursive: true });
    await writeFile(path.join(root, ".serena", "project.yml"), "language: typescript\n");
    const integration = new SerenaIntegration(root);
    const tools = await integration.prepare();
    assert.deepEqual(
      await import("node:fs/promises").then(({ readdir }) =>
        readdir(path.join(root, ".serena", "cache", "typescript")),
      ),
      ["document_symbols.pkl"],
    );
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [
        "find_symbol",
        "replace_symbol_body",
        "rename_symbol",
        "insert_before_symbol",
        "find_referencing_symbols",
      ],
    );
    const result = await integration.call("find_symbol", { name: "runServer" });
    assert.deepEqual(result.structuredContent, {
      name: "find_symbol",
      args: { name: "runServer" },
    });
    const edit = await integration.call("replace_symbol_body", {
      name: "runServer",
      body: "return true;",
    });
    assert.deepEqual(edit.structuredContent, {
      name: "replace_symbol_body",
      args: { name: "runServer", body: "return true;" },
    });
    await assert.rejects(() => integration.call("create_text_file", {}), /not allowed/);
    await assert.rejects(() => integration.call("execute_shell_command", {}), /not allowed/);
    await integration.close();
  } finally {
    fake.restore();
    await rm(fake.bin, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("Serena remains optional when the project is not configured", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-dir-serena-"));
  const fake = await fakeSerena();
  try {
    const integration = new SerenaIntegration(root);
    assert.deepEqual(await integration.prepare(), []);
    await integration.close();
  } finally {
    fake.restore();
    await rm(fake.bin, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
