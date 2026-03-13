import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildSchemaFromBundle, persistSchemaBuild } from "../src/schema-builder.js";
import { generateAdapterPackage } from "../src/generator.js";

const require = createRequire(import.meta.url);
const AjvCtor = require("ajv/dist/2020").default as new (options?: Record<string, unknown>) => {
  compile(schema: unknown): {
    (value: unknown): boolean;
    errors?: unknown[];
  };
  errorsText(errors?: unknown[] | null | undefined): string;
};
const addFormatsFn = require("ajv-formats").default as (ajv: {
  compile(schema: unknown): {
    (value: unknown): boolean;
    errors?: unknown[];
  };
}) => void;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "../..");
const bundlePath = path.join(workspaceRoot, "examples/generated/github-mcp/capture/discovery-bundle.json");
const overridesPath = path.join(workspaceRoot, "examples/generated/github-mcp/schema-overrides.json");
const schemaSpecPath = path.join(workspaceRoot, "spec/schemas/adapter-schema.schema.json");

test("schema builder emits spec-valid adapter schema with github overrides applied", async () => {
  const output = await buildSchemaFromBundle({
    bundlePath,
    overridesPath,
  });

  const schemaSpec = JSON.parse(await readFile(schemaSpecPath, "utf8")) as unknown;
  const ajv = new AjvCtor({ allErrors: true, strict: false });
  addFormatsFn(ajv);
  const validate = ajv.compile(schemaSpec);

  assert.equal(validate(output.schema), true, validate.errors ? ajv.errorsText(validate.errors) : "schema should validate");
  assert.equal(output.schema.name, "github-mcp");
  assert.equal(output.metadata.operation_count, 43);
  assert.equal(output.schema.auth?.token_env, "GITHUB_PERSONAL_ACCESS_TOKEN");

  const updateOperations = new Set((output.schema.operations.update ?? []).map((operation) => operation.name));
  const executeOperations = new Set((output.schema.operations.execute ?? []).map((operation) => operation.name));

  assert.ok(updateOperations.has("create_or_update_file"));
  assert.ok(updateOperations.has("issue_write"));
  assert.ok(executeOperations.has("create_pull_request_with_copilot"));
  assert.ok(executeOperations.has("merge_pull_request"));
});

test("generator writes runnable adapter package inputs", async () => {
  const output = await buildSchemaFromBundle({
    bundlePath,
    overridesPath,
  });
  const tempRoot = await mkdtemp(path.join(tmpdir(), "mcpaql-generator-test-"));
  const schemaOutDir = path.join(tempRoot, "schema");
  const adapterOutDir = path.join(tempRoot, "adapter");

  await persistSchemaBuild(output, schemaOutDir);
  await generateAdapterPackage({
    schemaPath: path.join(schemaOutDir, "adapter-schema.json"),
    provenancePath: path.join(schemaOutDir, "adapter-provenance.json"),
    outDir: adapterOutDir,
  });

  const generatedSchema = JSON.parse(await readFile(path.join(adapterOutDir, "src/schema.json"), "utf8")) as {
    name: string;
  };
  const serverSource = await readFile(path.join(adapterOutDir, "src/server.ts"), "utf8");
  const readme = await readFile(path.join(adapterOutDir, "README.md"), "utf8");

  assert.equal(generatedSchema.name, "github-mcp");
  assert.match(serverSource, /operation === "introspect"/);
  assert.match(serverSource, /mcp_aql_read/);
  assert.match(readme, /Generated MCP-AQL adapter package/);
});
