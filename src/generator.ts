import path from "node:path";

import type {
  AdapterSchemaDocument,
  AdapterSchemaOperation,
  CurationDocument,
  EndpointCategory,
  TemplateOverridesDocument,
} from "./types.js";
import { readJsonFile, writeJsonFile, writeTextFile } from "./shared.js";

function packageName(schema: AdapterSchemaDocument): string {
  return `@mcpaql/generated-${schema.name}`;
}

function prettyToolName(name: string): string {
  const specialCases: Record<string, string> = {
    aql: "AQL",
    api: "API",
    github: "GitHub",
    mcp: "MCP",
  };

  return name
    .split(/[_-]/g)
    .map((segment) => specialCases[segment.toLowerCase()] ?? `${segment.slice(0, 1).toUpperCase()}${segment.slice(1)}`)
    .join(" ");
}

function adapterReadmeSubject(description: string): string {
  const subject = description
    .replace(/^Generated MCP-AQL adapter package for\s+/i, "")
    .replace(/^Generated MCP-AQL adapter for\s+/i, "")
    .trim()
    .replace(/\.$/, "");

  return subject || "the configured upstream service";
}

function buildEndpointDescriptions(schema: AdapterSchemaDocument): string {
  return Object.entries(schema.operations)
    .filter(([, operations]) => Array.isArray(operations) && operations.length > 0)
    .map(([endpoint, operations]) => {
      const names = (operations ?? []).map((operation) => operation.name).join(", ");
      return `- ${endpoint.toUpperCase()}: ${names}`;
    })
    .join("\n");
}

function buildRunningSection(schema: AdapterSchemaDocument): string {
  if (schema.target.transport === "native-applescript") {
    return `## Running

Requires Node.js 20 or newer and macOS with the target application installed.

This adapter executes operations locally via \`osascript\` (AppleScript/JXA).
No network configuration is required.

\`\`\`bash
npm install
npm run start
\`\`\`

> **Note:** The target application (${schema.target.application ?? "the configured app"}) must be running for most operations to succeed.
`;
  }

  const authLine =
    schema.auth?.type === "bearer"
      ? `Set \`${schema.auth.token_env ?? "UPSTREAM_BEARER_TOKEN"}\` and run:`
      : "Run:";

  return `## Running

Requires Node.js 20 or newer.

Set \`MCPAQL_TARGET_BASE_URL\` if you want this adapter to connect to a different upstream server than the bundled \`${schema.target.base_url}\`.

${authLine}

\`\`\`bash
npm install
npm run start
\`\`\`
`;
}

/**
 * Convert a simple glob pattern (supporting only `*` wildcards) to a RegExp.
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * Filter schema operations according to a curation document.
 *
 * When `mode` is "include", only operations listed in `operations` are kept.
 * When `mode` is "exclude", listed operations are removed.
 * In both modes, `exclude_patterns` removes any operations whose name matches
 * a glob pattern.
 */
/**
 * Inject template-only operations into the schema. Templates that define an
 * `endpoint` field but have no matching operation in the schema are added as
 * synthetic operations. This bridges the granularity gap between sdef-derived
 * atomic operations and hand-authored composite templates.
 */
export function injectTemplateOperations(
  schema: AdapterSchemaDocument,
  templates: TemplateOverridesDocument,
): AdapterSchemaDocument {
  const existingOps = new Set<string>();
  for (const ops of Object.values(schema.operations)) {
    for (const op of ops ?? []) {
      existingOps.add(op.name);
    }
  }

  const result = { ...schema, operations: { ...schema.operations } };

  for (const [name, tmpl] of Object.entries(templates.templates)) {
    if (existingOps.has(name)) continue; // Already in schema — template is an override, not injection
    if (!tmpl.endpoint) continue; // No endpoint declared — can't inject without knowing the CRUDE category

    const params: AdapterSchemaOperation["params"] = tmpl.params
      ? Object.fromEntries(
          Object.entries(tmpl.params).map(([pName, pDef]) => [
            pName,
            { type: pDef.type, required: !pDef.optional, description: pDef.description },
          ]),
        )
      : undefined;

    const syntheticOp: AdapterSchemaOperation = {
      name,
      maps_to: `template:${name}`,
      description: tmpl.description ?? `Template-defined operation: ${name}`,
      params,
      danger_level: tmpl.danger_level ?? (tmpl.endpoint === "delete" ? "destructive" : "safe"),
    };

    const endpoint = tmpl.endpoint;
    const existing = result.operations[endpoint] ?? [];
    result.operations[endpoint] = [...existing, syntheticOp];
  }

  return result;
}

