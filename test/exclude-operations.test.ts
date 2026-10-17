import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSchemaFromDiscoveryBundle,
  generateAdapterPackage,
  type AdapterSchemaDocument,
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

test("exclusion fails closed when an exclude key names no operation", () => {
  assert.throws(
    () => buildSchemaFromDiscoveryBundle({ bundle, overrides: { operations: { run_targett: { exclude: true } } } }),
    /Override 'run_targett' sets exclude, but no operation in the bundle has that name/,
  );
});

test("an operation is excluded under its renamed name or when any matching override excludes it", () => {
  const renamed = buildSchemaFromDiscoveryBundle({
    bundle,
    overrides: { operations: { run_target: { operation_name: "launch" }, launch: { exclude: true } } },
  });
  assert.equal(renamed.schema.operations.execute, undefined);
  assert.equal(renamed.metadata.excluded_operations?.[0].operation_name, "launch");

  // Source tool name and operation name differ; one override reclassifies, the other excludes.
  const split: DiscoveryBundle = {
    ...bundle,
    normalized_bundle: {
      ...bundle.normalized_bundle,
      operations: [{ ...operation("start_trace", "READ"), source_tool_name: "startTrace", maps_to: "tool:startTrace" }],
    },
  };
  const output = buildSchemaFromDiscoveryBundle({
    bundle: split,
    overrides: { operations: { startTrace: { endpoint: "EXECUTE" }, start_trace: { exclude: true, exclude_reason: "runtime" } } },
  });
  assert.equal(output.schema.operations.execute, undefined);
  assert.equal(output.metadata.excluded_operations?.[0].reason, "runtime");
});

test("exclude overrides are type-checked", () => {
  const build = (overrides: unknown) => () => buildSchemaFromDiscoveryBundle({ bundle, overrides: overrides as never });
  assert.throws(build({ exclude_endpoints: "EXECUTE" }), /exclude_endpoints must be an array/);
  assert.throws(build({ operations: { close: { exclude: "false" } } }), /must be a boolean/);
  assert.throws(build({ operations: { close: { exclude_reason: "why" } } }), /exclude_reason without exclude: true/);
});

test("templates cannot re-add an excluded operation", () => {
  const schema: AdapterSchemaDocument = {
    name: "mail",
    type: "adapter",
    version: "0.1.0",
    description: "Mail",
    target: { base_url: "native-applescript://Mail", transport: "native-applescript", protocol: "custom", serialization: "json", application: "Mail" },
    operations: { read: [{ name: "list_mailboxes", maps_to: "native-applescript:command:listMailboxes", description: "List" }] },
  };
  assert.throws(
    () => generateAdapterPackage({
      schema,
      provenance: { excluded_operations: [{ operation_name: "send_message", source_tool_name: "send_message", endpoint: "EXECUTE", reason: "x" }] },
      templates: {
        schema_version: "1.0.0-draft",
        templates: { send_message: { language: "JavaScript", script: "1", endpoint: "EXECUTE", description: "Send" } },
      },
    }),
    /Templates cannot re-add excluded operations: send_message/,
  );
});
