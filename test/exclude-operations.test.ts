import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSchemaFromDiscoveryBundle,
  generateAdapterPackage,
  type DiscoveryBundle,
  type DiscoveryOperation,
} from "@mcpaql/adapter-generator-core";

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
    params: [],
    maps_to: `tool:${name}`,
  };
}

const bundle: DiscoveryBundle = {
  schema_version: "1.0.0-draft",
  source: { name: "staged", server_url: "https://example.com/mcp", auth: { type: "none" } },
  normalized_bundle: {
    operations: [
      operation("inspect", "READ"),
      operation("export_bundle", "CREATE"),
      operation("run_target", "EXECUTE"),
      operation("instrument", "UPDATE"),
      operation("close", "DELETE"),
    ],
    warnings: [],
  },
};

test("exclude_endpoints leaves whole endpoints out, after endpoint overrides apply", () => {
  const output = buildSchemaFromDiscoveryBundle({
    bundle,
    overrides: {
      exclude_endpoints: ["EXECUTE"],
      // Reclassified into EXECUTE, so it is excluded too.
      operations: { instrument: { endpoint: "EXECUTE", danger_level: "dangerous" } },
    },
  });
  assert.deepEqual(Object.keys(output.schema.operations).sort(), ["create", "delete", "read"]);
  assert.equal(output.metadata.operation_count, 3);
  assert.deepEqual(output.metadata.excluded_operations?.map((entry) => [entry.operation_name, entry.endpoint]), [
    ["run_target", "EXECUTE"],
    ["instrument", "EXECUTE"],
  ]);

  const server = generateAdapterPackage({ schema: output.schema, provenance: output.metadata })
    .files.find((file) => file.path === "src/schema.json")?.content ?? "";
  assert.doesNotMatch(server, /run_target|instrument/);
});

test("a per-operation exclude records its reason", () => {
  const output = buildSchemaFromDiscoveryBundle({
    bundle,
    overrides: { operations: { close: { exclude: true, exclude_reason: "stage 2" } } },
  });
  assert.equal(output.schema.operations.delete, undefined);
  assert.deepEqual(output.metadata.excluded_operations, [
    { source_tool_name: "close", operation_name: "close", endpoint: "DELETE", reason: "stage 2" },
  ]);
});

test("without exclusions, metadata carries no excluded_operations", () => {
  const output = buildSchemaFromDiscoveryBundle({ bundle });
  assert.equal(output.metadata.excluded_operations, undefined);
  assert.equal(output.metadata.operation_count, 5);
});

test("invalid exclude_endpoints entries are refused", () => {
  assert.throws(
    () => buildSchemaFromDiscoveryBundle({ bundle, overrides: { exclude_endpoints: ["RUN" as never] } }),
    /Invalid exclude_endpoints entry 'RUN'/,
  );
});
