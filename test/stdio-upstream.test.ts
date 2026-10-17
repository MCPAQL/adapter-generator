import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
      : name === "slow"
        ? [
            { name: "ms", original_name: "ms", type: "number", required: true, source_path: "ms" },
            { name: "progress_every_ms", original_name: "progress_every_ms", type: "number", required: false, source_path: "progress_every_ms" },
          ]
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
    operations: [
      operation("echo", "READ"),
      operation("count", "READ"),
      operation("env_keys", "READ"),
      operation("slow", "READ"),
      operation("aborted_count", "READ"),
      operation("crash", "EXECUTE"),
    ],
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
  assert.match(readme, /MCPAQL_UPSTREAM_TIMEOUT_MS/);
  assert.match(readme, /MCPAQL_UPSTREAM_MAX_TOTAL_TIMEOUT_MS/);
});

async function writeGeneratedAdapter(bundle: DiscoveryBundle = stdioBundle): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcpaql-stdio-adapter-"));
  const output = buildSchemaFromDiscoveryBundle({ bundle });
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
  const crashed = parse(await client.callTool({ name: "mcp_aql_execute", arguments: { operation: "crash" } }));
  assert.equal(crashed.success, false);
  assert.equal(crashed.error.code, "UPSTREAM_CALL_FAILED");
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
  let timer: NodeJS.Timeout | undefined;
  const [code, signal] = await Promise.race([
    exited,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("adapter did not exit after stdin closed")), 10_000);
    }),
  ]).finally(() => clearTimeout(timer));
  assert.equal(signal, null);
  assert.equal(code, 0);
  assert.ok(await waitForExit(childPid, 10_000), `upstream child ${childPid} still running`);
});

test("redacted launch values are refused with guidance", () => {
  const withEnv = (transport: Record<string, unknown>): DiscoveryBundle => ({
    ...stdioBundle,
    source: { ...stdioBundle.source, capture_config_redacted: { transport: { type: "stdio", command: "npx", ...transport } } },
  });
  assert.throws(
    () => buildSchemaFromDiscoveryBundle({ bundle: withEnv({ env: { API_KEY: "<redacted>" } }) }),
    /redacted values \(env\.API_KEY\).*overrides\.stdio/,
  );
  assert.throws(() => buildSchemaFromDiscoveryBundle({ bundle: withEnv({ args: ["--token", "<redacted>"] }) }), /args\[1\]/);
  // Supplying the value through overrides fixes it.
  const { schema } = buildSchemaFromDiscoveryBundle({
    bundle: withEnv({ env: { API_KEY: "<redacted>", OTHER: "x" } }),
    overrides: { stdio: { env: { API_KEY: "${env:API_KEY}" } } },
  });
  // An override replaces the whole env field.
  assert.deepEqual(schema.target.stdio?.env, { API_KEY: "${env:API_KEY}" });
});

test("overrides.stdio fields are type-checked like captured ones", () => {
  const bad = (stdio: Record<string, unknown>) => () =>
    buildSchemaFromDiscoveryBundle({ bundle: stdioBundle, overrides: { stdio: stdio as never } });
  assert.throws(bad({ env_passthrough: "HOME" }), /env_passthrough must be an array of strings/);
  assert.throws(bad({ args: "oops" }), /args must be an array of strings/);
  assert.throws(bad({ cwd: 5 }), /cwd must be a string/);
  assert.throws(bad({ env: ["A"] }), /env must be an object/);
});

test("bearer auth on a stdio capture is dropped with a warning", () => {
  const output = buildSchemaFromDiscoveryBundle({
    bundle: { ...stdioBundle, source: { ...stdioBundle.source, auth: { type: "bearer", token_env: "X" } } },
  });
  assert.equal(output.schema.auth, undefined);
  assert.ok(output.warnings.some((warning) => warning.code === "STDIO_AUTH_IGNORED"));
  assert.equal(output.metadata.warning_count, output.warnings.length);
});

test("stopping the adapter while its child is still starting reaps the child", async (t) => {
  const bundle: DiscoveryBundle = {
    ...stdioBundle,
    source: {
      ...stdioBundle.source,
      capture_config_redacted: {
        ...stdioBundle.source.capture_config_redacted,
        env_passthrough: ["FIXTURE_PASS", "FIXTURE_PID_FILE", "FIXTURE_START_DELAY_MS"],
      },
    },
  };
  const dir = await writeGeneratedAdapter(bundle);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, "child.pid");
  const adapter = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: dir,
    env: { ...getDefaultEnvironment(), FIXTURE_SOURCE: "s", FIXTURE_PID_FILE: pidFile, FIXTURE_START_DELAY_MS: "60000" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  t.after(() => adapter.kill("SIGKILL"));
  const lines = readline.createInterface({ input: adapter.stdout! });
  const initialized = new Promise<void>((resolve) => lines.once("line", () => resolve()));
  adapter.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } })}\n`);
  await initialized;
  adapter.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  adapter.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mcp_aql_read", arguments: { operation: "count" } } })}\n`);

  let childPid: number | undefined;
  const deadline = Date.now() + 10_000;
  while (childPid === undefined && Date.now() < deadline) {
    // The file can exist before its contents are written; only a positive pid counts.
    const pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
    if (Number.isInteger(pid) && pid > 0) {
      childPid = pid;
    } else {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.ok(childPid, "child never started");

  const exited = once(adapter, "exit");
  adapter.kill("SIGTERM");
  await exited;
  assert.ok(await waitForExit(childPid!, 10_000), `starting child ${childPid} was orphaned`);
});

