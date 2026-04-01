import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  assert.ok(output.metadata.operation_count > 0);
  assert.equal(output.schema.auth?.token_env, "GITHUB_PERSONAL_ACCESS_TOKEN");
  const addCommentToPendingReviewOperation = output.metadata.operations.find(
    (operation) => operation.operation_name === "add_comment_to_pending_review",
  );

  const updateOperations = new Set((output.schema.operations.update ?? []).map((operation) => operation.name));
  const executeOperations = new Set((output.schema.operations.execute ?? []).map((operation) => operation.name));
  const executeOperation = (output.schema.operations.execute ?? []).find(
    (operation) => operation.name === "create_pull_request_with_copilot",
  );

  assert.ok(updateOperations.has("create_or_update_file"));
  assert.ok(updateOperations.has("issue_write"));
  assert.ok(executeOperations.has("create_pull_request_with_copilot"));
  assert.ok(executeOperations.has("merge_pull_request"));
  assert.equal(executeOperation?.non_idempotent, true);
  assert.equal(addCommentToPendingReviewOperation?.param_mappings?.pull_number, "pullNumber");
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
  const packageJson = JSON.parse(await readFile(path.join(adapterOutDir, "package.json"), "utf8")) as {
    engines?: { node?: string };
  };
  const serverSource = await readFile(path.join(adapterOutDir, "src/server.ts"), "utf8");
  const readme = await readFile(path.join(adapterOutDir, "README.md"), "utf8");

  assert.equal(generatedSchema.name, "github-mcp");
  assert.match(serverSource, /operation === "introspect"/);
  assert.match(serverSource, /mcp_aql_read/);
  assert.match(serverSource, /const token = configured \? process\.env\[configured\] : undefined;/);
  assert.match(serverSource, /const schema = rawSchema as AdapterSchema;/);
  assert.match(serverSource, /function mapParamsToUpstream/);
  assert.match(serverSource, /arguments: upstreamParams/);
  assert.equal(packageJson.engines?.node, ">=20");
  assert.match(readme, /Generated MCP-AQL adapter package/);
});

test("generator emits server source that tolerates missing auth and partial endpoint sets", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "mcpaql-generator-partial-schema-"));
  const schemaPath = path.join(tempRoot, "adapter-schema.json");
  const provenancePath = path.join(tempRoot, "adapter-provenance.json");
  const adapterOutDir = path.join(tempRoot, "adapter");

  await writeFile(
    schemaPath,
    JSON.stringify({
      name: "playwright-mcp",
      type: "adapter",
      version: "0.1.0",
      description: "Generated MCP-AQL adapter for the official Playwright MCP server.",
      target: {
        base_url: "http://localhost:8931/mcp",
        transport: "http",
        protocol: "custom",
        serialization: "json",
      },
      operations: {
        read: [
          {
            name: "browser_console_messages",
            maps_to: "tool:browser_console_messages",
            description: "Returns all console messages",
          },
        ],
        execute: [
          {
            name: "browser_click",
            maps_to: "tool:browser_click",
            description: "Perform click on a web page",
            non_idempotent: true,
          },
        ],
      },
    }),
    "utf8",
  );
  await writeFile(provenancePath, JSON.stringify({ generated_at: new Date().toISOString() }), "utf8");

  await generateAdapterPackage({
    schemaPath,
    provenancePath,
    outDir: adapterOutDir,
  });

  const serverSource = await readFile(path.join(adapterOutDir, "src/server.ts"), "utf8");
  assert.match(serverSource, /type EndpointKey = "create" \| "read" \| "update" \| "delete" \| "execute";/);
  assert.match(serverSource, /auth\?: \{/);
  assert.match(serverSource, /const schema = rawSchema as AdapterSchema;/);
});

test("generator emits upstream param remapping from provenance metadata", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "mcpaql-generator-param-mapping-"));
  const schemaPath = path.join(tempRoot, "adapter-schema.json");
  const provenancePath = path.join(tempRoot, "adapter-provenance.json");
  const adapterOutDir = path.join(tempRoot, "adapter");

  await writeFile(
    schemaPath,
    JSON.stringify({
      name: "playwright-mcp",
      type: "adapter",
      version: "0.1.0",
      description: "Generated MCP-AQL adapter for the official Playwright MCP server.",
      target: {
        base_url: "http://localhost:8931/mcp",
        transport: "http",
        protocol: "custom",
        serialization: "json",
      },
      operations: {
        execute: [
          {
            name: "browser_click",
            maps_to: "tool:browser_click",
            description: "Perform click on a web page",
          },
        ],
        read: [],
      },
    }),
    "utf8",
  );
  await writeFile(
    provenancePath,
    JSON.stringify({
      generated_at: new Date().toISOString(),
      operations: [
        {
          operation_name: "browser_click",
          param_mappings: {
            double_click: "doubleClick",
          },
        },
      ],
    }),
    "utf8",
  );

  await generateAdapterPackage({
    schemaPath,
    provenancePath,
    outDir: adapterOutDir,
  });

  const serverSource = await readFile(path.join(adapterOutDir, "src/server.ts"), "utf8");
  assert.match(serverSource, /const PARAM_MAPPINGS_BY_OPERATION = new Map/);
  assert.match(serverSource, /paramMappings\[paramName\] \?\? paramName/);
});