export function applyCuration(
  schema: AdapterSchemaDocument,
  curation: CurationDocument,
): AdapterSchemaDocument {
  const includeSet = curation.operations ? new Set(curation.operations) : undefined;
  const excludeRegexes = (curation.exclude_patterns ?? []).map(globToRegex);

  function matchesExcludePattern(name: string): boolean {
    return excludeRegexes.some((regex) => regex.test(name));
  }

  function filterOps(ops: AdapterSchemaOperation[] | undefined): AdapterSchemaOperation[] {
    if (!ops) return [];
    return ops.filter((op) => {
      if (matchesExcludePattern(op.name)) return false;
      if (curation.mode === "include" && includeSet) return includeSet.has(op.name);
      if (curation.mode === "exclude" && includeSet) return !includeSet.has(op.name);
      return true;
    });
  }

  const filteredOperations: AdapterSchemaDocument["operations"] = {};
  for (const endpoint of ["create", "read", "update", "delete", "execute"] as const) {
    const filtered = filterOps(schema.operations[endpoint]);
    if (filtered.length > 0) {
      filteredOperations[endpoint] = filtered;
    }
  }

  return { ...schema, operations: filteredOperations };
}

function buildNativeAppleScriptServerSource(schema: AdapterSchemaDocument, hasTemplates: boolean): string {
  return `import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  CallToolRequest,
  CallToolResult,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import rawSchema from "./schema.json" with { type: "json" };
${hasTemplates ? 'import rawTemplates from "./templates.json" with { type: "json" };\n' : ""}
const execFileAsync = promisify(execFile);

type EndpointKey = "create" | "read" | "update" | "delete" | "execute";
type EndpointName = "CREATE" | "READ" | "UPDATE" | "DELETE" | "EXECUTE";
type OperationParam = {
  type: string;
  required?: boolean;
  description?: string;
  default?: unknown;
  enum?: string[];
};
type OperationDefinition = {
  name: string;
  maps_to: string;
  description: string;
  params?: Record<string, OperationParam>;
  danger_level?: string;
  requires_confirmation?: boolean;
  non_idempotent?: boolean;
};
type AdapterSchema = {
  name: string;
  version: string;
  description: string;
  target: {
    base_url: string;
    transport: string;
    protocol: string;
    serialization: string;
    application?: string;
  };
  operations: Partial<Record<EndpointKey, OperationDefinition[]>>;
};
type OperationArguments = Record<string, unknown> & {
  operation?: unknown;
  params?: unknown;
};
type OperationIndexEntry = {
  endpoint: EndpointName;
  definition: OperationDefinition;
};

const schema = rawSchema as unknown as AdapterSchema;
if (!schema.target.application) throw new Error("native-applescript schema is missing target.application");
const APPLICATION = schema.target.application;
const TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 10 * 1024 * 1024;

const TOOL_NAME_BY_ENDPOINT: Record<EndpointName, string> = {
  CREATE: "mcp_aql_create",
  READ: "mcp_aql_read",
  UPDATE: "mcp_aql_update",
  DELETE: "mcp_aql_delete",
  EXECUTE: "mcp_aql_execute",
};

const TOOL_BY_OPERATION = new Map<string, OperationIndexEntry>();
for (const [endpoint, operations] of Object.entries(schema.operations) as Array<[EndpointKey, OperationDefinition[] | undefined]>) {
  for (const operation of operations ?? []) {
    TOOL_BY_OPERATION.set(operation.name, {
      endpoint: endpoint.toUpperCase() as EndpointName,
      definition: operation,
    });
  }
}

function textResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function resolveParams(args: OperationArguments | undefined): Record<string, unknown> {
  if (args && typeof args.params === "object" && args.params !== null && !Array.isArray(args.params)) {
    return args.params as Record<string, unknown>;
  }
  if (!args) return {};
  const clone = { ...args };
  delete clone.operation;
  delete clone.params;
  return clone;
}

/**
 * Sanitize a value for safe interpolation into JXA code.
 * Uses JSON.stringify which handles all escaping for JavaScript string literals.
 */
function sanitizeForJxa(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite numbers are not allowed.");
    return String(value);
  }
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "object") return JSON.stringify(value);
  return JSON.stringify(String(value));
}

/**
 * Validate that a string is a safe JXA identifier (letters, digits, underscores, dots).
 * Dots are allowed because maps_to targets use "class.property" notation.
 */
function validateJxaIdentifier(value: string, label: string): string {
  if (!/^[a-zA-Z_][\\w.]*$/.test(value)) {
    throw new Error(\`Invalid \${label}: '\${value}' is not a safe identifier.\`);
  }
  return value;
}

/**
 * Validate that a param key is a safe JavaScript identifier.
 */
function validateParamKey(key: string): string {
  if (!/^[a-zA-Z_][\\w]*$/.test(key)) {
    throw new Error(\`Invalid parameter key: '\${key}' is not a safe identifier.\`);
  }
  return key;
}

/**
 * Build a JXA script for a native-applescript operation.
 * The maps_to format is: native-applescript:<type>:<target>
 *   - command:<name> -> executes an AppleScript command
 *   - get_property:<class>.<property> -> reads a property
 *   - set_property:<class>.<property> -> writes a property
 *   - list_elements:<class>.<element> -> lists elements
 */
function buildJxaScript(mapsTo: string, params: Record<string, unknown>): string {
  const parts = mapsTo.replace(/^native-applescript:/, "").split(":");
  const actionType = parts[0];
  const target = parts.slice(1).join(":");

  const app = sanitizeForJxa(APPLICATION);

  switch (actionType) {
    case "command": {
      // Generic command execution via JXA
      validateJxaIdentifier(target.replace(/\\s+/g, ""), "command target");
      const sanitizedParams = Object.entries(params)
        .map(([key, value]) => \`  \${validateParamKey(key)}: \${sanitizeForJxa(value)}\`)
        .join(",\\n");
      const paramBlock = sanitizedParams ? \`{\\n\${sanitizedParams}\\n}\` : "{}";
      return [
        "ObjC.import('stdlib');",
        \`const app = Application(\${app});\`,
        \`const result = app.\${target.replace(/\\s+/g, "")}(\${paramBlock});\`,
        "JSON.stringify(result);",
      ].join("\\n");
    }

    case "get_property": {
      const [className, propName] = target.split(".");
      validateJxaIdentifier(className.replace(/\\s+/g, ""), "get_property class");
      validateJxaIdentifier(propName.replace(/\\s+/g, ""), "get_property property");
      const specifier = sanitizeForJxa(params[\`\${className.toLowerCase()}_specifier\`] ?? params.target ?? 1);
      return [
        "ObjC.import('stdlib');",
        \`const app = Application(\${app});\`,
        \`const items = app.\${className.replace(/\\s+/g, "")}s();\`,
        \`const item = typeof \${specifier} === 'number' ? items[\${specifier} - 1] : items.byName(\${specifier});\`,
        \`const result = item.\${propName.replace(/\\s+/g, "")}();\`,
        "JSON.stringify(result);",
      ].join("\\n");
    }

    case "set_property": {
      const [className2, propName2] = target.split(".");
      validateJxaIdentifier(className2.replace(/\\s+/g, ""), "set_property class");
      validateJxaIdentifier(propName2.replace(/\\s+/g, ""), "set_property property");
      const specifier2 = sanitizeForJxa(params[\`\${className2.toLowerCase()}_specifier\`] ?? params.target ?? 1);
      const newValue = sanitizeForJxa(params.value);
      return [
        "ObjC.import('stdlib');",
        \`const app = Application(\${app});\`,
        \`const items = app.\${className2.replace(/\\s+/g, "")}s();\`,
        \`const item = typeof \${specifier2} === 'number' ? items[\${specifier2} - 1] : items.byName(\${specifier2});\`,
        \`item.\${propName2.replace(/\\s+/g, "")} = \${newValue};\`,
        \`JSON.stringify({success: true, value: \${newValue}});\`,
      ].join("\\n");
    }

    case "list_elements": {
      const [className3, elementType] = target.split(".");
      validateJxaIdentifier(className3.replace(/\\s+/g, ""), "list_elements class");
      validateJxaIdentifier(elementType.replace(/\\s+/g, ""), "list_elements element type");
      const specifier3 = sanitizeForJxa(params[\`\${className3.toLowerCase()}_specifier\`] ?? params.target ?? 1);
      return [
        "ObjC.import('stdlib');",
        \`const app = Application(\${app});\`,
        \`const items = app.\${className3.replace(/\\s+/g, "")}s();\`,
        \`const item = typeof \${specifier3} === 'number' ? items[\${specifier3} - 1] : items.byName(\${specifier3});\`,
        \`const elements = item.\${elementType.replace(/\\s+/g, "")}s();\`,
        \`const result = elements.map(e => { try { return {name: e.name(), id: e.id()}; } catch(err) { return {name: String(e)}; } });\`,
        "JSON.stringify(result);",
      ].join("\\n");
    }

    default:
      throw new Error(\`Unknown native-applescript action type: \${actionType}\`);
  }
}

async function executeJxa(script: string): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT,
    });
    try { return JSON.parse(stdout.trim()); } catch { return stdout.trim(); }
  } catch (error: unknown) {
    const execError = error as { stderr?: string; status?: number };
    throw new Error(\`osascript failed: \${execError.stderr ?? String(error)}\`);
  }
}

function buildIntrospectionOperations() {
  const operations: Array<{ name: string; endpoint: EndpointName; description: string }> = [
    { name: "introspect", endpoint: "READ", description: "Discover available operations." },
  ];
  for (const [endpoint, entries] of Object.entries(schema.operations) as Array<[EndpointKey, OperationDefinition[] | undefined]>) {
    for (const operation of entries ?? []) {
      operations.push({ name: operation.name, endpoint: endpoint.toUpperCase() as EndpointName, description: operation.description });
    }
  }
  return operations;
}

function buildOperationDetails(name: string) {
  if (name === "introspect") {
    return {
      name: "introspect", endpoint: "READ", mcpTool: "mcp_aql_read",
      description: "Discover available operations.",
      parameters: [
        { name: "query", type: "string", required: true, description: "'operations' or 'types'", enum: ["operations", "types"] },
        { name: "name", type: "string", required: false, description: "Operation or type name." },
      ],
    };
  }
  const item = TOOL_BY_OPERATION.get(name);
  if (!item) return null;
  return {
    name, endpoint: item.endpoint, mcpTool: TOOL_NAME_BY_ENDPOINT[item.endpoint],
    description: item.definition.description,
    parameters: Object.entries(item.definition.params ?? {}).map(([pn, p]) => ({
      name: pn, type: p.type, required: Boolean(p.required), description: p.description, default: p.default, enum: p.enum,
    })),
  };
}

function buildIntrospection(params: Record<string, unknown>) {
  const query = typeof params.query === "string" ? params.query : undefined;
  const name = typeof params.name === "string" ? params.name : undefined;
  if (query === "operations") {
    if (name) {
      const op = buildOperationDetails(name);
      return op ? { success: true, data: { operation: op } } : { success: false, error: { code: "NOT_FOUND_OPERATION", message: \`Unknown operation: \${name}\` } };
    }
    return { success: true, data: { _protocol: { version: schema.version, mode: "crude" }, operations: buildIntrospectionOperations() } };
  }
  if (query === "types") {
    if (name) return { success: false, error: { code: "NOT_FOUND_TYPE", message: \`Unknown type: \${name}\` } };
    return { success: true, data: { types: [{ name: "NativeResult", kind: "object", description: "Result from native AppleScript execution." }] } };
  }
  return { success: false, error: { code: "VALIDATION_INVALID_QUERY", message: \`Unknown introspection query: \${String(params.query)}\` } };
}

${hasTemplates ? `type TemplateEntry = { language: string; script: string; params?: Record<string, { type: string; optional?: boolean }> };
const templates = rawTemplates as Record<string, TemplateEntry>;

function interpolateTemplate(script: string, params: Record<string, unknown>): string {
  let result = script;
  for (const [key, value] of Object.entries(params)) {
    validateParamKey(key);
    result = result.replaceAll("{{" + key + "}}", sanitizeForJxa(value));
  }
  return result;
}

` : ""}async function handleNativeOperation(operationName: string, params: Record<string, unknown>) {
${hasTemplates ? `  const template = templates[operationName];
  if (template) {
    try {
      const script = interpolateTemplate(template.script, params);
      const result = await executeJxa(script);
      return { success: true, data: result };
    } catch (error: unknown) {
      return { success: false, error: { code: "TRANSPORT_NATIVE_EXECUTION_ERROR", message: error instanceof Error ? error.message : String(error) } };
    }
  }
` : ""}  const item = TOOL_BY_OPERATION.get(operationName);
  if (!item) return { success: false, error: { code: "NOT_FOUND_OPERATION", message: \`Unknown operation: \${operationName}\` } };
  try {
    const script = buildJxaScript(item.definition.maps_to, params);
    const result = await executeJxa(script);
    return { success: true, data: result };
  } catch (error: unknown) {
    return { success: false, error: { code: "TRANSPORT_NATIVE_EXECUTION_ERROR", message: error instanceof Error ? error.message : String(error) } };
  }
}

function buildToolDescription(endpoint: EndpointName, operations: OperationDefinition[]): string {
  const names = operations.map((o) => o.name).join(", ");
  return [
    \`\${endpoint} operations for \${schema.description}\`,
    "", \`Supported operations: \${names}\`,
    "", "Discover parameters:", \`{ operation: "introspect", params: { query: "operations", name: "\${operations[0]?.name ?? "introspect"}" } }\`,
  ].join("\\n");
}

const server = new Server({ name: schema.name, version: schema.version }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => ({
  tools: (Object.entries(schema.operations) as Array<[EndpointKey, OperationDefinition[] | undefined]>)
    .filter(([, ops]) => Array.isArray(ops) && ops.length > 0)
    .map(([endpoint, ops]) => ({
      name: TOOL_NAME_BY_ENDPOINT[endpoint.toUpperCase() as EndpointName],
      description: buildToolDescription(endpoint.toUpperCase() as EndpointName, ops ?? []),
      inputSchema: {
        type: "object",
        properties: { operation: { type: "string", description: "MCP-AQL operation name." }, params: { type: "object", description: "Operation parameters." } },
        required: ["operation"],
      },
      annotations: { readOnlyHint: endpoint === "read", destructiveHint: endpoint === "delete" || endpoint === "execute" },
    })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest): Promise<CallToolResult> => {
  const toolName = request.params.name;
  const args = (request.params.arguments ?? {}) as OperationArguments;
  const operation = typeof args.operation === "string" ? args.operation : "";
  const params = resolveParams(args);
  if (operation === "introspect") return textResult(buildIntrospection(params));
  const item = TOOL_BY_OPERATION.get(operation);
  if (!item) return textResult({ success: false, error: { code: "NOT_FOUND_OPERATION", message: \`Unknown operation: \${operation}\` } });
  const expectedToolName = TOOL_NAME_BY_ENDPOINT[item.endpoint];
  if (toolName !== expectedToolName) return textResult({ success: false, error: { code: "VALIDATION_WRONG_ENDPOINT", message: \`Operation '\${operation}' must be called via \${expectedToolName}.\` } });
  const result = await handleNativeOperation(operation, params);
  return textResult(result);
});

const transport = new StdioServerTransport();
await server.connect(transport);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => process.exit(0));
}
`;
}

