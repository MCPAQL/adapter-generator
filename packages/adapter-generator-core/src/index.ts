import type {
  AdapterSchemaDocument,
  AdapterSchemaOperation,
  DiscoveryBundle,
  DiscoveryOperation,
  SchemaBuildOutput,
  SchemaBuildOverrides,
  TemplateOverride,
  TemplateOverridesDocument,
  TemplateParamDef,
} from "./types.js";

export type {
  AdapterSchemaDocument,
  AdapterSchemaOperation,
  DangerLevel,
  DiscoveryBundle,
  DiscoveryOperation,
  DiscoveryParam,
  EndpointCategory,
  SchemaBuildOutput,
  SchemaBuildOverrides,
  TemplateOverride,
  TemplateOverridesDocument,
  TemplateParamDef,
} from "./types.js";

export interface AdapterPackageFile {
  path: string;
  content: string;
}

export interface AdapterPackageContents {
  packageName: string;
  files: AdapterPackageFile[];
}

const ENDPOINT_KEY_BY_CATEGORY = {
  CREATE: "create",
  READ: "read",
  UPDATE: "update",
  DELETE: "delete",
  EXECUTE: "execute",
} as const;

const VALID_ENDPOINTS = new Set(["CREATE", "READ", "UPDATE", "DELETE", "EXECUTE"]);
const VALID_DANGER_LEVELS = new Set(["safe", "reversible", "destructive", "dangerous"]);

function validateOverrides(overrides?: SchemaBuildOverrides): void {
  if (!overrides?.operations) {
    return;
  }

  for (const [key, value] of Object.entries(overrides.operations)) {
    if (value.endpoint && !VALID_ENDPOINTS.has(value.endpoint)) {
      throw new Error(`Invalid override endpoint '${value.endpoint}' for operation key '${key}'.`);
    }

    const dangerLevel = value.danger_level as string | undefined;
    if (dangerLevel && !VALID_DANGER_LEVELS.has(dangerLevel)) {
      if (dangerLevel === "forbidden") {
        throw new Error(`Overrides cannot set danger_level to 'forbidden' for operation key '${key}' - remove the operation from the bundle instead.`);
      }

      throw new Error(`Invalid override danger_level '${dangerLevel}' for operation key '${key}'.`);
    }
  }
}

function applyOverrides(
  operation: DiscoveryOperation,
  overrides?: SchemaBuildOverrides["operations"],
): DiscoveryOperation {
  const override = overrides?.[operation.source_tool_name] ?? overrides?.[operation.operation_name];
  if (!override) {
    return operation;
  }

  const next: DiscoveryOperation = {
    ...operation,
    operation_name: override.operation_name ?? operation.operation_name,
    endpoint: override.endpoint ?? operation.endpoint,
    danger_level: override.danger_level ?? operation.danger_level,
    description: override.description ?? operation.description,
    needs_review: override.needs_review ?? operation.needs_review,
    review_reasons: [...operation.review_reasons],
  };

  if (override.review_reason) {
    next.review_reasons.push(override.review_reason);
  }

  return next;
}

function toSchemaOperation(operation: DiscoveryOperation): AdapterSchemaOperation {
  const params =
    operation.params.length > 0
      ? Object.fromEntries(
          operation.params.map((param) => [
            param.name,
            {
              type: param.type,
              required: param.required || undefined,
              description: param.description,
              default: param.default,
              enum: param.enum,
              minimum: param.minimum,
              maximum: param.maximum,
              pattern: param.pattern,
              format: param.format,
            },
          ]),
        )
      : undefined;

  if (operation.danger_level === "forbidden") {
    throw new Error(`Operation '${operation.operation_name}' cannot be emitted because danger_level 'forbidden' is not runnable.`);
  }

  return {
    name: operation.operation_name,
    maps_to: operation.maps_to,
    description: operation.description,
    params,
    response: {
      type: "object",
      description: "Wrapped upstream MCP tool result preserving content and structured payloads.",
    },
    danger_level: operation.danger_level,
    requires_confirmation: operation.danger_level === "destructive" || operation.danger_level === "dangerous",
    non_idempotent: operation.endpoint === "EXECUTE",
  };
}

