/**
 * Tests for template overrides in native-applescript adapter generation
 * (port of the template-overrides feature into adapter-generator-core,
 * hardened per mcpaql-adapter#32 / adapter-generator#42).
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  generateAdapterPackage,
  type AdapterSchemaDocument,
  type TemplateOverridesDocument,
} from "../packages/adapter-generator-core/src/index.js";

function nativeSchema(): AdapterSchemaDocument {
  return {
    name: "mail-test",
    version: "0.1.0",
    description: "Generated MCP-AQL adapter for Mail test",
    target: {
      base_url: "native-applescript://Mail",
      transport: "native-applescript",
      protocol: "mcp-aql",
      serialization: "json",
      application: "Mail",
    },
    operations: {
      read: [
        {
          name: "list_messages",
          maps_to: "native-applescript:command:listMessages",
          description: "List messages",
          params: { account_name: { type: "text", required: true } },
        },
      ],
    },
  } as unknown as AdapterSchemaDocument;
}

function templatesDoc(): TemplateOverridesDocument {
  return {
    schema_version: "1.0.0-draft",
    templates: {
      list_messages: {
        language: "JavaScript",
        script: "const a = {{account_name}}; const c = {{cursor}};",
        params: {
          account_name: { type: "text" },
          cursor: { type: "integer", default: 0 },
        },
      },
      recent_messages: {
        language: "JavaScript",
        script: "const d = {{days}};",
        params: { days: { type: "integer" } },
        endpoint: "READ",
        description: "Recent messages",
      },
    },
  };
}

function fileContent(pkg: ReturnType<typeof generateAdapterPackage>, path: string): string {
  const file = pkg.files.find((f) => f.path === path);
  assert.ok(file, `expected generated file ${path}`);
  return file!.content;
}

test("templates.json is emitted and matches the input templates", () => {
  const pkg = generateAdapterPackage({ schema: nativeSchema(), templates: templatesDoc() });
  const emitted = JSON.parse(fileContent(pkg, "src/templates.json"));
  assert.deepEqual(Object.keys(emitted).sort(), ["list_messages", "recent_messages"]);
  assert.equal(emitted.list_messages.params.cursor.default, 0);
});

test("template params are merged into matching schema operations for introspection", () => {
  const pkg = generateAdapterPackage({ schema: nativeSchema(), templates: templatesDoc() });
  const schema = JSON.parse(fileContent(pkg, "src/schema.json"));
  const op = schema.operations.read.find((o: { name: string }) => o.name === "list_messages");
  assert.deepEqual(op.params.cursor, { type: "integer", required: false, default: 0 });
  assert.deepEqual(op.params.account_name, { type: "text", required: true });
});

test("template-only operations are injected under their declared endpoint", () => {
  const pkg = generateAdapterPackage({ schema: nativeSchema(), templates: templatesDoc() });
  const schema = JSON.parse(fileContent(pkg, "src/schema.json"));
  const op = schema.operations.read.find((o: { name: string }) => o.name === "recent_messages");
  assert.ok(op, "recent_messages must be injected");
  assert.equal(op.maps_to, "native-applescript:template:recent_messages");
  assert.deepEqual(op.params.days, { type: "integer", required: true });
});

test("emitted server carries the hardened template runtime", () => {
  const pkg = generateAdapterPackage({ schema: nativeSchema(), templates: templatesDoc() });
  const server = fileContent(pkg, "src/server.ts");
  for (const marker of [
    'import rawTemplates from "./templates.json"',
    "VALIDATION_MISSING_PARAM",
    "VALIDATION_INVALID_PARAM_TYPE",
    "VALIDATION_UNRESOLVED_PARAM",
    "TRANSPORT_NATIVE_TIMEOUT",
    "MCPAQL_NATIVE_TIMEOUT_MS",
    "stderr was empty",
    "nativeErrorResult",
  ]) {
    assert.ok(server.includes(marker), `emitted server missing: ${marker}`);
  }
  // The unresolved-placeholder regex must survive template-literal escaping.
  assert.ok(server.includes("result.matchAll(/\\{\\{(\\w+)\\}\\}/g)"), "unresolved-param regex must be intact");
});

test("without templates the emitted server is template-free and errors stay hardened", () => {
  const pkg = generateAdapterPackage({ schema: nativeSchema() });
  const server = fileContent(pkg, "src/server.ts");
  assert.ok(!server.includes("rawTemplates"), "no templates import without templates");
  assert.ok(!pkg.files.some((f) => f.path === "src/templates.json"));
  assert.ok(server.includes("stderr was empty"), "error surfacing is unconditional");
  assert.ok(server.includes("TRANSPORT_NATIVE_TIMEOUT"));
});

test("template-only operation without endpoint is refused", () => {
  const doc = templatesDoc();
  delete (doc.templates.recent_messages as { endpoint?: string }).endpoint;
  assert.throws(
    () => generateAdapterPackage({ schema: nativeSchema(), templates: doc }),
    /requires a valid CRUDE endpoint/,
  );
});

test("templates on a non-native transport are refused", () => {
  const schema = nativeSchema();
  (schema.target as { transport: string }).transport = "http";
  assert.throws(
    () => generateAdapterPackage({ schema, templates: templatesDoc() }),
    /only supported for native-applescript/,
  );
});

test("invalid template param type is refused at generation time", () => {
  const doc = templatesDoc();
  (doc.templates.list_messages.params!.cursor as { type: string }).type = "banana";
  assert.throws(
    () => generateAdapterPackage({ schema: nativeSchema(), templates: doc }),
    /invalid type 'banana'/,
  );
});