function buildServerSource(schema: AdapterSchemaDocument): string {
  return `import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  CallToolRequest,
  CallToolResult,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import rawSchema from "./schema.json" with { type: "json" };
import provenance from "./provenance.json" with { type: "json" };

type EndpointKey = "create" | "read" | "update" | "delete" | "execute";
type EndpointName = "CREATE" | "READ" | "UPDATE" | "DELETE" | "EXECUTE";
type OperationParam = {
  type: string;
  required?: boolean;
  description?: string;
  default?: unknown;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  pattern?: string;
  format?: string;
};
type OperationDefinition = {
  name: string;
  maps_to: string;
  description: string;
  params?: Record<string, OperationParam>;
  response?: {
    type?: "object";
    description?: string;
  };
  danger_level?: string;
  requires_confirmation?: boolean;
  non_idempotent?: boolean;
};
type AdapterSchema = {
  name: string;
  version: string;
  description: string;
  target: {
    base_url: string;
    transport: string;
    protocol: string;
    serialization: string;
  };
  auth?: {
    type: "bearer";
    header?: string;
    prefix?: string;
    token_env?: string;
  };
  operations: Partial<Record<EndpointKey, OperationDefinition[]>>;
};
type OperationIndexEntry = {
  endpoint: EndpointName;
  definition: OperationDefinition;
};
type AdapterProvenance = {
  operations?: Array<{
    operation_name: string;
    param_mappings?: Record<string, string>;
  }>;
};
type OperationArguments = Record<string, unknown> & {
  operation?: unknown;
  params?: unknown;
};

const schema = rawSchema as AdapterSchema;
// Provenance is generated by the schema builder; this is a read-side projection of the broader metadata shape.
const adapterProvenance = provenance as unknown as AdapterProvenance;

const TOOL_NAME_BY_ENDPOINT: Record<EndpointName, string> = {
  CREATE: "mcp_aql_create",
  READ: "mcp_aql_read",
  UPDATE: "mcp_aql_update",
  DELETE: "mcp_aql_delete",
  EXECUTE: "mcp_aql_execute",
};

const TOOL_BY_OPERATION = new Map<string, OperationIndexEntry>();
for (const [endpoint, operations] of Object.entries(schema.operations) as Array<[EndpointKey, OperationDefinition[] | undefined]>) {
  for (const operation of operations ?? []) {
    TOOL_BY_OPERATION.set(operation.name, {
      endpoint: endpoint.toUpperCase() as EndpointName,
      definition: operation,
    });
  }
}

const PARAM_MAPPINGS_BY_OPERATION = new Map<string, Record<string, string>>();
for (const entry of adapterProvenance.operations ?? []) {
  if (entry.param_mappings && Object.keys(entry.param_mappings).length > 0) {
    PARAM_MAPPINGS_BY_OPERATION.set(entry.operation_name, entry.param_mappings);
  }
}

let upstreamClient: Client | undefined;
let upstreamTransport: StreamableHTTPClientTransport | undefined;

function textResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function resolveToken(): string {
  if (!schema.auth || schema.auth.type !== "bearer") {
    throw new Error("This adapter is not configured for bearer auth.");
  }

  const configured = schema.auth.token_env;
  const token = configured ? process.env[configured] : undefined;
  if (token) {
    return token;
  }

  throw new Error(\`Missing upstream bearer token in env var '\${configured ?? "UPSTREAM_BEARER_TOKEN"}'.\`);
}

function resolveBaseUrl(): string {
  const override = process.env.MCPAQL_TARGET_BASE_URL?.trim();
  if (override) {
    return override;
  }

  return schema.target.base_url;
}

async function getUpstreamClient(): Promise<Client> {
  if (upstreamClient) {
    return upstreamClient;
  }

  const transport = new StreamableHTTPClientTransport(new URL(resolveBaseUrl()), {
    requestInit: {
      headers:
        schema.auth?.type === "bearer"
          ? {
              Authorization: \`\${schema.auth.prefix ?? "Bearer "}\${resolveToken()}\`,
            }
          : undefined,
    },
  });
  const client = new Client({ name: schema.name, version: schema.version });
  await client.connect(transport);
  upstreamClient = client;
  upstreamTransport = transport;
  return upstreamClient;
}

function resolveParams(args: OperationArguments | undefined): Record<string, unknown> {
  if (args && typeof args.params === "object" && args.params !== null && !Array.isArray(args.params)) {
    return args.params as Record<string, unknown>;
  }

  if (!args) {
    return {};
  }

  // Flat argument fallback exists for convenience, but it reserves the top-level operation/params keys.
  const clone = { ...args };
  delete clone.operation;
  delete clone.params;
  return clone;
}

function mapParamsToUpstream(operationName: string, params: Record<string, unknown>): Record<string, unknown> {
  const paramMappings = PARAM_MAPPINGS_BY_OPERATION.get(operationName);
  if (!paramMappings) {
    return params;
  }

  return Object.fromEntries(
    Object.entries(params).map(([paramName, value]) => [paramMappings[paramName] ?? paramName, value]),
  );
}

function buildToolDescription(endpoint: EndpointName, operations: OperationDefinition[]): string {
  const names = operations.map((operation) => operation.name).join(", ");
  const quickStart = endpoint === "READ"
    ? '{ operation: "introspect", params: { query: "operations" } }'
    : \`{ operation: "introspect", params: { query: "operations", name: "\${operations[0]?.name ?? "introspect"}" } }\`;

  return [
    \`\${endpoint} operations for \${schema.description}\`,
    "",
    \`Supported operations: \${names}\`,
    "",
    "Discover required parameters:",
    quickStart,
  ].join("\\n");
}

function buildIntrospectionOperations() {
  const operations: Array<{ name: string; endpoint: EndpointName; description: string }> = [
    {
      name: "introspect",
      endpoint: "READ",
      description: "Discover available operations and wrapped upstream result types.",
    },
  ];

  for (const [endpoint, entries] of Object.entries(schema.operations) as Array<[EndpointKey, OperationDefinition[] | undefined]>) {
    for (const operation of entries ?? []) {
      operations.push({
        name: operation.name,
        endpoint: endpoint.toUpperCase() as EndpointName,
        description: operation.description,
      });
    }
  }

  return operations;
}

function buildOperationDetails(name: string) {
  if (name === "introspect") {
    return {
      name: "introspect",
      endpoint: "READ",
      mcpTool: "mcp_aql_read",
      description: "Discover available operations and wrapped upstream result types.",
      permissions: { readOnly: true, destructive: false },
      parameters: [
        { name: "query", type: "string", required: true, description: "Either 'operations' or 'types'.", enum: ["operations", "types"] },
        { name: "name", type: "string", required: false, description: "Optional operation or type name for details." },
      ],
      returns: { name: "IntrospectionResult", kind: "object", description: "MCP-AQL introspection response payload." },
      examples: [
        { request: { operation: "introspect", params: { query: "operations" } } },
      ],
    };
  }

  const item = TOOL_BY_OPERATION.get(name);
  if (!item) {
    return null;
  }

  return {
    name,
    endpoint: item.endpoint,
    mcpTool: TOOL_NAME_BY_ENDPOINT[item.endpoint],
    description: item.definition.description,
    permissions: {
      readOnly: item.endpoint === "READ",
      destructive: item.endpoint === "DELETE" || item.endpoint === "EXECUTE",
    },
    parameters: Object.entries(item.definition.params ?? {}).map(([paramName, param]) => ({
      name: paramName,
      type: param.type,
      required: Boolean(param.required),
      description: param.description,
      default: param.default,
      enum: param.enum,
      minimum: param.minimum,
      maximum: param.maximum,
      pattern: param.pattern,
      format: param.format,
    })),
    returns: {
      name: "WrappedToolResult",
      kind: "object",
      description: item.definition.response?.description ?? "Wrapped upstream MCP tool result.",
    },
    examples: [
      {
        request: {
          operation: name,
          params: Object.fromEntries(
            Object.entries(item.definition.params ?? {}).map(([paramName, param]) => [
              paramName,
              param.default ?? (param.type === "integer" ? 1 : param.type === "boolean" ? true : \`<\${paramName}>\`),
            ]),
          ),
        },
      },
    ],
  };
}

function buildTypeList() {
  return [
    {
      name: "WrappedToolResult",
      kind: "object",
      description: "Standard wrapped result returned by generated MCP-AQL proxy operations.",
    },
  ];
}

function buildTypeDetails(name: string) {
  if (name !== "WrappedToolResult") {
    return null;
  }

  return {
    name: "WrappedToolResult",
    kind: "object",
    description: "Wrapped upstream MCP tool result preserving content blocks and structured payloads.",
    fields: [
      { name: "source_tool", type: "string", required: true, description: "Original upstream MCP tool name." },
      { name: "content", type: "array", required: true, description: "Raw MCP content blocks returned by the upstream tool." },
      { name: "structured_content", type: "object", required: false, description: "Structured content returned by the upstream tool when available." },
      { name: "is_error", type: "boolean", required: true, description: "Whether the upstream tool reported an MCP-level tool error." },
    ],
  };
}

function buildIntrospection(params: Record<string, unknown>) {
  const query = typeof params.query === "string" ? params.query : undefined;
  const name = typeof params.name === "string" ? params.name : undefined;

  if (query === "operations") {
    if (name) {
      const operation = buildOperationDetails(name);
      if (!operation) {
        return { success: false, error: { code: "NOT_FOUND_OPERATION", message: \`Unknown operation: \${name}\` } };
      }

      return {
        success: true,
        data: { operation },
      };
    }

    return {
      success: true,
      data: {
        _protocol: {
          version: schema.version,
          mode: "crude",
        },
        operations: buildIntrospectionOperations(),
      },
    };
  }

  if (query === "types") {
    if (name) {
      const type = buildTypeDetails(name);
      if (!type) {
        return { success: false, error: { code: "NOT_FOUND_TYPE", message: \`Unknown type: \${name}\` } };
      }

      return {
        success: true,
        data: { type },
      };
    }

    return {
      success: true,
      data: { types: buildTypeList() },
    };
  }

  return {
    success: false,
    error: {
      code: "VALIDATION_INVALID_QUERY",
      message: \`Unknown introspection query: \${String(params.query)}\`,
    },
  };
}

async function proxyOperation(operationName: string, params: Record<string, unknown>) {
  const item = TOOL_BY_OPERATION.get(operationName);
  if (!item) {
    return {
      success: false,
      error: {
        code: "NOT_FOUND_OPERATION",
        message: \`Unknown operation: \${operationName}\`,
      },
    };
  }

  const upstream = await getUpstreamClient();
  const sourceTool = item.definition.maps_to.replace(/^tool:/, "");
  const upstreamParams = mapParamsToUpstream(operationName, params);
  const result = await upstream.callTool({
    name: sourceTool,
    arguments: upstreamParams,
  });

  if (result.isError) {
    return {
      success: false,
      error: {
        code: "UPSTREAM_TOOL_ERROR",
        message: \`Upstream MCP tool '\${sourceTool}' returned an error.\`,
        details: {
          source_tool: sourceTool,
          content: result.content,
          structured_content: result.structuredContent ?? null,
        },
      },
      _meta: { provenance },
    };
  }

  return {
    success: true,
    data: {
      source_tool: sourceTool,
      content: result.content,
      structured_content: result.structuredContent ?? null,
      is_error: Boolean(result.isError),
    },
    _meta: { provenance },
  };
}

const server = new Server(
  { name: schema.name, version: schema.version },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => ({
  tools: (Object.entries(schema.operations) as Array<[EndpointKey, OperationDefinition[] | undefined]>)
    .filter(([, operations]) => Array.isArray(operations) && operations.length > 0)
    .map(([endpoint, operations]) => ({
      name: TOOL_NAME_BY_ENDPOINT[endpoint.toUpperCase() as EndpointName],
      description: buildToolDescription(endpoint.toUpperCase() as EndpointName, operations ?? []),
      inputSchema: {
        type: "object",
        properties: {
          operation: { type: "string", description: "MCP-AQL operation name." },
          params: { type: "object", description: "Operation parameters." },
        },
        required: ["operation"],
      },
      annotations: {
        // schema.operations keys are lowercase here because they come directly from the JSON schema document.
        readOnlyHint: endpoint === "read",
        destructiveHint: endpoint === "delete" || endpoint === "execute",
      },
    })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest): Promise<CallToolResult> => {
  const toolName = request.params.name;
  const args = (request.params.arguments ?? {}) as OperationArguments;
  const operation = typeof args.operation === "string" ? args.operation : "";
  const params = resolveParams(args);

  if (operation === "introspect") {
    const result = buildIntrospection(params);
    return textResult(result);
  }

  const item = TOOL_BY_OPERATION.get(operation);
  if (!item) {
    return textResult({ success: false, error: { code: "NOT_FOUND_OPERATION", message: \`Unknown operation: \${operation}\` } });
  }

  const expectedToolName = TOOL_NAME_BY_ENDPOINT[item.endpoint];
  if (toolName !== expectedToolName) {
    return textResult({
      success: false,
      error: {
        code: "VALIDATION_WRONG_ENDPOINT",
        message: \`Operation '\${operation}' must be called via \${expectedToolName}.\`,
      },
    });
  }

  const result = await proxyOperation(operation, params);
  return textResult(result);
});

const transport = new StdioServerTransport();
await server.connect(transport);

async function closeUpstreamTransport() {
  if (upstreamTransport) {
    await upstreamTransport.close();
    upstreamTransport = undefined;
    upstreamClient = undefined;
  }
}

process.on("beforeExit", async () => {
  await closeUpstreamTransport();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void closeUpstreamTransport().finally(() => process.exit(0));
  });
}
`;
}

