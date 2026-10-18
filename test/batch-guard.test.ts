import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AdapterSchemaDocument, AdapterSchemaOperation } from "@mcpaql/adapter-generator-core";
import { generateAdapterPackage } from "../src/generator.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const fixturePath = path.join(import.meta.dirname, "fixtures/batch-guard-upstream.mjs");
const guards: Array<{ name: string; flags: Partial<AdapterSchemaOperation> }> = [
  { name: "destructive_missing", flags: { danger_level: "destructive" } },
  { name: "destructive_false", flags: { danger_level: "destructive", requires_confirmation: false } },
  { name: "dangerous_missing", flags: { danger_level: "dangerous" } },
  { name: "dangerous_false", flags: { danger_level: "dangerous", requires_confirmation: false } },
  { name: "confirmation", flags: { danger_level: "safe", requires_confirmation: true } },
];

for (const transport of ["stdio", "http"] as const) {
  test(`supplied-schema ${transport} adapters halt guarded CRUD batches before dispatch`, async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mcpaql-batch-guard-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    let baseUrl = "stdio://batch-guard-fixture";
    if (transport === "http") {
      const upstream = spawn(process.execPath, [fixturePath, "--http"], { stdio: ["ignore", "pipe", "inherit"] });
      t.after(async () => {
        if (upstream.exitCode === null) {
          const exited = once(upstream, "exit");
          upstream.kill();
          await exited;
        }
      });
      const lines = readline.createInterface({ input: upstream.stdout });
      const ready = await Promise.race([
        once(lines, "line"),
        once(upstream, "exit").then(([code]) => { throw new Error(`HTTP fixture exited before readiness: ${code}`); }),
      ]);
      baseUrl = String(ready[0]);
      lines.close();
    }
    const schema: AdapterSchemaDocument = {
      name: "batch-guard-fixture", type: "adapter", version: "1.0.0", description: "Batch guard regression",
      target: {
        transport, base_url: baseUrl, protocol: "custom", serialization: "json",
        ...(transport === "stdio" ? { stdio: { command: process.execPath, args: [fixturePath] } } : {}),
      },
      operations: { read: [] },
    };
    for (const endpoint of ["read", "create", "update", "delete", "execute"] as const) {
      schema.operations[endpoint] = [
        { name: `${endpoint}_safe`, maps_to: "tool:safe", description: "Safe", danger_level: "safe" },
        ...guards.map(({ name, flags }) => ({ name: `${endpoint}_${name}`, maps_to: "tool:guarded", description: name, ...flags })),
      ];
    }
    // Exercise the filesystem/CLI generation path directly, without the builder
    // that would normally synthesize requires_confirmation from danger_level.
    const schemaPath = path.join(dir, "input-schema.json");
    await writeFile(schemaPath, JSON.stringify(schema));
    const outDir = path.join(dir, "adapter");
    await generateAdapterPackage({ schemaPath, outDir });
    assert.deepEqual(JSON.parse(await readFile(path.join(outDir, "src/schema.json"), "utf8")), schema);
    await symlink(path.join(repoRoot, "node_modules"), path.join(outDir, "node_modules"), "dir");
    const client = new Client({ name: "batch-guard-test", version: "1.0.0" });
    t.after(() => client.close());
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: ["--import", "tsx", "src/server.ts"], cwd: outDir, stderr: "inherit",
    }));
    const call = async (endpoint: string, args: Record<string, unknown>) =>
      JSON.parse(((await client.callTool({ name: `mcp_aql_${endpoint}`, arguments: args })).content as Array<{ text: string }>)[0].text);
    let expectedCalls: string[] = [];
    for (const endpoint of ["read", "create", "update", "delete"] as const) {
      for (const { name } of guards) {
        await t.test(`${endpoint}: ${name}`, async () => {
          // Start each case from the observed history so a failing guard does not
          // cause unrelated subsequent cases to fail their dispatch assertions.
          const baseline = await call("read", { operation: "read_safe" });
          expectedCalls = baseline.data.structured_content.calls;
          const batch = await call(endpoint, { operations: [
            { operation: `${endpoint}_safe` },
            { operation: `${endpoint}_${name}` },
            { operation: `${endpoint}_safe`, params: { after: true } },
          ] });
          expectedCalls.push("safe");
          assert.equal(batch.success, true);
          assert.equal(batch.results.length, 1);
          assert.deepEqual(batch.results[0].result.data.structured_content.calls, expectedCalls);
          assert.equal(batch.halted_at.index, 1);
          assert.equal(batch.halted_at.operation, `${endpoint}_${name}`);
          assert.equal(batch.halted_at.result.error.code, "VALIDATION_SINGLE_CALL_REQUIRED");
          assert.deepEqual(batch.pending_operations, [{ index: 2, operation: `${endpoint}_safe`, params: { after: true } }]);
          assert.deepEqual(batch.summary, { total: 3, succeeded: 1, failed: 0, halted: 1, pending: 1 });
          // Verify neither the guarded operation nor the pending operation reached
          // the upstream, and safe batches continue to work after a halt.
          const safe = await call(endpoint, { operations: [{ operation: `${endpoint}_safe` }, { operation: `${endpoint}_safe` }] });
          expectedCalls.push("safe", "safe");
          assert.deepEqual(safe.results[1].result.data.structured_content.calls, expectedCalls);
          assert.deepEqual(safe.summary, { total: 2, succeeded: 2, failed: 0 });
          // The host may still approve the guarded operation as a separate call.
          const single = await call(endpoint, { operation: `${endpoint}_${name}` });
          expectedCalls.push("guarded");
          assert.equal(single.success, true);
          assert.deepEqual(single.data.structured_content.calls, expectedCalls);
        });
      }
    }
    const execute = await call("execute", { operations: [{ operation: "execute_safe" }] });
    assert.equal(execute.error.code, "VALIDATION_BATCH_NOT_ALLOWED");
    const final = await call("read", { operation: "read_safe" });
    expectedCalls.push("safe");
    assert.deepEqual(final.data.structured_content.calls, expectedCalls);
  });
}
