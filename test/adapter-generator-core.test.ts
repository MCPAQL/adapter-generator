import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

import {
  buildSchemaFromDiscoveryBundle,
  generateAdapterPackage,
  type AdapterSchemaDocument,
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
  const builtinModuleNames = new Set(builtinModules.map((moduleName) => moduleName.replace(/^node:/, "")));

  for (const file of files) {
    const source = await readFile(path.join(coreSrcDir, file), "utf8");
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }

      const { line } = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile));
      const specifier = statement.moduleSpecifier.text;
      const normalizedSpecifier = specifier.replace(/^node:/, "");

      assert.equal(specifier.startsWith("node:"), false, `${file}:${line + 1} must not import ${specifier}`);
      assert.equal(builtinModuleNames.has(normalizedSpecifier), false, `${file}:${line + 1} must not import Node builtin ${specifier}`);
    }
  }
});

test("adapter-generator-core emits native-applescript adapter server source", () => {
  const schema: AdapterSchemaDocument = {
    name: "native-projects",
    type: "adapter",
    version: "0.1.0",
    description: "Generated MCP-AQL adapter for Native Projects.",
    target: {
      base_url: "native-applescript://Native Projects",
      transport: "native-applescript",
      protocol: "custom",
      serialization: "json",
      application: "Native Projects",
    },
    operations: {
      read: [
        {
          name: "list_projects",
          maps_to: "native-applescript:command:listProjects",
          description: "List projects",
        },
        {
          name: "get_document_title",
          maps_to: "native-applescript:get_property:document.title",
          description: "Get the active document title",
        },
      ],
      update: [
        {
          name: "set_document_title",
          maps_to: "native-applescript:set_property:document.title",
          description: "Set the active document title",
        },
      ],
      execute: [
        {
          name: "list_project_tasks",
          maps_to: "native-applescript:list_elements:project.task",
          description: "List tasks for a project",
        },
      ],
    },
  };

  const adapterPackage = generateAdapterPackage({
    schema,
    provenance: { generated_at: "2026-06-03T00:00:00.000Z" },
  });
  const serverSource = adapterPackage.files.find((file) => file.path === "src/server.ts")?.content ?? "";
  const schemaJson = adapterPackage.files.find((file) => file.path === "src/schema.json")?.content ?? "";

  assert.match(serverSource, /import \{ execFile \} from "node:child_process"/);
  assert.match(serverSource, /const execFileAsync = promisify\(execFile\)/);
  assert.match(serverSource, /\/usr\/bin\/osascript/);
  assert.match(serverSource, /function buildJxaScript/);
  assert.match(serverSource, /case "command"/);
  assert.match(serverSource, /case "get_property"/);
  assert.match(serverSource, /case "set_property"/);
  assert.match(serverSource, /case "list_elements"/);
  assert.ok(serverSource.includes('const result = item.${propName.replace(/\\s+/g, "")}();'));
  assert.ok(serverSource.includes('item.${propName2.replace(/\\s+/g, "")} = ${newValue};'));
  assert.ok(serverSource.includes("const result = elements.map(e =>"));
  assert.match(serverSource, /native-applescript schema is missing target\.application/);
  assert.match(schemaJson, /native-applescript:command:listProjects/);
  assert.match(schemaJson, /native-applescript:get_property:document\.title/);
  assert.match(schemaJson, /native-applescript:set_property:document\.title/);
  assert.match(schemaJson, /native-applescript:list_elements:project\.task/);
});

test("generated adapter resolves ${env:VAR} header values at connect time", () => {
  const output = buildSchemaFromDiscoveryBundle({
    bundle: syntheticBundle,
    generatedAt: "2026-10-13T00:00:00.000Z",
  });
  const serverSource = generateAdapterPackage({ schema: output.schema, provenance: output.metadata })
    .files.find((file) => file.path === "src/server.ts")?.content ?? "";
  const fnSource = /function resolveHeaderValue[\s\S]*?\n}\n/.exec(serverSource)?.[0];
  assert.ok(fnSource, "generated server should define resolveHeaderValue");

  const js = ts.transpile(fnSource!, { target: ts.ScriptTarget.ES2022 });
  const resolveHeaderValue = new Function("process", `${js}; return resolveHeaderValue;`)({
    env: { FIXTURE_PROJECT_ID: "project_123" },
  }) as (name: string, value: string) => string;

  assert.equal(resolveHeaderValue("X-Project-Id", "${env:FIXTURE_PROJECT_ID}"), "project_123");
  assert.equal(resolveHeaderValue("X-MCP-Toolsets", "all"), "all");
  assert.equal(resolveHeaderValue("X-Partial", "prefix-${env:FIXTURE_PROJECT_ID}"), "prefix-${env:FIXTURE_PROJECT_ID}");
  assert.throws(() => resolveHeaderValue("X-Project-Id", "${env:MISSING_VAR}"), /MISSING_VAR.*X-Project-Id/);
});

const tenancyBundle: DiscoveryBundle = {
  ...syntheticBundle,
  source: {
    ...syntheticBundle.source,
    capture_config_redacted: {
      transport: "streamable_http",
      headers: { "x-project-id": "${env:FIXTURE_PROJECT_ID}", "X-MCP-Toolsets": "all" },
    },
  },
  normalized_bundle: {
    operations: [
      ...syntheticBundle.normalized_bundle.operations,
      {
        source_tool_name: "list_projects",
        operation_name: "list_projects",
        description: "List projects",
        endpoint: "READ",
        endpoint_confidence: "high",
        danger_level: "safe",
        needs_review: false,
        review_reasons: [],
        params: [],
        maps_to: "tool:list_projects",
      },
    ],
    warnings: [],
  },
};