test("schema builder rejects invalid override endpoint values", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "mcpaql-generator-invalid-override-"));
  const invalidOverridesPath = path.join(tempRoot, "overrides.json");

  await writeFile(
    invalidOverridesPath,
    JSON.stringify({
      operations: {
        list_branches: {
          endpoint: "PATCH",
        },
      },
    }),
    "utf8",
  );

  await assert.rejects(
    buildSchemaFromBundle({
      bundlePath,
      overridesPath: invalidOverridesPath,
    }),
    /Invalid override endpoint 'PATCH'/,
  );
});

test("schema builder rejects invalid override danger level values", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "mcpaql-generator-invalid-danger-"));
  const invalidOverridesPath = path.join(tempRoot, "overrides.json");

  await writeFile(
    invalidOverridesPath,
    JSON.stringify({
      operations: {
        list_branches: {
          danger_level: "maybe-dangerous",
        },
      },
    }),
    "utf8",
  );

  await assert.rejects(
    buildSchemaFromBundle({
      bundlePath,
      overridesPath: invalidOverridesPath,
    }),
    /Invalid override danger_level 'maybe-dangerous'/,
  );
});

test("schema builder rejects forbidden danger level overrides with a targeted message", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "mcpaql-generator-forbidden-danger-"));
  const invalidOverridesPath = path.join(tempRoot, "overrides.json");

  await writeFile(
    invalidOverridesPath,
    JSON.stringify({
      operations: {
        list_branches: {
          danger_level: "forbidden",
        },
      },
    }),
    "utf8",
  );

  await assert.rejects(
    buildSchemaFromBundle({
      bundlePath,
      overridesPath: invalidOverridesPath,
    }),
    /Overrides cannot set danger_level to 'forbidden'/,
  );
});

test("schema builder omits auth block for auth.type none", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "mcpaql-generator-no-auth-"));
  const tempBundlePath = path.join(tempRoot, "bundle.json");
  const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as Record<string, unknown>;

  const source = bundle.source as Record<string, unknown>;
  source.auth = { type: "none" };

  await writeFile(tempBundlePath, JSON.stringify(bundle, null, 2), "utf8");

  const output = await buildSchemaFromBundle({
    bundlePath: tempBundlePath,
  });

  assert.equal(output.schema.auth, undefined);
});

test("schema builder preserves param format when present in the bundle", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "mcpaql-generator-format-"));
  const tempBundlePath = path.join(tempRoot, "bundle.json");
  const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as Record<string, unknown>;
  const normalized = bundle.normalized_bundle as { operations: Array<Record<string, unknown>> };
  const firstOperation = normalized.operations[0];
  const params = firstOperation.params as Array<Record<string, unknown>>;

  params.push({
    name: "created_at",
    original_name: "createdAt",
    type: "string",
    required: false,
    format: "date-time",
    source_path: "inputSchema.properties.createdAt",
  });

  await writeFile(tempBundlePath, JSON.stringify(bundle, null, 2), "utf8");

  const output = await buildSchemaFromBundle({
    bundlePath: tempBundlePath,
    overridesPath,
  });
  const rebuiltOperation = Object.values(output.schema.operations)
    .flatMap((operations) => operations ?? [])
    .find((operation) => operation.params?.created_at);

  assert.equal(rebuiltOperation?.params?.created_at?.format, "date-time");
});

test("schema builder prefers source_tool_name overrides when both override keys are present", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "mcpaql-generator-override-precedence-"));
  const precedenceOverridesPath = path.join(tempRoot, "overrides.json");

  await writeFile(
    precedenceOverridesPath,
    JSON.stringify({
      operations: {
        create_or_update_file: {
          endpoint: "UPDATE",
          review_reason: "source_tool_name override should win",
        },
        renamed_operation: {
          endpoint: "EXECUTE",
          review_reason: "operation_name override should lose to source_tool_name",
        },
      },
    }),
    "utf8",
  );

  const tempBundlePath = path.join(tempRoot, "bundle.json");
  const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as Record<string, unknown>;
  const normalized = bundle.normalized_bundle as { operations: Array<Record<string, unknown>> };
  const targetOperation = normalized.operations.find(
    (operation) => operation.source_tool_name === "create_or_update_file",
  );

  assert.ok(targetOperation, "expected create_or_update_file in discovery bundle");
  targetOperation.operation_name = "renamed_operation";
  await writeFile(tempBundlePath, JSON.stringify(bundle, null, 2), "utf8");

  const output = await buildSchemaFromBundle({
    bundlePath: tempBundlePath,
    overridesPath: precedenceOverridesPath,
  });
  const rebuiltOperation = (output.schema.operations.update ?? []).find(
    (operation) => operation.name === "renamed_operation",
  );

  assert.ok(rebuiltOperation, "expected overridden operation to remain in UPDATE");
  const rebuiltMetadata = output.metadata.operations.find(
    (operation) => operation.operation_name === "renamed_operation",
  );
  assert.ok(rebuiltMetadata?.review_reasons.includes("source_tool_name override should win"));
  assert.ok(!rebuiltMetadata?.review_reasons.includes("operation_name override should lose to source_tool_name"));
});
