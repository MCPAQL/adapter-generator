import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  buildSchemaFromDiscoveryBundle,
  generateAdapterPackage,
  type DiscoveryBundle,
} from "@mcpaql/adapter-generator-core";

const syntheticBundle: DiscoveryBundle = {
  schema_version: "1.0.0-draft",
  source: {
    name: "worker-fixture",
    server_url: "https://example.com/mcp/",
    auth: { type: "bearer", token_env: "FIXTURE_TOKEN" },
    capture_config_redacted: {
      transport: "streamable_http",
      headers: { "X-MCP-Toolsets": "all" },
    },
  },
  normalized_bundle: {
    operations: [
      {
        source_tool_name: "list_things",
        operation_name: "list_things",
        description: "List things",
        endpoint: "READ",
        endpoint_confidence: "high",
        danger_level: "safe",
        needs_review: false,
        review_reasons: [],
        params: [],
        maps_to: "tool:list_things",
      },
    ],
    warnings: [],
  },
};

test("adapter-generator-core builds schema and adapter files from in-memory inputs", () => {
  const output = buildSchemaFromDiscoveryBundle({
    bundle: syntheticBundle,
    generatedAt: "2026-06-03T00:00:00.000Z",
  });

  assert.equal(output.schema.name, "worker-fixture-adapter");
  assert.equal(output.schema.target.base_url, "https://example.com/mcp");
  assert.deepEqual(output.schema.headers, { "X-MCP-Toolsets": "all" });
  assert.equal(output.metadata.generated_at, "2026-06-03T00:00:00.000Z");

  const adapterPackage = generateAdapterPackage({
    schema: output.schema,
    provenance: output.metadata,
  });
  const filePaths = adapterPackage.files.map((file) => file.path).sort();

  assert.equal(adapterPackage.packageName, "@mcpaql/generated-worker-fixture-adapter");
  assert.deepEqual(filePaths, [
    "README.md",
    "package.json",
    "src/provenance.json",
    "src/schema.json",
    "src/server.ts",
    "tsconfig.json",
  ]);
  assert.match(adapterPackage.files.find((file) => file.path === "src/server.ts")?.content ?? "", /ListToolsRequestSchema/);
  assert.match(adapterPackage.files.find((file) => file.path === "README.md")?.content ?? "", /Supported Endpoints/);
});

test("adapter-generator-core source has no live Node builtin imports", async () => {
  const coreSrcDir = path.resolve(import.meta.dirname, "../packages/adapter-generator-core/src");
  const files = ["index.ts", "types.ts"];

  for (const file of files) {
    const source = await readFile(path.join(coreSrcDir, file), "utf8");
    const topLevelImports = source.split("\n\nexport interface AdapterPackageFile")[0];
    assert.doesNotMatch(topLevelImports, /^\s*import\s+.*["']node:/m);
    assert.doesNotMatch(topLevelImports, /^\s*import\s+.*["'](?:fs|path|child_process|node:fs|node:path|node:child_process)["']/m);
  }
});
