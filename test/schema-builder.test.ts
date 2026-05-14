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

test("schema builder propagates custom discovery headers into the adapter schema", async () => {
  // Build a synthetic discovery bundle that carries a custom toolset-selector header,
  // mimicking what mcpaql-interrogate would write for `X-MCP-Toolsets: all` style captures.
  const tempRoot = await mkdtemp(path.join(tmpdir(), "mcpaql-headers-bundle-"));
  const syntheticBundlePath = path.join(tempRoot, "discovery-bundle.json");
  await writeFile(
    syntheticBundlePath,
    JSON.stringify({
      schema_version: "1.0.0-draft",
      source: {
        name: "headers-fixture",
        server_url: "https://example.com/mcp/",
        auth: { type: "bearer", token_env: "FIXTURE_TOKEN" },
        capture_config_redacted: {
          transport: "streamable_http",
          headers: { "X-Custom-Selector": "all", "X-Tenant": "test" },
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
    }),
  );

  const output = await buildSchemaFromBundle({ bundlePath: syntheticBundlePath });
  assert.deepEqual(output.schema.headers, { "X-Custom-Selector": "all", "X-Tenant": "test" });
});

test("schema builder omits headers field when discovery bundle has none", async () => {
  // Standard captures without custom headers should not introduce a headers field
  // (keeps generated schemas minimal and the absence semantically meaningful).
  const output = await buildSchemaFromBundle({ bundlePath, overridesPath });
  assert.equal(output.schema.headers, undefined);
});

test("schema builder drops non-string header values silently", async () => {
  // Defensive: capture configs are free-form. If a non-string slips into the headers
  // record (e.g., a number from a buggy upstream config), the builder must filter it
  // out rather than crash or pass it through — HTTP headers are string-valued.
  const tempRoot = await mkdtemp(path.join(tmpdir(), "mcpaql-headers-mixed-"));
  const syntheticBundlePath = path.join(tempRoot, "discovery-bundle.json");
  await writeFile(
    syntheticBundlePath,
    JSON.stringify({
      schema_version: "1.0.0-draft",
      source: {
        name: "mixed-headers",
        server_url: "https://example.com/mcp/",
        auth: { type: "bearer", token_env: "FIXTURE_TOKEN" },
        capture_config_redacted: {
          transport: "streamable_http",
          headers: { "X-Keep": "yes", "X-Drop-Number": 42, "X-Drop-Bool": true, "X-Drop-Null": null },
        },
      },
      normalized_bundle: {
        operations: [{
          source_tool_name: "list_things", operation_name: "list_things",
          description: "List things", endpoint: "READ", endpoint_confidence: "high",
          danger_level: "safe", needs_review: false, review_reasons: [], params: [],
          maps_to: "tool:list_things",
        }],
        warnings: [],
      },
    }),
  );
  const output = await buildSchemaFromBundle({ bundlePath: syntheticBundlePath });
  assert.deepEqual(output.schema.headers, { "X-Keep": "yes" });
});

test("generator drops captured headers that collide case-insensitively with the auth header", async () => {
  // Codex review finding: HTTP header names are case-insensitive, and some Fetch
  // implementations combine duplicate-name-different-case headers with commas. So
  // if a discovery bundle includes `authorization` (e.g., from a lower-casing HTTP
  // client) the generated client must drop it before setting the live `Authorization`
  // bearer, or upstream gets a malformed combined value.
  const tempRoot = await mkdtemp(path.join(tmpdir(), "mcpaql-header-collision-"));
  const schemaPath = path.join(tempRoot, "adapter-schema.json");
  const provenancePath = path.join(tempRoot, "adapter-provenance.json");
  const adapterOutDir = path.join(tempRoot, "adapter");

  await writeFile(
    schemaPath,
    JSON.stringify({
      name: "collision-adapter",
      type: "adapter",
      version: "0.1.0",
      description: "Synthetic adapter to verify case-insensitive auth-header filtering.",
      target: { base_url: "https://example.com/mcp", transport: "http", protocol: "custom", serialization: "json" },
      auth: { type: "bearer", header: "Authorization", prefix: "Bearer ", token_env: "FIXTURE_TOKEN" },
      headers: { "X-Selector": "all", "authorization": "redacted" },
      operations: { read: [{ name: "list_things", maps_to: "tool:list_things", description: "List things" }] },
    }),
  );
  await writeFile(provenancePath, JSON.stringify({ operations: [{ operation_name: "list_things", endpoint: "READ" }] }));

  await generateAdapterPackage({ schemaPath, provenancePath, outDir: adapterOutDir });
  const serverSource = await readFile(path.join(adapterOutDir, "src/server.ts"), "utf8");

  // The emitted client must contain the case-insensitive skip-on-match guard before
  // it sets the live bearer header, otherwise both keys end up in the headers map.
  assert.match(serverSource, /name\.toLowerCase\(\) === authHeaderLower/);
  // And the comment explaining the invariant should be present so future maintainers
  // know the filter is load-bearing for HTTP-header-case correctness, not stylistic.
  assert.match(serverSource, /HTTP header names are case-insensitive/);

  // The bundled schema.json must round-trip BOTH headers — the filter runs at adapter
  // runtime, not at generation time. The intent is that future regeneration always
  // sees what was captured; only the runtime upstream call drops the colliding key.
  const generatedSchema = JSON.parse(
    await readFile(path.join(adapterOutDir, "src/schema.json"), "utf8"),
  ) as { headers?: Record<string, string> };
  assert.deepEqual(generatedSchema.headers, { "X-Selector": "all", "authorization": "redacted" });
});

test("generator filter uses configured auth header name, not a hardcoded 'Authorization'", async () => {
  // The filter reads `schema.auth?.header`, which means an adapter configured with
  // a non-default auth header (e.g., GitHub-style "X-API-Key") must filter on that
  // name. This is the test that distinguishes "schema.auth?.header is read" from
  // "Authorization is hardcoded" — both regexes would pass the previous test.
  const tempRoot = await mkdtemp(path.join(tmpdir(), "mcpaql-custom-auth-header-"));
  const schemaPath = path.join(tempRoot, "adapter-schema.json");
  const provenancePath = path.join(tempRoot, "adapter-provenance.json");
  const adapterOutDir = path.join(tempRoot, "adapter");

  await writeFile(
    schemaPath,
    JSON.stringify({
      name: "custom-auth-adapter",
      type: "adapter",
      version: "0.1.0",
      description: "Synthetic adapter verifying configured auth header name is honored by the filter.",
      target: { base_url: "https://example.com/mcp", transport: "http", protocol: "custom", serialization: "json" },
      auth: { type: "bearer", header: "X-API-Key", prefix: "", token_env: "FIXTURE_TOKEN" },
      headers: { "X-Selector": "all", "x-api-key": "redacted", "Authorization": "should-survive-no-collision" },
      operations: { read: [{ name: "list_things", maps_to: "tool:list_things", description: "List things" }] },
    }),
  );
  await writeFile(provenancePath, JSON.stringify({ operations: [{ operation_name: "list_things", endpoint: "READ" }] }));

  await generateAdapterPackage({ schemaPath, provenancePath, outDir: adapterOutDir });

  // Bundled schema preserves all captured headers — the runtime filter operates on
  // the live auth-header name (`X-API-Key`), so `x-api-key` collides, but the
  // unrelated `Authorization` value is just data and must pass through unfiltered.
  const generatedSchema = JSON.parse(
    await readFile(path.join(adapterOutDir, "src/schema.json"), "utf8"),
  ) as { auth?: { header?: string }; headers?: Record<string, string> };
  assert.equal(generatedSchema.auth?.header, "X-API-Key");
  assert.deepEqual(generatedSchema.headers, {
    "X-Selector": "all",
    "x-api-key": "redacted",
    "Authorization": "should-survive-no-collision",
  });

  // The emitted source must compute authHeaderLower from schema.auth?.header.
  // If it hardcoded "Authorization", `x-api-key` would survive the filter and
  // collide with the live X-API-Key value at upstream-call time.
  const serverSource = await readFile(path.join(adapterOutDir, "src/server.ts"), "utf8");
  assert.match(serverSource, /const authHeaderName = schema\.auth\?\.header \?\? "Authorization"/);
  assert.match(serverSource, /const authHeaderLower = authHeaderName\.toLowerCase\(\)/);
});

test("schema builder omits headers field for empty headers object", async () => {
  // An empty `headers: {}` in the capture should produce the same shape as no headers
  // at all — no `headers` key on the generated schema.
  const tempRoot = await mkdtemp(path.join(tmpdir(), "mcpaql-headers-empty-"));
  const syntheticBundlePath = path.join(tempRoot, "discovery-bundle.json");
  await writeFile(
    syntheticBundlePath,
    JSON.stringify({
      schema_version: "1.0.0-draft",
      source: {
        name: "empty-headers",
        server_url: "https://example.com/mcp/",
        auth: { type: "bearer", token_env: "FIXTURE_TOKEN" },
        capture_config_redacted: { transport: "streamable_http", headers: {} },
      },
      normalized_bundle: {
        operations: [{
          source_tool_name: "list_things", operation_name: "list_things",
          description: "List things", endpoint: "READ", endpoint_confidence: "high",
          danger_level: "safe", needs_review: false, review_reasons: [], params: [],
          maps_to: "tool:list_things",
        }],
        warnings: [],
      },
    }),
  );
  const output = await buildSchemaFromBundle({ bundlePath: syntheticBundlePath });
  assert.equal(output.schema.headers, undefined);
});

test("generator forwards adapter schema headers to upstream", async () => {
  // Build a synthetic schema with a custom header and confirm the generated
  // server.ts wires it into the upstream StreamableHTTPClientTransport request init.
  const tempRoot = await mkdtemp(path.join(tmpdir(), "mcpaql-headers-gen-"));
  const schemaPath = path.join(tempRoot, "adapter-schema.json");
  const provenancePath = path.join(tempRoot, "adapter-provenance.json");
  const adapterOutDir = path.join(tempRoot, "adapter");

  await writeFile(
    schemaPath,
    JSON.stringify({
      name: "headers-adapter",
      type: "adapter",
      version: "0.1.0",
      description: "Synthetic adapter to verify header forwarding.",
      target: { base_url: "https://example.com/mcp", transport: "http", protocol: "custom", serialization: "json" },
      auth: { type: "bearer", header: "Authorization", prefix: "Bearer ", token_env: "FIXTURE_TOKEN" },
      headers: { "X-Custom-Selector": "all" },
      operations: {
        read: [{ name: "list_things", maps_to: "tool:list_things", description: "List things" }],
      },
    }),
  );
  await writeFile(provenancePath, JSON.stringify({ operations: [{ operation_name: "list_things", endpoint: "READ" }] }));

  await generateAdapterPackage({ schemaPath, provenancePath, outDir: adapterOutDir });
  const serverSource = await readFile(path.join(adapterOutDir, "src/server.ts"), "utf8");

  // The emitted client iterates schema.headers and merges in the bearer auth.
  // Both must be present in the source for the upstream call to carry the
  // discovery-time selector header.
  assert.match(serverSource, /Object\.entries\(schema\.headers \?\? \{\}\)/);
  assert.match(serverSource, /schema\.auth\?\.header \?\? "Authorization"/);
  // Embedded AdapterSchema type in the generated source must include `headers`
  // so the schema.headers access type-checks without a cast.
  assert.match(serverSource, /headers\?: Record<string, string>/);

  // The bundled schema.json in the generated package must carry the headers field through.
  const generatedSchema = JSON.parse(
    await readFile(path.join(adapterOutDir, "src/schema.json"), "utf8"),
  ) as { headers?: Record<string, string> };
  assert.deepEqual(generatedSchema.headers, { "X-Custom-Selector": "all" });
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
  assert.match(serverSource, /function resolveBaseUrl/);
  assert.match(serverSource, /process\.env\.MCPAQL_TARGET_BASE_URL\?\.trim\(\)/);
  assert.match(serverSource, /const schema = rawSchema as unknown as AdapterSchema;/);
  assert.match(serverSource, /function mapParamsToUpstream/);
  assert.match(serverSource, /arguments: upstreamParams/);
  assert.equal(packageJson.engines?.node, ">=20");
  assert.match(readme, /Generated MCP-AQL adapter package/);
  assert.match(readme, /MCPAQL_TARGET_BASE_URL/);
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
  assert.match(serverSource, /new URL\(resolveBaseUrl\(\)\)/);
  assert.match(serverSource, /const schema = rawSchema as unknown as AdapterSchema;/);
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

test("schema builder detects native-applescript transport from source metadata", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "mcpaql-generator-native-transport-"));
  const tempBundlePath = path.join(tempRoot, "bundle.json");

  await writeFile(
    tempBundlePath,
    JSON.stringify({
      schema_version: "1.0.0-draft",
      source: {
        name: "mail-app",
        server_url: "native-applescript://Mail",
        server: { name: "Mail", version: "native" },
        auth: { type: "none" },
        capture_config_redacted: { transport: "native-applescript", application: "Mail" },
      },
      normalized_bundle: {
        operations: [
          {
            source_tool_name: "get",
            operation_name: "get",
            description: "Get data from an object.",
            endpoint: "READ",
            endpoint_confidence: "high",
            danger_level: "safe",
            needs_review: false,
            review_reasons: [],
            params: [],
            maps_to: "native-applescript:command:get",
          },
        ],
        warnings: [],
      },
    }),
    "utf8",
  );

  const output = await buildSchemaFromBundle({ bundlePath: tempBundlePath });
  assert.equal(output.schema.target.transport, "native-applescript");
  assert.equal(output.schema.target.application, "Mail");
  assert.equal(output.schema.auth, undefined);
});

test("generator produces native-applescript server source", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "mcpaql-generator-native-server-"));
  const schemaPath = path.join(tempRoot, "adapter-schema.json");
  const provenancePath = path.join(tempRoot, "adapter-provenance.json");
  const adapterOutDir = path.join(tempRoot, "adapter");

  await writeFile(
    schemaPath,
    JSON.stringify({
      name: "apple-mail",
      type: "adapter",
      version: "0.1.0",
      description: "Generated MCP-AQL adapter for Apple Mail.",
      target: {
        base_url: "native-applescript://Mail",
        transport: "native-applescript",
        protocol: "custom",
        serialization: "json",
        application: "Mail",
      },
      operations: {
        read: [
          {
            name: "list_accounts",
            maps_to: "native-applescript:command:accounts",
            description: "List mail accounts.",
          },
        ],
        update: [
          {
            name: "set_message_read_status",
            maps_to: "native-applescript:set_property:message.readStatus",
            description: "Set read status of a message.",
            params: {
              message_specifier: { type: "string", required: true, description: "Message specifier" },
              value: { type: "boolean", required: true, description: "New read status" },
            },
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
  const readme = await readFile(path.join(adapterOutDir, "README.md"), "utf8");

  // Verify native transport-specific code
  assert.match(serverSource, /osascript/);
  assert.match(serverSource, /execFile/);
  assert.match(serverSource, /buildJxaScript/);
  assert.match(serverSource, /sanitizeForJxa/);
  assert.match(serverSource, /operation === "introspect"/);
  assert.match(serverSource, /mcp_aql_read/);

  // Verify it does NOT contain upstream HTTP client code
  assert.ok(!serverSource.includes("StreamableHTTPClientTransport"));
  assert.ok(!serverSource.includes("resolveToken"));

  // Verify README mentions native transport
  assert.match(readme, /osascript/);
  assert.match(readme, /Mail/);
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

test("generated native-applescript source contains JXA security validation helpers", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "mcpaql-generator-jxa-security-"));
  const schemaPath = path.join(tempRoot, "adapter-schema.json");
  const provenancePath = path.join(tempRoot, "adapter-provenance.json");
  const adapterOutDir = path.join(tempRoot, "adapter");

  await writeFile(
    schemaPath,
    JSON.stringify({
      name: "apple-notes",
      type: "adapter",
      version: "0.1.0",
      description: "Generated MCP-AQL adapter for Apple Notes.",
      target: {
        base_url: "native-applescript://Notes",
        transport: "native-applescript",
        protocol: "custom",
        serialization: "json",
        application: "Notes",
      },
      operations: {
        read: [
          {
            name: "list_notes",
            maps_to: "native-applescript:command:notes",
            description: "List all notes.",
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

  // Verify the three security helpers are present in the generated source
  assert.match(serverSource, /function validateParamKey\(key: string\): string/);
  assert.match(serverSource, /function validateJxaIdentifier\(value: string, label: string\): string/);
  assert.match(serverSource, /function sanitizeForJxa\(value: unknown\): string/);

  // Verify the validation regex patterns reject adversarial inputs
  // validateParamKey uses ^[a-zA-Z_][\w]*$ — rejects keys with special chars
  assert.match(serverSource, /\/\^\[a-zA-Z_\]\[\\w\]\*\$\//);
  // validateJxaIdentifier uses ^[a-zA-Z_][\w.]*$ — rejects identifiers with injection chars
  assert.match(serverSource, /\/\^\[a-zA-Z_\]\[\\w\.\]\*\$\//);
  // sanitizeForJxa uses JSON.stringify for string escaping
  assert.match(serverSource, /JSON\.stringify\(value\)/);
});

test("validateParamKey rejects injection attempts in generated source", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "mcpaql-generator-paramkey-behavioral-"));
  const schemaPath = path.join(tempRoot, "adapter-schema.json");
  const provenancePath = path.join(tempRoot, "adapter-provenance.json");
  const adapterOutDir = path.join(tempRoot, "adapter");

  await writeFile(
    schemaPath,
    JSON.stringify({
      name: "apple-notes",
      type: "adapter",
      version: "0.1.0",
      description: "Generated MCP-AQL adapter for Apple Notes.",
      target: {
        base_url: "native-applescript://Notes",
        transport: "native-applescript",
        protocol: "custom",
        serialization: "json",
        application: "Notes",
      },
      operations: {
        read: [{ name: "list_notes", maps_to: "native-applescript:command:notes", description: "List all notes." }],
      },
    }),
    "utf8",
  );
  await writeFile(provenancePath, JSON.stringify({ generated_at: new Date().toISOString() }), "utf8");

  await generateAdapterPackage({ schemaPath, provenancePath, outDir: adapterOutDir });
  const serverSource = await readFile(path.join(adapterOutDir, "src/server.ts"), "utf8");

  // Extract validateParamKey from generated source and execute it
  const fnMatch = serverSource.match(/function validateParamKey[\s\S]*?\n\}/);
  assert.ok(fnMatch, "validateParamKey found in generated source");
  // Remove TypeScript type annotations so it runs as plain JS
  const jsBody = fnMatch[0].replace(/\(key: string\): string/, "(key)");
  const fn = new Function(`${jsBody}; return validateParamKey;`)() as (key: string) => string;

  // Should accept valid keys
  assert.doesNotThrow(() => fn("query"));
  assert.doesNotThrow(() => fn("owner"));
  assert.doesNotThrow(() => fn("pull_number"));
  assert.doesNotThrow(() => fn("_private"));
  assert.doesNotThrow(() => fn("camelCase123"));

  // Should reject injection attempts
  assert.throws(() => fn("}); evil("), /Invalid param/i);
  assert.throws(() => fn("key;drop"), /Invalid param/i);
  assert.throws(() => fn(""), /Invalid param/i);
  assert.throws(() => fn("123start"), /Invalid param/i);
  assert.throws(() => fn("has space"), /Invalid param/i);
  assert.throws(() => fn("a.b"), /Invalid param/i);
});

test("validateJxaIdentifier rejects injection attempts in generated source", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "mcpaql-generator-jxaid-behavioral-"));
  const schemaPath = path.join(tempRoot, "adapter-schema.json");
  const provenancePath = path.join(tempRoot, "adapter-provenance.json");
  const adapterOutDir = path.join(tempRoot, "adapter");

  await writeFile(
    schemaPath,
    JSON.stringify({
      name: "apple-notes",
      type: "adapter",
      version: "0.1.0",
      description: "Generated MCP-AQL adapter for Apple Notes.",
      target: {
        base_url: "native-applescript://Notes",
        transport: "native-applescript",
        protocol: "custom",
        serialization: "json",
        application: "Notes",
      },
      operations: {
        read: [{ name: "list_notes", maps_to: "native-applescript:command:notes", description: "List all notes." }],
      },
    }),
    "utf8",
  );
  await writeFile(provenancePath, JSON.stringify({ generated_at: new Date().toISOString() }), "utf8");

  await generateAdapterPackage({ schemaPath, provenancePath, outDir: adapterOutDir });
  const serverSource = await readFile(path.join(adapterOutDir, "src/server.ts"), "utf8");

  // Extract validateJxaIdentifier from generated source and execute it
  const fnMatch = serverSource.match(/function validateJxaIdentifier[\s\S]*?\n\}/);
  assert.ok(fnMatch, "validateJxaIdentifier found in generated source");
  const jsBody = fnMatch[0].replace(/\(value: string, label: string\): string/, "(value, label)");
  const fn = new Function(`${jsBody}; return validateJxaIdentifier;`)() as (value: string, label: string) => string;

  // Should accept valid identifiers (including dotted paths)
  assert.doesNotThrow(() => fn("messages", "test"));
  assert.doesNotThrow(() => fn("account.name", "test"));
  assert.doesNotThrow(() => fn("_internal", "test"));
  assert.doesNotThrow(() => fn("foo123", "test"));

  // Should reject injection attempts
  assert.throws(() => fn("foo;bar", "test"), /Invalid/i);
  assert.throws(() => fn("x()", "test"), /Invalid/i);
  assert.throws(() => fn("a`b", "test"), /Invalid/i);
  assert.throws(() => fn("", "test"), /Invalid/i);
  assert.throws(() => fn("123start", "test"), /Invalid/i);
  assert.throws(() => fn("a b", "test"), /Invalid/i);
});

test("sanitizeForJxa escapes dangerous values in generated source", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "mcpaql-generator-sanitize-behavioral-"));
  const schemaPath = path.join(tempRoot, "adapter-schema.json");
  const provenancePath = path.join(tempRoot, "adapter-provenance.json");
  const adapterOutDir = path.join(tempRoot, "adapter");

  await writeFile(
    schemaPath,
    JSON.stringify({
      name: "apple-notes",
      type: "adapter",
      version: "0.1.0",
      description: "Generated MCP-AQL adapter for Apple Notes.",
      target: {
        base_url: "native-applescript://Notes",
        transport: "native-applescript",
        protocol: "custom",
        serialization: "json",
        application: "Notes",
      },
      operations: {
        read: [{ name: "list_notes", maps_to: "native-applescript:command:notes", description: "List all notes." }],
      },
    }),
    "utf8",
  );
  await writeFile(provenancePath, JSON.stringify({ generated_at: new Date().toISOString() }), "utf8");

  await generateAdapterPackage({ schemaPath, provenancePath, outDir: adapterOutDir });
  const serverSource = await readFile(path.join(adapterOutDir, "src/server.ts"), "utf8");

  // Extract sanitizeForJxa from generated source and execute it
  const fnMatch = serverSource.match(/function sanitizeForJxa[\s\S]*?\n\}/);
  assert.ok(fnMatch, "sanitizeForJxa found in generated source");
  const jsBody = fnMatch[0].replace(/\(value: unknown\): string/, "(value)");
  const fn = new Function(`${jsBody}; return sanitizeForJxa;`)() as (value: unknown) => string;

  // Should handle strings safely via JSON.stringify
  const result = fn('value with "quotes" and \\injection');
  assert.ok(result.startsWith('"'), "string result is JSON-quoted");
  assert.ok(result.includes('\\"'), "double quotes are escaped");
  assert.ok(result.includes("\\\\"), "backslashes are escaped");

  // Should handle numbers
  assert.strictEqual(fn(42), "42");
  assert.strictEqual(fn(0), "0");
  assert.strictEqual(fn(-3.14), "-3.14");

  // Should reject non-finite numbers
  assert.throws(() => fn(Infinity), /Non-finite/);
  assert.throws(() => fn(NaN), /Non-finite/);

  // Should handle booleans
  assert.strictEqual(fn(true), "true");
  assert.strictEqual(fn(false), "false");

  // Should handle null/undefined
  assert.strictEqual(fn(null), "null");
  assert.strictEqual(fn(undefined), "null");

  // Should handle objects via JSON
  const objResult = fn({ key: "value" });
  assert.ok(objResult.includes("key"), "object serialized");
  assert.ok(objResult.includes("value"), "object values present");

  // Should handle arrays via JSON
  const arrResult = fn([1, 2, 3]);
  assert.ok(arrResult.includes("1"), "array serialized");
});

test("generator throws when native-applescript schema is missing target.application", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "mcpaql-generator-missing-app-"));
  const schemaPath = path.join(tempRoot, "adapter-schema.json");
  const provenancePath = path.join(tempRoot, "adapter-provenance.json");
  const adapterOutDir = path.join(tempRoot, "adapter");

  await writeFile(
    schemaPath,
    JSON.stringify({
      name: "apple-mail",
      type: "adapter",
      version: "0.1.0",
      description: "Generated MCP-AQL adapter for Apple Mail.",
      target: {
        base_url: "native-applescript://Mail",
        transport: "native-applescript",
        protocol: "custom",
        serialization: "json",
        // deliberately omit application
      },
      operations: {
        read: [
          {
            name: "list_accounts",
            maps_to: "native-applescript:command:accounts",
            description: "List mail accounts.",
          },
        ],
      },
    }),
    "utf8",
  );
  await writeFile(provenancePath, JSON.stringify({ generated_at: new Date().toISOString() }), "utf8");

  await assert.rejects(
    generateAdapterPackage({
      schemaPath,
      provenancePath,
      outDir: adapterOutDir,
    }),
    /native-applescript adapter schema requires target\.application/,
  );
});