const fixtureTenancy = {
  header: "X-Project-Id",
  noun: "project",
  list_operation: "list_projects",
  id_field: "project_id",
  name_field: "name",
  default_field: "default",
};

test("tenancy override attaches tenancy and drops the static tenant header", () => {
  const output = buildSchemaFromDiscoveryBundle({ bundle: tenancyBundle, overrides: { tenancy: fixtureTenancy } });
  assert.deepEqual(output.schema.tenancy, fixtureTenancy);
  assert.deepEqual(output.schema.headers, { "X-MCP-Toolsets": "all" });
});

test("tenancy override is validated against the schema", () => {
  assert.throws(
    () => buildSchemaFromDiscoveryBundle({ bundle: tenancyBundle, overrides: { tenancy: { ...fixtureTenancy, list_operation: "missing" } } }),
    /list_operation 'missing' must be a READ operation/,
  );
  assert.throws(
    () => buildSchemaFromDiscoveryBundle({ bundle: tenancyBundle, overrides: { tenancy: { ...fixtureTenancy, noun: "Project" } } }),
    /lowercase snake_case/,
  );
  assert.throws(
    () => buildSchemaFromDiscoveryBundle({ bundle: tenancyBundle, overrides: { tenancy: { ...fixtureTenancy, unscoped_operations: ["nope"] } } }),
    /unscoped operation 'nope'/,
  );
});

test("tenancy runtime is emitted only for tenant-scoped schemas and parses", () => {
  const plain = buildSchemaFromDiscoveryBundle({ bundle: tenancyBundle });
  const scoped = buildSchemaFromDiscoveryBundle({ bundle: tenancyBundle, overrides: { tenancy: fixtureTenancy } });
  const source = (schema: AdapterSchemaDocument) =>
    generateAdapterPackage({ schema }).files.find((file) => file.path === "src/server.ts")?.content ?? "";

  const plainSource = source(plain.schema);
  const scopedSource = source(scoped.schema);
  assert.doesNotMatch(plainSource, /Tenancy \(generated from schema\.tenancy\)/);
  assert.match(scopedSource, /Tenancy \(generated from schema\.tenancy\)/);
  assert.match(scopedSource, /await closeTenantClients\(\);/);
  assert.match(scopedSource, /resolveCallTenant\(operationName, params\)/);

  const { diagnostics } = ts.transpileModule(scopedSource, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  assert.deepEqual(diagnostics?.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")), []);
});

test("tenancy validation rejects unsafe configurations", () => {
  const withOwnedParam: DiscoveryBundle = {
    ...tenancyBundle,
    normalized_bundle: {
      ...tenancyBundle.normalized_bundle,
      operations: [
        ...tenancyBundle.normalized_bundle.operations,
        {
          source_tool_name: "list_members",
          operation_name: "list_members",
          description: "List members of a project",
          endpoint: "READ",
          endpoint_confidence: "high",
          danger_level: "safe",
          needs_review: false,
          review_reasons: [],
          params: [{ name: "project_id", original_name: "project_id", type: "string", required: true }],
          maps_to: "tool:list_members",
        },
      ],
    },
  } as DiscoveryBundle;
  assert.throws(
    () => buildSchemaFromDiscoveryBundle({ bundle: withOwnedParam, overrides: { tenancy: fixtureTenancy } }),
    /'list_members' declares 'project_id'; add it to tenancy\.unscoped_operations/,
  );
  assert.doesNotThrow(() =>
    buildSchemaFromDiscoveryBundle({ bundle: withOwnedParam, overrides: { tenancy: { ...fixtureTenancy, unscoped_operations: ["list_members"] } } }),
  );
});

test("generated README lists env-sourced headers and the tenancy start variable", () => {
  const scoped = buildSchemaFromDiscoveryBundle({
    bundle: { ...tenancyBundle, source: { ...tenancyBundle.source, capture_config_redacted: { transport: "streamable_http", headers: { "X-Region": "${env:FIXTURE_REGION}" } } } },
    overrides: { tenancy: { ...fixtureTenancy, default_env: "FIXTURE_PROJECT" } },
  });
  const readme = generateAdapterPackage({ schema: scoped.schema }).files.find((file) => file.path === "README.md")?.content ?? "";
  assert.match(readme, /`FIXTURE_REGION` \(required\): sent as the `X-Region` header\./);
  assert.match(readme, /`FIXTURE_PROJECT` \(optional\): starting project, by id or name\./);
});

test("tenancy runtime keeps operation-owned tenant params and rejects non-string selectors", () => {
  const scoped = buildSchemaFromDiscoveryBundle({ bundle: tenancyBundle, overrides: { tenancy: fixtureTenancy } });
  const source = generateAdapterPackage({ schema: scoped.schema }).files.find((file) => file.path === "src/server.ts")?.content ?? "";
  assert.match(source, /if \(!TENANT_PARAM_OPERATIONS\.has\(operationName\)\) return getActiveTenant\(\);/);
  assert.match(source, /VALIDATION_INVALID_PARAM_TYPE/);
});