async function connectAdapter(t: { after: (fn: () => unknown) => void }, env: Record<string, string> = {}) {
  const dir = await writeGeneratedAdapter();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const client = new Client({ name: "stdio-adapter-call-control", version: "0.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/server.ts"],
    cwd: dir,
    env: { ...getDefaultEnvironment(), FIXTURE_SOURCE: "s", ...env },
    stderr: "ignore",
  }));
  t.after(() => client.close());
  return client;
}

const slow = (ms: number, progressEveryMs?: number) => ({
  name: "mcp_aql_read",
  arguments: { operation: "slow", params: { ms, ...(progressEveryMs ? { progress_every_ms: progressEveryMs } : {}) } },
});

test("upstream progress is forwarded to a caller that asked for it", async (t) => {
  const client = await connectAdapter(t);
  const events: Array<{ progress: number; message?: string }> = [];
  const result = parse(await client.callTool(slow(450, 100), undefined, { onprogress: (progress) => events.push(progress) }));
  assert.equal(result.success, true);
  assert.ok(events.length >= 3, `expected forwarded progress, got ${events.length}`);
  assert.equal(events[0].message, "step 1");
});

test("the upstream deadline returns UPSTREAM_TIMEOUT and is extended by progress", async (t) => {
  const client = await connectAdapter(t, { MCPAQL_UPSTREAM_TIMEOUT_MS: "300" });
  const silent = parse(await client.callTool(slow(1200)));
  assert.equal(silent.success, false);
  assert.equal(silent.error.code, "UPSTREAM_TIMEOUT");
  assert.equal(silent.error.details.timeout_ms, 300);
  assert.equal(silent.error.details.limit, "per_call");
  // Progress every 100 ms keeps resetting the 300 ms deadline, even though this caller did not ask for progress.
  const reporting = parse(await client.callTool(slow(1200, 100)));
  assert.equal(reporting.success, true);
});

test("MCPAQL_UPSTREAM_MAX_TOTAL_TIMEOUT_MS caps calls with or without progress and cancels the upstream", async (t) => {
  const client = await connectAdapter(t, { MCPAQL_UPSTREAM_TIMEOUT_MS: "300", MCPAQL_UPSTREAM_MAX_TOTAL_TIMEOUT_MS: "600" });
  const started = Date.now();
  const reporting = parse(await client.callTool(slow(3000, 100)));
  assert.equal(reporting.success, false);
  assert.equal(reporting.error.code, "UPSTREAM_TIMEOUT");
  assert.equal(reporting.error.details.limit, "max_total");
  assert.equal(reporting.error.details.timeout_ms, 600);
  assert.ok(Date.now() - started < 1500, "cap fired late");

  // A silent upstream is capped too, even with a per-call deadline longer than the cap.
  const silentClient = await connectAdapter(t, { MCPAQL_UPSTREAM_TIMEOUT_MS: "60000", MCPAQL_UPSTREAM_MAX_TOTAL_TIMEOUT_MS: "500" });
  const silentStart = Date.now();
  const silent = parse(await silentClient.callTool(slow(3000)));
  assert.equal(silent.error.details.limit, "max_total");
  assert.ok(Date.now() - silentStart < 1500, "cap did not apply to a silent upstream");

  // The cap cancels the upstream call instead of leaving it running.
  let aborted = 0;
  const deadline = Date.now() + 3000;
  while (aborted === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    aborted = parse(await silentClient.callTool({ name: "mcp_aql_read", arguments: { operation: "aborted_count" } })).data.structured_content.aborted;
  }
  assert.equal(aborted, 1);
});

test("cancelling the downstream request cancels the upstream call", async (t) => {
  const client = await connectAdapter(t);
  // Start the upstream first, so the abort cannot land while the child is still being spawned.
  await client.callTool({ name: "mcp_aql_read", arguments: { operation: "aborted_count" } });
  const controller = new AbortController();
  // Abort on the first forwarded progress event: by then the upstream is running this call.
  const pending = client.callTool(slow(5000, 50), undefined, { signal: controller.signal, onprogress: () => controller.abort() });
  await assert.rejects(pending);
  // Give the cancellation notification time to reach the upstream.
  let aborted = 0;
  const deadline = Date.now() + 3000;
  while (aborted === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    aborted = parse(await client.callTool({ name: "mcp_aql_read", arguments: { operation: "aborted_count" } })).data.structured_content.aborted;
  }
  assert.equal(aborted, 1);
});

test("invalid timeout settings are reported, not ignored", { timeout: 30_000 }, async (t) => {
  const dir = await writeGeneratedAdapter();
  t.after(() => rm(dir, { recursive: true, force: true }));
  // "3000000000" exceeds Node's timer range and would otherwise fire after 1 ms.
  for (const value of ["soon", "1e3", "0x3e8", "0", "3000000000"]) {
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
        cwd: dir,
        env: { ...getDefaultEnvironment(), MCPAQL_UPSTREAM_TIMEOUT_MS: value },
        stdio: ["pipe", "ignore", "pipe"],
      });
      const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      let stderr = "";
      child.stderr!.on("data", (chunk) => { stderr += chunk; });
      child.on("exit", (code) => {
        clearTimeout(killer);
        resolve({ code, stderr });
      });
    });
    assert.notEqual(result.code, 0, value);
    assert.match(result.stderr, /MCPAQL_UPSTREAM_TIMEOUT_MS must be a positive integer number of milliseconds, at most 2147483647/, value);
  }
});