function endpointKey(endpoint: DiscoveryOperation["endpoint"]): keyof AdapterSchemaDocument["operations"] {
  return ENDPOINT_KEY_BY_CATEGORY[endpoint];
}

export function buildSchemaFromDiscoveryBundle(options: {
  bundle: DiscoveryBundle;
  overrides?: SchemaBuildOverrides;
  generatedAt?: string;
}): SchemaBuildOutput {
  const bundle = options.bundle;
  const overrides = options.overrides;
  validateOverrides(overrides);

  const operations = bundle.normalized_bundle.operations.map((operation) => applyOverrides(operation, overrides?.operations));
  const adapterName = overrides?.adapter?.name ?? `${bundle.source.name}-adapter`;
  const tokenEnv = overrides?.adapter?.token_env ?? bundle.source.auth.token_env;

  const captureConfig = bundle.source.capture_config_redacted;
  const isNativeTransport = captureConfig?.transport === "native-applescript"
    || bundle.source.server_url.startsWith("native-applescript://");
  const transport: "http" | "native-applescript" = isNativeTransport ? "native-applescript" : "http";
  const application = isNativeTransport
    ? (captureConfig?.application as string | undefined) ?? bundle.source.server?.name
    : undefined;

  const capturedHeaders = captureConfig?.headers;
  const headers: Record<string, string> | undefined =
    capturedHeaders && typeof capturedHeaders === "object" && !Array.isArray(capturedHeaders)
      ? Object.fromEntries(
          Object.entries(capturedHeaders as Record<string, unknown>)
            .filter(([, value]) => typeof value === "string"),
        ) as Record<string, string>
      : undefined;

  const schema: AdapterSchemaDocument = {
    name: adapterName,
    type: "adapter",
    version: overrides?.adapter?.version ?? "0.1.0",
    description:
      overrides?.adapter?.description ??
      `Generated MCP-AQL adapter for ${bundle.source.server?.title ?? bundle.source.name}.`,
    target: {
      base_url: bundle.source.server_url.replace(/\/$/, ""),
      transport,
      protocol: "custom",
      serialization: "json",
      ...(application ? { application } : {}),
    },
    auth:
      bundle.source.auth.type === "bearer"
        ? {
            type: "bearer",
            header: "Authorization",
            prefix: "Bearer ",
            token_env: tokenEnv,
          }
        : undefined,
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    operations: {
      read: [],
    },
  };

  for (const operation of operations) {
    const key = endpointKey(operation.endpoint);
    const list = schema.operations[key] ?? [];
    list.push(toSchemaOperation(operation));
    schema.operations[key] = list;
  }

  return {
    schema,
    metadata: {
      generated_at: options.generatedAt ?? new Date().toISOString(),
      source_server_name: bundle.source.server?.name,
      source_server_version: bundle.source.server?.version,
      source_capture_name: bundle.source.name,
      warning_count: bundle.normalized_bundle.warnings.length,
      operation_count: operations.length,
      operations: operations.map((operation) => {
        const paramMappings = Object.fromEntries(
          operation.params
            .filter((param) => param.name !== param.original_name)
            .map((param) => [param.name, param.original_name]),
        );

        return {
          source_tool_name: operation.source_tool_name,
          operation_name: operation.operation_name,
          endpoint: operation.endpoint,
          needs_review: operation.needs_review,
          review_reasons: operation.review_reasons,
          param_mappings: Object.keys(paramMappings).length > 0 ? paramMappings : undefined,
        };
      }),
    },
    warnings: bundle.normalized_bundle.warnings,
  };
}

