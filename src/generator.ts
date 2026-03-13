import path from "node:path";

import type { AdapterSchemaDocument } from "./types.js";
import { readJsonFile, writeJsonFile, writeTextFile } from "./shared.js";

function packageName(schema: AdapterSchemaDocument): string {
  return `@mcpaql/generated-${schema.name}`;
}

function prettyToolName(name: string): string {
  return name
    .split("_")
    .map((segment) => `${segment.slice(0, 1).toUpperCase()}${segment.slice(1)}`)
    .join(" ");
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

function buildServerSource(schema: AdapterSchemaDocument): string {
  return `// @ts-nocheck
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import schema from "./schema.json" with { type: "json" };
import provenance from "./provenance.json" with { type: "json" };

const TOOL_BY_OPERATION = new Map(
  Object.entries(schema.operations)
    .flatMap(([endpoint, operations]) => (operations ?? []).map((operation) => [operation.name, { endpoint: endpoint.toUpperCase(), definition: operation }]))
);

const TOOL_NAME_BY_ENDPOINT = {
  CREATE: "mcp_aql_create",
  READ: "mcp_aql_read",
  UPDATE: "mcp_aql_update",
  DELETE: "mcp_aql_delete",
  EXECUTE: "mcp_aql_execute",
};

/** @type {Client | undefined} */
let upstreamClient;
/** @type {StreamableHTTPClientTransport | undefined} */
let upstreamTransport;

function resolveToken() {
  const configured = schema.auth?.token_env;
  if (configured && process.env[configured]) {
    return process.env[configured];
  }

  throw new Error(\`Missing upstream bearer token in env var '\${configured ?? "GITHUB_PERSONAL_ACCESS_TOKEN"}'.\`);
}

async function getUpstreamClient() {
  if (upstreamClient) {
    return upstreamClient;
  }

  const transport = new StreamableHTTPClientTransport(new URL(schema.target.base_url), {
    requestInit: {
      headers: {
        Authorization: \`\${schema.auth?.prefix ?? "Bearer "}\${resolveToken()}\`,
      },
    },
  });
  const client = new Client({ name: schema.name, version: schema.version });
  await client.connect(transport);
  upstreamClient = client;
  upstreamTransport = transport;
  return upstreamClient;
}

function resolveParams(args) {
  if (args && typeof args.params === "object" && args.params !== null) {
    return args.params;
  }

  if (!args || typeof args !== "object") {
    return {};
  }

  const clone = { ...args };
  delete clone.operation;
  return clone;
}

function buildToolDescription(endpoint, operations) {
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
  const operations = [
    {
      name: "introspect",
      endpoint: "READ",
      description: "Discover available operations and wrapped upstream result types.",
    },
  ];

  for (const [endpoint, entries] of Object.entries(schema.operations)) {
    for (const operation of entries ?? []) {
      operations.push({
        name: operation.name,
        endpoint: endpoint.toUpperCase(),
        description: operation.description,
      });
    }
  }

  return operations;
}

function buildOperationDetails(name) {
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

function buildTypeDetails(name) {
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

function buildIntrospection(params) {
  if (params.query === "operations") {
    if (params.name) {
      const operation = buildOperationDetails(params.name);
      if (!operation) {
        return { success: false, error: { code: "NOT_FOUND_OPERATION", message: \`Unknown operation: \${params.name}\` } };
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

  if (params.query === "types") {
    if (params.name) {
      const type = buildTypeDetails(params.name);
      if (!type) {
        return { success: false, error: { code: "NOT_FOUND_TYPE", message: \`Unknown type: \${params.name}\` } };
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
      message: \`Unknown introspection query: \${params.query}\`,
    },
  };
}

async function proxyOperation(operationName, params) {
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
  const result = await upstream.callTool({
    name: sourceTool,
    arguments: params,
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

server.setRequestHandler(ListToolsRequestSchema as any, async () => ({
  tools: Object.entries(schema.operations)
    .filter(([, operations]) => Array.isArray(operations) && operations.length > 0)
    .map(([endpoint, operations]) => ({
      name: TOOL_NAME_BY_ENDPOINT[endpoint.toUpperCase()],
      description: buildToolDescription(endpoint.toUpperCase(), operations),
      inputSchema: {
        type: "object",
        properties: {
          operation: { type: "string", description: "MCP-AQL operation name." },
          params: { type: "object", description: "Operation parameters." },
        },
        required: ["operation"],
      },
      annotations: {
        readOnlyHint: endpoint === "read",
        destructiveHint: endpoint === "delete" || endpoint === "execute",
      },
    })),
}));

server.setRequestHandler(CallToolRequestSchema as any, async (request: any) => {
  const toolName = request.params.name;
  const args = request.params.arguments ?? {};
  const operation = args.operation;
  const params = resolveParams(args);

  if (operation === "introspect") {
    const result = buildIntrospection(params);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }

  const item = TOOL_BY_OPERATION.get(operation);
  if (!item) {
    return {
      content: [{ type: "text", text: JSON.stringify({ success: false, error: { code: "NOT_FOUND_OPERATION", message: \`Unknown operation: \${operation}\` } }, null, 2) }],
    };
  }

  const expectedToolName = TOOL_NAME_BY_ENDPOINT[item.endpoint];
  if (toolName !== expectedToolName) {
    return {
      content: [{ type: "text", text: JSON.stringify({ success: false, error: { code: "VALIDATION_WRONG_ENDPOINT", message: \`Operation '\${operation}' must be called via \${expectedToolName}.\` } }, null, 2) }],
    };
  }

  const result = await proxyOperation(operation, params);
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);

process.on("beforeExit", async () => {
  if (upstreamTransport) {
    await upstreamTransport.close();
  }
});
`;
}

export async function generateAdapterPackage(options: {
  schemaPath: string;
  provenancePath?: string;
  outDir: string;
}): Promise<void> {
  const schema = await readJsonFile<AdapterSchemaDocument>(options.schemaPath);
  const provenance = options.provenancePath
    ? await readJsonFile<Record<string, unknown>>(options.provenancePath)
    : { generated_at: new Date().toISOString() };

  const outDir = options.outDir;
  await writeJsonFile(path.join(outDir, "src/schema.json"), schema);
  await writeJsonFile(path.join(outDir, "src/provenance.json"), provenance);

  await writeJsonFile(path.join(outDir, "package.json"), {
    name: packageName(schema),
    private: true,
    type: "module",
    scripts: {
      build: "tsc -p tsconfig.json",
      start: "tsx src/server.ts",
    },
    dependencies: {
      "@modelcontextprotocol/sdk": "^1.27.1",
    },
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
      strict: false,
      esModuleInterop: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      outDir: "dist",
      rootDir: "src",
      types: ["node"],
    },
    include: ["src/**/*.ts"],
  });

  await writeTextFile(path.join(outDir, "src/server.ts"), buildServerSource(schema));
  await writeTextFile(
    path.join(outDir, "README.md"),
    `# ${prettyToolName(schema.name)}\n\nGenerated MCP-AQL adapter package for ${schema.description}.\n\n## Supported Endpoints\n\n${buildEndpointDescriptions(schema)}\n\n## Running\n\nSet \`${schema.auth?.token_env ?? "GITHUB_PERSONAL_ACCESS_TOKEN"}\` and run:\n\n\`\`\`bash\nnpm install\nnpm run start\n\`\`\`\n`,
  );
}
