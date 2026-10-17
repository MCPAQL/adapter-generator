import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import ts from "typescript";

import {
  buildSchemaFromDiscoveryBundle,
  generateAdapterPackage,
  type DiscoveryBundle,
  type DiscoveryOperation,
} from "@mcpaql/adapter-generator-core";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const fixturePath = path.join(import.meta.dirname, "fixtures/stdio-upstream.mjs");

function operation(name: string, endpoint: DiscoveryOperation["endpoint"]): DiscoveryOperation {
  return {
    source_tool_name: name,
    operation_name: name,
    description: name,
    endpoint,
    endpoint_confidence: "high",
    danger_level: endpoint === "EXECUTE" ? "dangerous" : "safe",
    needs_review: false,
    review_reasons: [],
    params: name === "echo"
      ? [{ name: "message", original_name: "message", type: "string", required: true, source_path: "message" }]
      : [],
    maps_to: `tool:${name}`,
  };
}

const stdioBundle: DiscoveryBundle = {
  schema_version: "1.0.0-draft",
  source: {
    name: "stdio-fixture",
    server_url: "stdio://stdio-fixture",
    auth: { type: "none" },
    capture_config_redacted: {
      transport: "stdio",
      command: process.execPath,
      args: [fixturePath],
      env_passthrough: ["FIXTURE_PASS"],
      env: { FIXTURE_SECRET: "${env:FIXTURE_SOURCE}" },
      headers: { "X-Ignored": "yes" },
    },
  },
  normalized_bundle: {
    operations: [operation("echo", "READ"), operation("count", "READ"), operation("env_keys", "READ"), operation("crash", "EXECUTE")],
    warnings: [],
  },
};

function serverSource(bundle: DiscoveryBundle): string {
  const output = buildSchemaFromDiscoveryBundle({ bundle, generatedAt: "2026-10-17T00:00:00.000Z" });
  return generateAdapterPackage({ schema: output.schema, provenance: output.metadata })
    .files.find((file) => file.path === "src/server.ts")?.content ?? "";
}

test("schema builder emits a stdio target without auth or headers", () => {
  const { schema } = buildSchemaFromDiscoveryBundle({ bundle: stdioBundle });
  assert.equal(schema.target.transport, "stdio");
  assert.deepEqual(schema.target.stdio, {
    command: process.execPath,
    args: [fixturePath],
    env_passthrough: ["FIXTURE_PASS"],
    env: { FIXTURE_SECRET: "${env:FIXTURE_SOURCE}" },
  });
  assert.equal(schema.auth, undefined);
  assert.equal(schema.headers, undefined);
});

test("schema builder reads launch fields from an interrogation-style transport object", () => {
  const bundle: DiscoveryBundle = {
    ...stdioBundle,
    source: {
      ...stdioBundle.source,
      server_url: "stdio://example",
      capture_config_redacted: {
        name: "example",
        transport: { type: "stdio", command: "npx", args: ["-y", "example-mcp@1.2.3", "mcp"] },
      },
    },
  };
  const { schema } = buildSchemaFromDiscoveryBundle({ bundle });
  assert.equal(schema.target.transport, "stdio");
  assert.deepEqual(schema.target.stdio, { command: "npx", args: ["-y", "example-mcp@1.2.3", "mcp"] });
});

test("overrides.stdio pins launch fields over the capture", () => {
  const { schema } = buildSchemaFromDiscoveryBundle({
    bundle: stdioBundle,
    overrides: { stdio: { command: "npx", args: ["-y", "example-mcp@1.2.3", "mcp"] } },
  });
  assert.equal(schema.target.stdio?.command, "npx");
  assert.deepEqual(schema.target.stdio?.args, ["-y", "example-mcp@1.2.3", "mcp"]);
  assert.deepEqual(schema.target.stdio?.env_passthrough, ["FIXTURE_PASS"]);
});

