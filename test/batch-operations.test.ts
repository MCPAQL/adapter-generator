import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  buildSchemaFromDiscoveryBundle,
  generateAdapterPackage,
  type DiscoveryBundle,
  type DiscoveryOperation,
} from "@mcpaql/adapter-generator-core";

const repoRoot = path.resolve(import.meta.dirname, "..");
const fixturePath = path.join(import.meta.dirname, "fixtures/stdio-upstream.mjs");

function operation(name: string, endpoint: DiscoveryOperation["endpoint"], danger: DiscoveryOperation["danger_level"] = "safe"): DiscoveryOperation {
  return {
    source_tool_name: name,
    operation_name: name,
    description: name,
    endpoint,
    endpoint_confidence: "high",
    danger_level: danger,
    needs_review: false,
    review_reasons: [],
    params: name === "echo"
      ? [{ name: "message", original_name: "message", type: "string", required: true, source_path: "message" }]
      : [],
    maps_to: `tool:${name}`,
  };
}

const bundle: DiscoveryBundle = {
  schema_version: "1.0.0-draft",
  source: {
    name: "batch-fixture",
    server_url: "stdio://batch-fixture",
    auth: { type: "none" },
    capture_config_redacted: { transport: { type: "stdio", command: process.execPath, args: [fixturePath] } },
  },
  normalized_bundle: {
    operations: [
      operation("echo", "READ"),
      operation("count", "READ"),
      // A dangerous READ: must be called on its own.
      operation("env_keys", "READ", "dangerous"),
      operation("crash", "EXECUTE", "dangerous"),
    ],
    warnings: [],
  },
};

async function connect(t: { after: (fn: () => unknown) => void }, env: Record<string, string> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcpaql-batch-adapter-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = buildSchemaFromDiscoveryBundle({ bundle });
  for (const file of generateAdapterPackage({ schema: output.schema, provenance: output.metadata }).files) {
    await mkdir(path.dirname(path.join(dir, file.path)), { recursive: true });
    await writeFile(path.join(dir, file.path), file.content);
  }
  await symlink(path.join(repoRoot, "node_modules"), path.join(dir, "node_modules"), "dir");
  const client = new Client({ name: "batch-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/server.ts"],
    cwd: dir,
    env: { ...getDefaultEnvironment(), ...env },
    stderr: "ignore",
  }));
  t.after(() => client.close());
  const call = async (name: string, args: Record<string, unknown>) =>
    JSON.parse(((await client.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0].text);
  return { client, call };
}

test("a READ batch runs in order on one upstream and reports each result", async (t) => {
  const { call } = await connect(t);
  const batch = await call("mcp_aql_read", {
    operations: [
      { operation: "echo", params: { message: "hi" } },
      { operation: "count" },
      { operation: "count" },
      { operation: "no_such_operation" },
      { operation: "crash" },
      { params: {} },
    ],
  });
  assert.equal(batch.success, true);
  assert.deepEqual(batch.results.map((entry: { index: number }) => entry.index), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(batch.results[0].result.data.structured_content, { message: "hi" });
  assert.equal(batch.results[1].result.data.structured_content.calls, 1);
  assert.equal(batch.results[2].result.data.structured_content.calls, 2);
  assert.equal(batch.results[1].result.data.structured_content.pid, batch.results[2].result.data.structured_content.pid);
  assert.equal(batch.results[3].result.error.code, "NOT_FOUND_OPERATION");
  // An EXECUTE operation inside a READ batch is routed per operation and refused.
  assert.equal(batch.results[4].result.error.code, "VALIDATION_WRONG_ENDPOINT");
  assert.equal(batch.results[5].result.error.code, "VALIDATION_MISSING_OPERATION");
  assert.deepEqual(batch.summary, { total: 6, succeeded: 3, failed: 3 });
});

test("the EXECUTE endpoint refuses batches and does not advertise them", async (t) => {
  const { client, call } = await connect(t);
  const result = await call("mcp_aql_execute", { operations: [{ operation: "crash" }] });
  assert.equal(result.success, false);
  assert.equal(result.error.code, "VALIDATION_BATCH_NOT_ALLOWED");

  const tools = (await client.listTools()).tools;
  const execute = tools.find((tool) => tool.name === "mcp_aql_execute");
  const read = tools.find((tool) => tool.name === "mcp_aql_read");
  assert.equal("operations" in (execute?.inputSchema.properties ?? {}), false);
  assert.ok("operations" in (read?.inputSchema.properties ?? {}));
  assert.match(execute?.description ?? "", /one at a time/);
  assert.match(read?.description ?? "", /Batch independent operations/);
});

test("a batch halts before an operation that needs its own approval", async (t) => {
  const { call } = await connect(t);
  const batch = await call("mcp_aql_read", {
    operations: [{ operation: "count" }, { operation: "env_keys" }, { operation: "count" }],
  });
  assert.equal(batch.success, true);
  assert.equal(batch.results.length, 1);
  assert.equal(batch.halted_at.index, 1);
  assert.equal(batch.halted_at.result.error.code, "VALIDATION_SINGLE_CALL_REQUIRED");
  assert.deepEqual(batch.pending_operations, [{ index: 2, operation: "count" }]);
  assert.deepEqual(batch.summary, { total: 3, succeeded: 1, failed: 0, halted: 1, pending: 1 });

  // Nothing after the halt ran; the dangerous operation still works as a single call.
  const next = await call("mcp_aql_read", { operation: "count" });
  assert.equal(next.data.structured_content.calls, 2);
  assert.equal((await call("mcp_aql_read", { operation: "env_keys" })).success, true);
});

test("batch size and request shape are validated", async (t) => {
  const { call } = await connect(t, { MCPAQL_MAX_BATCH_OPERATIONS: "2" });
  const tooMany = await call("mcp_aql_read", { operations: [{ operation: "count" }, { operation: "count" }, { operation: "count" }] });
  assert.equal(tooMany.error.code, "VALIDATION_BATCH_SIZE");
  const empty = await call("mcp_aql_read", { operations: [] });
  assert.equal(empty.error.code, "VALIDATION_BATCH_SIZE");
  const ambiguous = await call("mcp_aql_read", { operation: "count", operations: [{ operation: "count" }] });
  assert.equal(ambiguous.error.code, "VALIDATION_AMBIGUOUS_REQUEST");
  // Nothing above reached the upstream.
  assert.equal((await call("mcp_aql_read", { operation: "count" })).data.structured_content.calls, 1);
});
