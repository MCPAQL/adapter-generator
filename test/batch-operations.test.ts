import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
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
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const batchSchema = JSON.parse(readFileSync(path.join(repoRoot, "../spec/schemas/batch-operation.schema.json"), "utf8"));
const ajv = new Ajv2020({ strict: false, allErrors: true });
require("ajv-formats").default(ajv);
const validateBatchResponse = ajv.compile(batchSchema);
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
      : name === "slow"
        ? [{ name: "ms", original_name: "ms", type: "number", required: true, source_path: "ms" },
           { name: "progress_every_ms", original_name: "progress_every_ms", type: "number", required: false, source_path: "progress_every_ms" }]
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
      operation("slow", "READ"),
      // A dangerous UPDATE: UPDATE batches halt before it.
      operation("aborted_count", "UPDATE", "dangerous"),
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
  assert.deepEqual(batch.pending_operations, [{ index: 2, operation: "count", params: {} }]);
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

test("pending operations keep the spec shape, whatever the entries look like", async (t) => {
  const { call } = await connect(t);
  const batch = await call("mcp_aql_update", {
    operations: [
      { operation: "aborted_count" },
      { operation: "echo", message: "flat", index: 99 },
      { operation: "count", params: { a: 1 } },
      "not an object",
    ],
  });
  assert.equal(batch.halted_at.index, 0);
  assert.match(batch.halted_at.result.error.message, /requires confirmation/);
  assert.deepEqual(batch.pending_operations, [
    { index: 1, operation: "echo", params: { message: "flat", index: 99 } },
    { index: 2, operation: "count", params: { a: 1 } },
    { index: 3, operation: "", params: {} },
  ]);
});

test("batch progress only increases and spans the whole batch", async (t) => {
  const { client } = await connect(t);
  const events: Array<{ progress: number; total?: number }> = [];
  const result = await client.callTool(
    { name: "mcp_aql_read", arguments: { operations: [
      { operation: "slow", params: { ms: 300, progress_every_ms: 50 } },
      { operation: "slow", params: { ms: 300, progress_every_ms: 50 } },
    ] } },
    undefined,
    { onprogress: (progress) => events.push(progress) },
  );
  assert.ok(result);
  assert.ok(events.length >= 3, `expected batch progress, got ${events.length}`);
  for (let index = 1; index < events.length; index += 1) {
    assert.ok(events[index].progress > events[index - 1].progress, `progress went from ${events[index - 1].progress} to ${events[index].progress}`);
  }
  assert.ok(events.every((event) => event.total === 2));
  assert.equal(events[events.length - 1].progress, 2);
});

test("batch responses validate against the spec batch schema, and introspection advertises batching", async (t) => {
  const { call } = await connect(t);
  const plain = await call("mcp_aql_read", { operations: [{ operation: "count" }, { operation: "no_such_operation" }] });
  const halted = await call("mcp_aql_read", { operations: [{ operation: "count" }, { operation: "env_keys" }, { operation: "count", params: { a: 1 } }] });
  for (const response of [plain, halted]) {
    assert.ok(validateBatchResponse(response), JSON.stringify(validateBatchResponse.errors));
  }
  const introspection = await call("mcp_aql_read", { operation: "introspect", params: { query: "operations" } });
  assert.deepEqual(introspection.data._protocol.capabilities, { batch: true, batch_max_operations: 25, batch_excluded_endpoints: ["EXECUTE"] });
});

test("switching the active tenant is a single-call operation", () => {
  const tenancyBundle: DiscoveryBundle = {
    ...bundle,
    source: { ...bundle.source, server_url: "https://example.com/mcp", capture_config_redacted: { transport: "streamable_http" } },
    normalized_bundle: { operations: [operation("list_projects", "READ"), operation("update_thing", "UPDATE", "reversible")], warnings: [] },
  };
  const output = buildSchemaFromDiscoveryBundle({
    bundle: tenancyBundle,
    overrides: { tenancy: { header: "X-Project-Id", noun: "project", list_operation: "list_projects", id_field: "id", name_field: "name" } },
  });
  const server = generateAdapterPackage({ schema: output.schema, provenance: output.metadata }).files.find((file) => file.path === "src/server.ts")?.content ?? "";
  assert.match(server, /definition\.maps_to\.startsWith\("adapter:set_active_"\)/);
  // The tenancy runtime adds set_active_<noun> to the schema before the operation index is built,
  // so the batch check sees it.
  const added = server.indexOf('maps_to: "adapter:" + SET_ACTIVE_TENANT');
  assert.ok(added > 0 && added < server.indexOf("const TOOL_BY_OPERATION"));
});

test("upstream progress without a total keeps a long batch operation alive", async (t) => {
  const { client } = await connect(t);
  const events: number[] = [];
  // The fixture reports progress with no total every 50 ms; a 400 ms deadline that resets on
  // progress only survives a 1 s operation if the batch forwards those events.
  const result = await client.callTool(
    { name: "mcp_aql_read", arguments: { operations: [{ operation: "slow", params: { ms: 1000, progress_every_ms: 50 } }] } },
    undefined,
    { timeout: 400, resetTimeoutOnProgress: true, onprogress: (progress) => events.push(progress.progress) },
  );
  const batch = JSON.parse((result.content as Array<{ text: string }>)[0].text);
  assert.equal(batch.results[0].result.success, true);
  assert.ok(events.length > 5, `expected forwarded progress, got ${events.length}`);
  for (let index = 1; index < events.length; index += 1) assert.ok(events[index] > events[index - 1]);
  assert.ok(events.slice(0, -1).every((value) => value < 1));
  assert.equal(events[events.length - 1], 1);
});