export async function generateAdapterPackage(options: {
  schemaPath: string;
  provenancePath?: string;
  templatesPath?: string;
  curationPath?: string;
  outDir: string;
}): Promise<void> {
  let schema = await readJsonFile<AdapterSchemaDocument>(options.schemaPath);
  const provenance = options.provenancePath
    ? await readJsonFile<Record<string, unknown>>(options.provenancePath)
    : { generated_at: new Date().toISOString() };

  const outDir = options.outDir;

  // Apply curation filtering before generation
  if (options.curationPath) {
    const curation = await readJsonFile<CurationDocument>(options.curationPath);
    schema = applyCuration(schema, curation);
  }

  // Load template overrides and inject template-only operations into the schema
  let templatesDoc: TemplateOverridesDocument | undefined;
  if (options.templatesPath) {
    templatesDoc = await readJsonFile<TemplateOverridesDocument>(options.templatesPath);
    schema = injectTemplateOperations(schema, templatesDoc);
  }

  if (schema.target.transport === "native-applescript" && !schema.target.application) {
    throw new Error("native-applescript adapter schema requires target.application");
  }

  await writeJsonFile(path.join(outDir, "src/schema.json"), schema);
  await writeJsonFile(path.join(outDir, "src/provenance.json"), provenance);

  // Write templates.json when template overrides are provided
  if (templatesDoc) {
    await writeJsonFile(path.join(outDir, "src/templates.json"), templatesDoc.templates);
  }

  const hasTemplates = templatesDoc !== undefined;
  const serverSource = schema.target.transport === "native-applescript"
    ? buildNativeAppleScriptServerSource(schema, hasTemplates)
    : buildServerSource(schema);

  const dependencies: Record<string, string> = { "@modelcontextprotocol/sdk": "^1.27.1" };

  await writeJsonFile(path.join(outDir, "package.json"), {
    name: packageName(schema),
    private: true,
    type: "module",
    engines: {
      node: ">=20",
    },
    scripts: {
      build: "tsc -p tsconfig.json",
      start: "tsx src/server.ts",
    },
    dependencies,
    devDependencies: {
      "@types/node": "^24.3.0",
      tsx: "^4.20.5",
      typescript: "^5.9.2",
    },
  });

  await writeJsonFile(path.join(outDir, "tsconfig.json"), {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      outDir: "dist",
      rootDir: "src",
      types: ["node"],
    },
    include: ["src/**/*.ts"],
  });

  await writeTextFile(path.join(outDir, "src/server.ts"), serverSource);
  await writeTextFile(
    path.join(outDir, "README.md"),
    `# ${prettyToolName(schema.name)}\n\nGenerated MCP-AQL adapter package for ${adapterReadmeSubject(schema.description)}.\n\n## Supported Endpoints\n\n${buildEndpointDescriptions(schema)}\n\n${buildRunningSection(schema)}`,
  );
}
