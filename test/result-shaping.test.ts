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
  type AdapterResultShaping,
  type DiscoveryBundle,
  type DiscoveryOperation,
} from "@mcpaql/adapter-generator-core";

const repoRoot = path.resolve(import.meta.dirname, "..");
const fixturePath = path.join(import.meta.dirname, "fixtures/stdio-upstream.mjs");

function operation(name: string, params: string[] = []): DiscoveryOperation {
  return {
    source_tool_name: name,
    operation_name: name,
    description: name,
    endpoint: "READ",
    endpoint_confidence: "high",
    danger_level: "safe",
    needs_review: false,
    review_reasons: [],
    params: params.map((param) => ({ name: param, original_name: param, type: "object", required: true, source_path: param })),
    maps_to: `tool:${name}`,
  };
}

const bundle: DiscoveryBundle = {
  schema_version: "1.0.0-draft",
  source: {
    name: "shaping-fixture",
    server_url: "stdio://shaping-fixture",
    auth: { type: "none" },
    capture_config_redacted: { transport: { type: "stdio", command: process.execPath, args: [fixturePath] } },
  },
  normalized_bundle: { operations: [operation("big", ["size"]), operation("view", ["source"]), operation("plain")], warnings: [] },
};

const shaping: AdapterResultShaping = {
  max_result_chars: 1000,
  drop_duplicate_text: true,
  handles: [{
    operations: ["big"],
    id_path: "evidence_id",
    keep_paths: ["evidence_id", "limitations", "normalized_result.coverage"],
    continuation: { operation: "view", params: { source: { evidence_id: "${handle}" } } },
  }],
};

async function connect(t: { after: (fn: () => unknown) => void }, resultShaping?: AdapterResultShaping, env: Record<string, string> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mcpaql-shaping-adapter-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = buildSchemaFromDiscoveryBundle({ bundle, overrides: resultShaping ? { result_shaping: resultShaping } : undefined });
  for (const file of generateAdapterPackage({ schema: output.schema, provenance: output.metadata }).files) {
    await mkdir(path.dirname(path.join(dir, file.path)), { recursive: true });
    await writeFile(path.join(dir, file.path), file.content);
  }
  await symlink(path.join(repoRoot, "node_modules"), path.join(dir, "node_modules"), "dir");
  const client = new Client({ name: "shaping-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/server.ts"],
    cwd: dir,
    env: { ...getDefaultEnvironment(), ...env },
    stderr: "ignore",
  }));
  t.after(() => client.close());
  return async (args: Record<string, unknown>) =>
    JSON.parse(((await client.callTool({ name: "mcp_aql_read", arguments: args })).content as Array<{ text: string }>)[0].text);
}

test("without result_shaping, results pass through unchanged and _full_result is an ordinary param", async (t) => {
  // The budget override is ignored, and must not break startup, when shaping is off.
  const call = await connect(t, undefined, { MCPAQL_RESULT_BUDGET_CHARS: "5000" });
  const result = await call({ operation: "big", params: { size: 5000, _full_result: true } });
  assert.equal(result.data.content.length, 1);
  assert.equal(result.data.structured_content.normalized_result.payload.length, 5000);
  assert.deepEqual(result.data.structured_content.received, ["_full_result", "size"]);
  assert.equal(result._meta, undefined);
});

test("an oversized result with a handle rule becomes a summary plus a working continuation", async (t) => {
  const call = await connect(t, shaping);
  const result = await call({ operation: "big", params: { size: 5000 } });
  assert.equal(result.success, true);
  assert.equal(result.data.handle, "ev_fixture");
  assert.deepEqual(result.data.content, []);
  assert.deepEqual(result.data.structured_content, {
    evidence_id: "ev_fixture",
    limitations: ["fixture"],
    normalized_result: { coverage: { status: "complete" } },
  });
  assert.deepEqual(result.data.continuation, { tool: "mcp_aql_read", operation: "view", params: { source: { evidence_id: "ev_fixture" } } });
  assert.ok(result._meta.shaped.original_chars > 10_000);
  assert.ok(result._meta.shaped.returned_chars < 1000);
  assert.ok(result._meta.shaped.omitted.length >= 2);

  const { tool: _tool, ...continuation } = result.data.continuation;
  const followed = await call(continuation);
  assert.deepEqual(followed.data.structured_content, { viewed: "ev_fixture" });
});