test("invalid stdio configurations are refused", () => {
  const withCapture = (capture: Record<string, unknown>): DiscoveryBundle => ({
    ...stdioBundle,
    source: { ...stdioBundle.source, capture_config_redacted: { transport: "stdio", ...capture } },
  });
  assert.throws(() => buildSchemaFromDiscoveryBundle({ bundle: withCapture({}) }), /requires a command/);
  assert.throws(
    () => buildSchemaFromDiscoveryBundle({ bundle: withCapture({ command: "x", env_passthrough: ["BAD-NAME"] }) }),
    /Invalid stdio environment variable name/,
  );
  assert.throws(
    () => buildSchemaFromDiscoveryBundle({ bundle: withCapture({ command: "x", args: "not-an-array" }) }),
    /args must be an array of strings/,
  );
  const httpBundle: DiscoveryBundle = {
    ...stdioBundle,
    source: { ...stdioBundle.source, server_url: "https://example.com/mcp", capture_config_redacted: { transport: "streamable_http" } },
  };
  assert.throws(
    () => buildSchemaFromDiscoveryBundle({ bundle: httpBundle, overrides: { stdio: { command: "x" } } }),
    /only to stdio upstreams/,
  );
});

test("stdio adapters import the stdio client and none of the HTTP auth runtime", () => {
  const source = serverSource(stdioBundle);
  assert.match(source, /import \{ StdioClientTransport, getDefaultEnvironment \} from "@modelcontextprotocol\/sdk\/client\/stdio\.js"/);
  assert.doesNotMatch(source, /StreamableHTTPClientTransport/);
  assert.doesNotMatch(source, /function resolveToken/);
  assert.match(source, /stderr: "inherit"/);
  assert.match(source, /closingUpstream = true;/);
  assert.match(source, /code: "UPSTREAM_UNAVAILABLE"/);
});

test("stdio child environment is the SDK default plus declared variables only", () => {
  const source = serverSource(stdioBundle);
  const functions = ["resolveStdioTarget", "resolveChildEnvValue", "buildChildEnvironment"]
    .map((name) => new RegExp(`function ${name}[\\s\\S]*?\\n}\\n`).exec(source)?.[0])
    .join("\n");
  const js = ts.transpile(functions, { target: ts.ScriptTarget.ES2022 });
  const { schema } = buildSchemaFromDiscoveryBundle({ bundle: stdioBundle });
  const build = (env: Record<string, string>) =>
    (new Function("schema", "process", "getDefaultEnvironment", `${js}; return buildChildEnvironment;`)(
      schema,
      { env },
      () => ({ PATH: "/usr/bin" }),
    ) as () => Record<string, string>)();

  assert.deepEqual(build({ FIXTURE_PASS: "p", FIXTURE_SOURCE: "s", UNRELATED_SECRET: "x" }), {
    PATH: "/usr/bin",
    FIXTURE_PASS: "p",
    FIXTURE_SECRET: "s",
  });
  assert.throws(() => build({}), /FIXTURE_SOURCE.*FIXTURE_SECRET/);
});

test("stdio README documents the launch command and child environment", () => {
  const { schema } = buildSchemaFromDiscoveryBundle({ bundle: stdioBundle });
  const readme = generateAdapterPackage({ schema }).files.find((file) => file.path === "README.md")?.content ?? "";
  assert.ok(readme.includes(`${process.execPath} ${fixturePath}`));
  assert.match(readme, /`FIXTURE_SOURCE` \(required\): passed to the upstream as `FIXTURE_SECRET`/);
  assert.match(readme, /`FIXTURE_PASS` \(optional\)/);
});

async function writeGeneratedAdapter(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcpaql-stdio-adapter-"));
  const output = buildSchemaFromDiscoveryBundle({ bundle: stdioBundle });
  for (const file of generateAdapterPackage({ schema: output.schema, provenance: output.metadata }).files) {
    await mkdir(path.dirname(path.join(dir, file.path)), { recursive: true });
    await writeFile(path.join(dir, file.path), file.content);
  }
  await symlink(path.join(repoRoot, "node_modules"), path.join(dir, "node_modules"), "dir");
  return dir;
}

function parse(result: Awaited<ReturnType<Client["callTool"]>>): { success: boolean; data?: any; error?: any } {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text);
}