function jsonContent(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

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
 * Emitted template runtime for native adapters generated with template
 * overrides: parameter validation (required/type/defaults), interpolation
 * restricted to declared parameters, and a guard that refuses to execute
 * a script with unresolved placeholders — a missing parameter must never
 * reach osascript as broken JXA.
 */
const NATIVE_TEMPLATE_RUNTIME = `type TemplateParamMeta = { type: string; optional?: boolean; default?: unknown; description?: string };
type TemplateEntry = { language: string; script: string; params?: Record<string, TemplateParamMeta>; endpoint?: string; description?: string };
const templates = rawTemplates as Record<string, TemplateEntry>;

function validateTemplateParams(operationName: string, entry: TemplateEntry, params: Record<string, unknown>): Record<string, unknown> {
  const filled: Record<string, unknown> = { ...params };
  const missing: string[] = [];
  const badTypes: string[] = [];
  for (const [name, meta] of Object.entries(entry.params ?? {})) {
    validateParamKey(name);
    let value = filled[name];
    if (value === undefined && meta.default !== undefined) {
      value = meta.default;
      filled[name] = value;
    }
    if (value === undefined) {
      if (meta.optional !== true) missing.push(name);
      continue;
    }
    if (meta.type === "integer" && !(typeof value === "number" && Number.isInteger(value))) {
      badTypes.push(\`\${name} (expected integer)\`);
    } else if (meta.type === "real" && typeof value !== "number") {
      badTypes.push(\`\${name} (expected real)\`);
    } else if (meta.type === "text" && typeof value !== "string") {
      badTypes.push(\`\${name} (expected text)\`);
    } else if (meta.type === "boolean" && typeof value !== "boolean") {
      badTypes.push(\`\${name} (expected boolean)\`);
    }
  }
  if (missing.length > 0) {
    throw new NativeExecutionError("VALIDATION_MISSING_PARAM", \`Operation '\${operationName}' is missing required parameter(s): \${missing.join(", ")}. Use introspect for the parameter list.\`);
  }
  if (badTypes.length > 0) {
    throw new NativeExecutionError("VALIDATION_INVALID_PARAM_TYPE", \`Operation '\${operationName}' received wrong parameter type(s): \${badTypes.join(", ")}.\`);
  }
  return filled;
}

function interpolateTemplate(operationName: string, entry: TemplateEntry, params: Record<string, unknown>): string {
  let result = entry.script;
  for (const name of Object.keys(entry.params ?? {})) {
    const value = params[name];
    if (value === undefined) continue;
    result = result.replaceAll("{{" + name + "}}", sanitizeForJxa(value));
  }
  const unresolved = [...new Set(Array.from(result.matchAll(/\\{\\{(\\w+)\\}\\}/g), (m) => m[1]))];
  if (unresolved.length > 0) {
    throw new NativeExecutionError("VALIDATION_UNRESOLVED_PARAM", \`Operation '\${operationName}' template references parameter(s) with no supplied value or default: \${unresolved.join(", ")}. Refusing to execute a broken script.\`);
  }
  return result;
}
`;

/**
 * Emitted dispatch branch: templated operations short-circuit before the
 * maps_to fallback.
 */
const NATIVE_TEMPLATE_DISPATCH = `  // Own-property lookup: imported JSON inherits from Object.prototype, so an
  // operation named 'constructor' or 'toString' must not resolve to an
  // inherited function and shadow its maps_to implementation.
  const template = Object.prototype.hasOwnProperty.call(templates, operationName)
    ? templates[operationName]
    : undefined;
  if (template) {
    try {
      const filled = validateTemplateParams(operationName, template, params);
      const script = interpolateTemplate(operationName, template, filled);
      const result = await executeJxa(script, template.language);
      return { success: true, data: result };
    } catch (error: unknown) {
      return nativeErrorResult(error);
    }
  }
`;

function buildNativeAppleScriptServerSource(schema: AdapterSchemaDocument, hasTemplates = false): string {
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
const TIMEOUT_MS = (() => {
  const raw = Number(process.env.MCPAQL_NATIVE_TIMEOUT_MS ?? "");
  return Number.isFinite(raw) && raw >= 1_000 ? raw : 30_000;
})();
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

class NativeExecutionError extends Error {
  readonly code: string;
  readonly detail?: Record<string, unknown>;
  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "NativeExecutionError";
    this.code = code;
    this.detail = detail;
  }
}

function nativeErrorResult(error: unknown) {
  if (error instanceof NativeExecutionError) {
    return { success: false, error: { code: error.code, message: error.message, ...(error.detail ?? {}) } };
  }
  return { success: false, error: { code: "TRANSPORT_NATIVE_EXECUTION_ERROR", message: error instanceof Error ? error.message : String(error) } };
}

async function executeJxa(script: string, language: string = "JavaScript"): Promise<unknown> {
  const args = language === "AppleScript" ? ["-e", script] : ["-l", "JavaScript", "-e", script];
  const startedAt = Date.now();
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", args, {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT,
    });
    try { return JSON.parse(stdout.trim()); } catch { return stdout.trim(); }
  } catch (error: unknown) {
    // Never surface an empty failure: name the exit code or signal, the
    // elapsed time vs the limit, and preserve execution-layer causes
    // (string error codes such as maxBuffer overflows) that reject with
    // empty stderr.
    const execError = error as {
      code?: string | number;
      killed?: boolean;
      signal?: string;
      stdout?: string;
      stderr?: string;
    };
    const elapsedMs = Date.now() - startedAt;
    const timedOut = execError.killed === true || execError.signal === "SIGTERM";
    const stringCode = typeof execError.code === "string" ? execError.code : undefined;
    let stderr = (execError.stderr ?? "").trim();
    if (stderr === "" && stringCode !== undefined) {
      stderr = \`\${stringCode}: \${error instanceof Error ? error.message : String(error)}\`;
    }
    const exitCode = typeof execError.code === "number" ? execError.code : (timedOut ? -1 : 1);
    const stdoutPreview = (execError.stdout ?? "").trim().slice(0, 200) || undefined;
    const parts: string[] = [];
    if (timedOut) {
      parts.push(\`osascript timed out after \${elapsedMs}ms (limit \${TIMEOUT_MS}ms)\`);
    } else if (execError.signal) {
      parts.push(\`osascript was terminated by \${execError.signal} after \${elapsedMs}ms\`);
    } else {
      parts.push(\`osascript exited with code \${exitCode} after \${elapsedMs}ms\`);
    }
    if (!timedOut) {
      parts.push(stderr !== "" ? \`stderr: \${stderr.slice(0, 500)}\${stderr.length > 500 ? "…" : ""}\` : "stderr was empty");
    }
    if ((timedOut || stderr === "") && stdoutPreview !== undefined) {
      parts.push(\`stdout preview: \${stdoutPreview}\`);
    }
    throw new NativeExecutionError(
      timedOut ? "TRANSPORT_NATIVE_TIMEOUT" : "TRANSPORT_NATIVE_EXECUTION_ERROR",
      parts.join(". "),
      { exitCode, signal: execError.signal ?? null, elapsedMs, timeoutMs: TIMEOUT_MS, stderr: stderr === "" ? undefined : stderr, stdoutPreview },
    );
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

${hasTemplates ? NATIVE_TEMPLATE_RUNTIME : ""}
async function handleNativeOperation(operationName: string, params: Record<string, unknown>) {
${hasTemplates ? NATIVE_TEMPLATE_DISPATCH : ""}  const item = TOOL_BY_OPERATION.get(operationName);
  if (!item) return { success: false, error: { code: "NOT_FOUND_OPERATION", message: \`Unknown operation: \${operationName}\` } };
  try {
    const script = buildJxaScript(item.definition.maps_to, params);
    const result = await executeJxa(script);
    return { success: true, data: result };
  } catch (error: unknown) {
    return nativeErrorResult(error);
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
  headers?: Record<string, string>;
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

const schema = rawSchema as unknown as AdapterSchema;
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

  // Carry discovery-time headers (e.g., toolset selectors) and add the live bearer
  // token. HTTP header names are case-insensitive, and some Fetch implementations
  // combine duplicate-name-different-case headers with commas, so we must drop any
  // captured header whose name case-insensitively matches the configured auth header
  // before adding the live token. Without this, a bundle containing a lowercase
  // authorization key (e.g., from a lower-casing HTTP client) would land alongside
  // the live Authorization header and produce a malformed combined value upstream.
  const authHeaderName = schema.auth?.header ?? "Authorization";
  const authHeaderLower = authHeaderName.toLowerCase();
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(schema.headers ?? {})) {
    if (name.toLowerCase() === authHeaderLower) continue;
    headers[name] = value;
  }
  if (schema.auth?.type === "bearer") {
    headers[authHeaderName] = \`\${schema.auth.prefix ?? "Bearer "}\${resolveToken()}\`;
  }
  const transport = new StreamableHTTPClientTransport(new URL(resolveBaseUrl()), {
    requestInit: {
      headers: Object.keys(headers).length > 0 ? headers : undefined,
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

const TEMPLATE_PARAM_TYPES = new Set(["text", "integer", "boolean", "real"]);
const IDENTIFIER_PATTERN = /^[a-zA-Z_][\w]*$/;

function templateParamToSchemaParam(meta: TemplateParamDef): {
  type: string;
  required: boolean;
  default?: unknown;
  description?: string;
} {
  const required = meta.optional !== true && meta.default === undefined;
  const param: { type: string; required: boolean; default?: unknown; description?: string } = {
    type: meta.type,
    required,
  };
  if (meta.default !== undefined) {
    param.default = meta.default;
  }
  if (meta.description !== undefined) {
    param.description = meta.description;
  }
  return param;
}

function validateTemplates(doc: TemplateOverridesDocument, schema: AdapterSchemaDocument): void {
  if (schema.target.transport !== "native-applescript") {
    throw new Error("Template overrides are only supported for native-applescript adapters.");
  }
  const knownOperations = new Set<string>();
  for (const operations of Object.values(schema.operations)) {
    for (const operation of operations ?? []) {
      knownOperations.add(operation.name);
    }
  }
  for (const [name, template] of Object.entries(doc.templates)) {
    if (!IDENTIFIER_PATTERN.test(name)) {
      throw new Error(`Invalid template operation name '${name}': must be an identifier.`);
    }
    if (typeof template.script !== "string" || template.script.trim() === "") {
      throw new Error(`Template '${name}' has an empty script.`);
    }
    if (template.language !== "JavaScript" && template.language !== "AppleScript") {
      throw new Error(`Template '${name}' has invalid language '${String(template.language)}'.`);
    }
    for (const [paramName, meta] of Object.entries(template.params ?? {})) {
      if (!IDENTIFIER_PATTERN.test(paramName)) {
        throw new Error(`Template '${name}' has invalid parameter name '${paramName}'.`);
      }
      if (!TEMPLATE_PARAM_TYPES.has(meta.type)) {
        throw new Error(`Template '${name}' parameter '${paramName}' has invalid type '${String(meta.type)}'.`);
      }
      if (meta.default !== undefined) {
        const d = meta.default;
        const defaultTypeOk =
          (meta.type === "text" && typeof d === "string")
          || (meta.type === "integer" && typeof d === "number" && Number.isInteger(d))
          || (meta.type === "real" && typeof d === "number" && Number.isFinite(d))
          || (meta.type === "boolean" && typeof d === "boolean");
        if (!defaultTypeOk) {
          throw new Error(`Template '${name}' parameter '${paramName}' declares type '${meta.type}' but its default ${JSON.stringify(d)} does not match — every call omitting it would fail type validation.`);
        }
      }
    }
    if (!knownOperations.has(name)) {
      if (!template.endpoint || !VALID_ENDPOINTS.has(template.endpoint)) {
        throw new Error(`Template-only operation '${name}' requires a valid CRUDE endpoint.`);
      }
      if (!template.description) {
        throw new Error(`Template-only operation '${name}' requires a description.`);
      }
    }
  }
}

/**
 * Merge template overrides into the adapter schema so introspection tells
 * the truth: template params (with required/default derived from the
 * template declaration) replace the params of matching schema operations,
 * and template-only operations are injected under their declared endpoint.
 */
function applyTemplatesToSchema(
  schema: AdapterSchemaDocument,
  doc: TemplateOverridesDocument,
): AdapterSchemaDocument {
  const next: AdapterSchemaDocument = JSON.parse(JSON.stringify(schema)) as AdapterSchemaDocument;
  const operationsByName = new Map<string, AdapterSchemaOperation>();
  for (const operations of Object.values(next.operations)) {
    for (const operation of operations ?? []) {
      operationsByName.set(operation.name, operation);
    }
  }
  for (const [name, template] of Object.entries(doc.templates)) {
    const mappedParams: Record<string, ReturnType<typeof templateParamToSchemaParam>> = {};
    for (const [paramName, meta] of Object.entries(template.params ?? {})) {
      mappedParams[paramName] = templateParamToSchemaParam(meta);
    }
    const existing = operationsByName.get(name);
    if (existing) {
      existing.params = mappedParams;
      if (template.description) {
        existing.description = template.description;
      }
      continue;
    }
    const endpointKey = ENDPOINT_KEY_BY_CATEGORY[template.endpoint as keyof typeof ENDPOINT_KEY_BY_CATEGORY];
    const bucket = next.operations[endpointKey] ?? (next.operations[endpointKey] = []);
    bucket.push({
      name,
      maps_to: `native-applescript:template:${name}`,
      description: template.description ?? name,
      params: mappedParams,
    } as AdapterSchemaOperation);
  }
  return next;
}

export function generateAdapterPackage(options: {
  schema: AdapterSchemaDocument;
  provenance?: Record<string, unknown>;
  generatedAt?: string;
  templates?: TemplateOverridesDocument;
}): AdapterPackageContents {
  let schema = options.schema;
  const provenance = options.provenance ?? { generated_at: options.generatedAt ?? new Date().toISOString() };
  if (schema.target.transport === "native-applescript" && !schema.target.application) {
    throw new Error("native-applescript adapter schema requires target.application");
  }

  const hasTemplates = options.templates !== undefined
    && Object.keys(options.templates.templates ?? {}).length > 0;
  if (hasTemplates) {
    validateTemplates(options.templates!, schema);
    schema = applyTemplatesToSchema(schema, options.templates!);
  }

  const serverSource = schema.target.transport === "native-applescript"
    ? buildNativeAppleScriptServerSource(schema, hasTemplates)
    : buildServerSource(schema);

  const dependencies: Record<string, string> = { "@modelcontextprotocol/sdk": "^1.27.1" };

  const packageJson = {
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
  };

  const tsconfig = {
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
  };

  const files: AdapterPackageFile[] = [
    { path: "src/schema.json", content: jsonContent(schema) },
    { path: "src/provenance.json", content: jsonContent(provenance) },
  ];
  if (hasTemplates) {
    files.push({ path: "src/templates.json", content: jsonContent(options.templates!.templates) });
  }

  return {
    packageName: packageName(schema),
    files: [
      ...files,
      { path: "package.json", content: jsonContent(packageJson) },
      { path: "tsconfig.json", content: jsonContent(tsconfig) },
      { path: "src/server.ts", content: serverSource },
      {
        path: "README.md",
        content: `# ${prettyToolName(schema.name)}\n\nGenerated MCP-AQL adapter package for ${adapterReadmeSubject(schema.description)}.\n\n## Supported Endpoints\n\n${buildEndpointDescriptions(schema)}\n\n${buildRunningSection(schema)}`,
      },
    ],
  };
}