test("small results only lose the duplicate text, and say so", async (t) => {
  const call = await connect(t, shaping);
  const result = await call({ operation: "big", params: { size: 10 } });
  assert.deepEqual(result.data.content, []);
  assert.equal(result.data.structured_content.normalized_result.payload.length, 10);
  assert.match(result._meta.shaped.omitted[0], /repeat structured_content exactly/);
  // Text that says something else than the structured content is kept.
  const view = await call({ operation: "view", params: { source: { evidence_id: "ev_x" } } });
  assert.equal(view.data.content[0].text, "ev_x");
  assert.equal(view._meta, undefined);
  // A result with no structuredContent keeps its text.
  const plain = await call({ operation: "plain" });
  assert.equal(plain.data.content[0].text, "text only");
  assert.equal(plain._meta, undefined);
});

test("params._full_result returns the unshaped result and never reaches the upstream", async (t) => {
  const call = await connect(t, shaping);
  const result = await call({ operation: "big", params: { size: 5000, _full_result: true } });
  assert.equal(result.data.content.length, 1);
  assert.equal(result.data.structured_content.normalized_result.payload.length, 5000);
  assert.deepEqual(result.data.structured_content.received, ["size"]);
  assert.equal(result._meta, undefined);
});

test("a non-zero MCPAQL_RESULT_BUDGET_CHARS overrides the schema budget", async (t) => {
  const call = await connect(t, shaping, { MCPAQL_RESULT_BUDGET_CHARS: "50000" });
  const result = await call({ operation: "big", params: { size: 5000 } });
  assert.equal(result.data.handle, undefined);
  assert.equal(result.data.structured_content.normalized_result.payload.length, 5000);
});

test("over budget without a usable handle, the full result returns with a reason", async (t) => {
  const call = await connect(t, { ...shaping, handles: [{ ...shaping.handles![0], id_path: "nope", keep_paths: ["nope"] }] });
  const result = await call({ operation: "big", params: { size: 5000 } });
  assert.equal(result.data.structured_content.normalized_result.payload.length, 5000);
  assert.match(result._meta.shaped.budget_exceeded.reason, /no handle at nope/);
});

test("each operation in a batch is shaped on its own", async (t) => {
  const call = await connect(t, shaping);
  const batch = await call({ operations: [
    { operation: "big", params: { size: 5000 } },
    { operation: "big", params: { size: 5000, _full_result: true } },
  ] });
  assert.equal(batch.results[0].result.data.handle, "ev_fixture");
  assert.equal(batch.results[1].result.data.structured_content.normalized_result.payload.length, 5000);
});

test("MCPAQL_RESULT_BUDGET_CHARS=0 turns the budget off", async (t) => {
  const call = await connect(t, shaping, { MCPAQL_RESULT_BUDGET_CHARS: "0" });
  const result = await call({ operation: "big", params: { size: 5000 } });
  assert.equal(result.data.handle, undefined);
  assert.equal(result.data.structured_content.normalized_result.payload.length, 5000);
});

test("result_shaping is validated against the adapter's operations", () => {
  const build = (resultShaping: unknown) => () =>
    buildSchemaFromDiscoveryBundle({ bundle, overrides: { result_shaping: resultShaping as AdapterResultShaping } });
  const rule = shaping.handles![0];
  assert.throws(build({ max_result_chars: 10, handles: [{ ...rule, operations: ["missing"] }] }), /names operation 'missing'/);
  assert.throws(build({ max_result_chars: 10, handles: [{ ...rule, continuation: { operation: "missing", params: {} } }] }), /must be a READ operation/);
  assert.throws(build({ max_result_chars: 10, handles: [{ ...rule, continuation: { operation: "view", params: {} } }] }), /must pass the handle/);
  assert.throws(build({ max_result_chars: 10, handles: [{ ...rule, keep_paths: ["limitations"] }] }), /must include id_path/);
  assert.throws(build({ max_result_chars: -1 }), /non-negative integer/);
  assert.throws(build({ drop_duplicate_text: "yes" }), /must be a boolean/);
  assert.throws(build({ handles: {} }), /handles must be an array/);
  assert.throws(build({ handles: [rule] }), /max_result_chars must be positive/);
  assert.throws(build({ max_result_chars: 10, handles: [{ ...rule, keep_paths: ["evidence_id", "__proto__.x"] }] }), /without empty, __proto__/);
  assert.throws(build({ max_result_chars: 10, handles: [{ ...rule, id_path: "constructor" }] }), /without empty, __proto__/);
  const withReserved: DiscoveryBundle = {
    ...bundle,
    normalized_bundle: { ...bundle.normalized_bundle, operations: [...bundle.normalized_bundle.operations, operation("echo", ["_full_result"])] },
  };
  assert.throws(
    () => buildSchemaFromDiscoveryBundle({ bundle: withReserved, overrides: { result_shaping: { drop_duplicate_text: true } } }),
    /declares a '_full_result' parameter/,
  );
  assert.deepEqual(buildSchemaFromDiscoveryBundle({ bundle, overrides: { result_shaping: shaping } }).schema.result_shaping, shaping);
});
