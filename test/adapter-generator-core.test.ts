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