test("generated stdio adapter typechecks and proxies to a live stdio upstream", async (t) => {
  const dir = await writeGeneratedAdapter();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await execFileAsync(path.join(repoRoot, "node_modules/.bin/tsc"), ["-p", path.join(dir, "tsconfig.json"), "--noEmit"]);

  const client = new Client({ name: "stdio-adapter-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/server.ts"],
    cwd: dir,
    env: { ...getDefaultEnvironment(), FIXTURE_PASS: "p", FIXTURE_SOURCE: "s", UNRELATED_SECRET: "x" },
    stderr: "ignore",
  }));
  t.after(() => client.close());

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["mcp_aql_execute", "mcp_aql_read"]);

  const echo = parse(await client.callTool({ name: "mcp_aql_read", arguments: { operation: "echo", params: { message: "hi" } } }));
  assert.equal(echo.success, true);
  assert.deepEqual(echo.data.structured_content, { message: "hi" });

  const env = parse(await client.callTool({ name: "mcp_aql_read", arguments: { operation: "env_keys" } }));
  assert.equal(env.data.structured_content.secret, "s");
  assert.ok(env.data.structured_content.keys.includes("FIXTURE_PASS"));
  assert.ok(!env.data.structured_content.keys.includes("UNRELATED_SECRET"));

  // One child serves every call, so upstream state persists.
  const first = parse(await client.callTool({ name: "mcp_aql_read", arguments: { operation: "count" } }));
  const second = parse(await client.callTool({ name: "mcp_aql_read", arguments: { operation: "count" } }));
  assert.equal(first.data.structured_content.calls, 1);
  assert.equal(second.data.structured_content.calls, 2);
  assert.equal(first.data.structured_content.pid, second.data.structured_content.pid);

  // A crash fails the in-flight call, the next call reports the lost session once, then a fresh child starts.
  await assert.rejects(client.callTool({ name: "mcp_aql_execute", arguments: { operation: "crash" } }));
  const notice = parse(await client.callTool({ name: "mcp_aql_read", arguments: { operation: "count" } }));
  assert.equal(notice.success, false);
  assert.equal(notice.error.code, "UPSTREAM_UNAVAILABLE");
  assert.match(notice.error.message, /session state was lost/);
  const fresh = parse(await client.callTool({ name: "mcp_aql_read", arguments: { operation: "count" } }));
  assert.equal(fresh.data.structured_content.calls, 1);
  assert.notEqual(fresh.data.structured_content.pid, first.data.structured_content.pid);

  // Closing the adapter stops the upstream child.
  const childPid: number = fresh.data.structured_content.pid;
  await client.close();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      process.kill(childPid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`upstream child ${childPid} still running after adapter close`);
});

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test("concurrent first calls share one upstream child", async (t) => {
  const dir = await writeGeneratedAdapter();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const client = new Client({ name: "stdio-adapter-race", version: "0.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/server.ts"],
    cwd: dir,
    env: { ...getDefaultEnvironment(), FIXTURE_SOURCE: "s" },
    stderr: "ignore",
  }));
  t.after(() => client.close());

  const results = await Promise.all(
    [0, 1, 2].map(() => client.callTool({ name: "mcp_aql_read", arguments: { operation: "count" } }).then(parse)),
  );
  const pids = new Set(results.map((result) => result.data.structured_content.pid));
  assert.equal(pids.size, 1);
  assert.deepEqual(results.map((result) => result.data.structured_content.calls).sort(), [1, 2, 3]);
});

test("closing the adapter's stdin without a signal stops the adapter and its child", async (t) => {
  const dir = await writeGeneratedAdapter();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const adapter = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: dir,
    env: { ...getDefaultEnvironment(), FIXTURE_SOURCE: "s" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  t.after(() => adapter.kill("SIGKILL"));
  const lines = readline.createInterface({ input: adapter.stdout! });
  const responses = new Map<number, (message: any) => void>();
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    responses.get(message.id)?.(message);
  });
  const request = (id: number, method: string, params: unknown) =>
    new Promise<any>((resolve) => {
      responses.set(id, resolve);
      adapter.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } });
  adapter.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const call = await request(2, "tools/call", { name: "mcp_aql_read", arguments: { operation: "count" } });
  const childPid: number = JSON.parse(call.result.content[0].text).data.structured_content.pid;

  const exited = once(adapter, "exit");
  adapter.stdin!.end();
  const [code, signal] = await Promise.race([
    exited,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("adapter did not exit after stdin closed")), 10_000)),
  ]);
  assert.equal(signal, null);
  assert.equal(code, 0);
  assert.ok(await waitForExit(childPid, 10_000), `upstream child ${childPid} still running`);
});
