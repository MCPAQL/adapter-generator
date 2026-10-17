import { TENANCY_RUNTIME } from "./tenancy-runtime.js";
import type {
  AdapterPackageConfig,
  AdapterSchemaDocument,
  AdapterResultShaping,
  AdapterSchemaOperation,
  AdapterStdioTarget,
  AdapterTenancy,
  DiscoveryBundle,
  DiscoveryOperation,
  SchemaBuildOutput,
  SchemaBuildOverrides,
  TemplateOverride,
  TemplateOverridesDocument,
  TemplateParamDef,
} from "./types.js";

export type {
  AdapterPackageConfig,
  AdapterResultHandle,
  AdapterResultShaping,
  AdapterSchemaDocument,
  AdapterSchemaOperation,
  AdapterStdioTarget,
  AdapterTenancy,
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
  if (overrides?.exclude_endpoints !== undefined && !Array.isArray(overrides.exclude_endpoints)) {
    throw new Error("exclude_endpoints must be an array of endpoint names.");
  }
  for (const endpoint of overrides?.exclude_endpoints ?? []) {
    if (!VALID_ENDPOINTS.has(endpoint)) {
      throw new Error(`Invalid exclude_endpoints entry '${endpoint}'.`);
    }
  }
  if (!overrides?.operations) {
    return;
  }

  for (const [key, value] of Object.entries(overrides.operations)) {
    if (value.endpoint && !VALID_ENDPOINTS.has(value.endpoint)) {
      throw new Error(`Invalid override endpoint '${value.endpoint}' for operation key '${key}'.`);
    }

    if (value.exclude !== undefined && typeof value.exclude !== "boolean") {
      throw new Error(`Override exclude for operation key '${key}' must be a boolean.`);
    }
    if (value.exclude_reason !== undefined && value.exclude !== true) {
      throw new Error(`Override for operation key '${key}' sets exclude_reason without exclude: true.`);
    }

    const dangerLevel = value.danger_level as string | undefined;
    if (dangerLevel && !VALID_DANGER_LEVELS.has(dangerLevel)) {
      if (dangerLevel === "forbidden") {
        throw new Error(`Overrides cannot set danger_level to 'forbidden' for operation key '${key}' - set exclude: true to leave the operation out instead.`);
      }

      throw new Error(`Invalid override danger_level '${dangerLevel}' for operation key '${key}'.`);
    }
  }
}

const TENANCY_NOUN_PATTERN = /^[a-z][a-z0-9_]*$/;

function validateTenancy(tenancy: AdapterTenancy, operations: DiscoveryOperation[]): void {
  for (const field of ["header", "noun", "list_operation", "id_field", "name_field"] as const) {
    if (typeof tenancy[field] !== "string" || tenancy[field].trim() === "") {
      throw new Error(`Tenancy override requires a non-empty '${field}'.`);
    }
  }
  if (!TENANCY_NOUN_PATTERN.test(tenancy.noun)) {
    throw new Error(`Tenancy noun '${tenancy.noun}' must be lowercase snake_case.`);
  }
  const byName = new Map(operations.map((operation) => [operation.operation_name, operation]));
  const listOperation = byName.get(tenancy.list_operation);
  if (!listOperation || listOperation.endpoint !== "READ") {
    throw new Error(`Tenancy list_operation '${tenancy.list_operation}' must be a READ operation in the schema.`);
  }
  if (listOperation.params.some((param) => param.required)) {
    throw new Error(`Tenancy list_operation '${tenancy.list_operation}' must not have required parameters; the adapter calls it with none.`);
  }
  for (const name of tenancy.unscoped_operations ?? []) {
    if (!byName.has(name)) {
      throw new Error(`Tenancy unscoped operation '${name}' is not in the schema.`);
    }
  }
  // An operation that owns <noun>_id takes the tenant as its own argument, so it must be sent without the header.
  const tenantParam = `${tenancy.noun}_id`;
  const unscoped = new Set([tenancy.list_operation, ...(tenancy.unscoped_operations ?? [])]);
  for (const operation of operations) {
    if (!unscoped.has(operation.operation_name) && operation.params.some((param) => param.name === tenantParam)) {
      throw new Error(`Operation '${operation.operation_name}' declares '${tenantParam}'; add it to tenancy.unscoped_operations.`);
    }
  }
  const reserved = [`get_active_${tenancy.noun}`, `set_active_${tenancy.noun}`];
  for (const name of reserved) {
    if (byName.has(name)) {
      throw new Error(`Tenancy would generate '${name}', which collides with an existing operation.`);
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

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REDACTED = "<redacted>";

function stringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`stdio ${label} must be an array of strings.`);
  }
  return value as string[];
}

// Each launch field comes from overrides when set, otherwise from the capture, so an override
// can pin args (e.g. an exact package version) without restating the command. An override
// replaces a whole field: overrides.stdio.env replaces the captured env, it is not merged per key.
function resolveStdioTarget(
  captured: Record<string, unknown> | undefined,
  override: Partial<AdapterStdioTarget> | undefined,
): AdapterStdioTarget {
  const pick = (field: keyof AdapterStdioTarget): unknown =>
    override && override[field] !== undefined ? override[field] : captured?.[field];

  const command = pick("command");
  if (typeof command !== "string" || command.trim() === "") {
    throw new Error("stdio transport requires a command (capture config or overrides.stdio.command).");
  }
  const args = stringArray(pick("args"), "args");
  const cwdValue = pick("cwd");
  if (cwdValue !== undefined && typeof cwdValue !== "string") {
    throw new Error("stdio cwd must be a string.");
  }
  const cwd = cwdValue as string | undefined;
  const envPassthrough = stringArray(pick("env_passthrough"), "env_passthrough");
  const envValue = pick("env");
  if (envValue !== undefined && (envValue === null || typeof envValue !== "object" || Array.isArray(envValue))) {
    throw new Error("stdio env must be an object of string values.");
  }
  const env = envValue as Record<string, unknown> | undefined;

  for (const name of [...(envPassthrough ?? []), ...Object.keys(env ?? {})]) {
    if (!ENV_NAME_PATTERN.test(name)) throw new Error(`Invalid stdio environment variable name '${name}'.`);
  }
  for (const [name, value] of Object.entries(env ?? {})) {
    if (typeof value !== "string") throw new Error(`stdio env value for '${name}' must be a string.`);
  }
  // Discovery redacts secret-looking launch values. Launching with the placeholder would fail
  // upstream auth with no hint, so require the value to be supplied explicitly instead.
  const redacted = [
    ...(command.includes(REDACTED) ? ["command"] : []),
    ...(args ?? []).flatMap((arg, index) => (arg.includes(REDACTED) ? [`args[${index}]`] : [])),
    ...Object.entries(env ?? {}).flatMap(([name, value]) => (String(value).includes(REDACTED) ? [`env.${name}`] : [])),
  ];
  if (redacted.length > 0) {
    throw new Error(
      `stdio launch config contains redacted values (${redacted.join(", ")}). Supply them in overrides.stdio, `
      + "using \"${env:VAR}\" references for secrets so they are read at spawn time and never written into the schema.",
    );
  }

  return {
    command,
    ...(args && args.length > 0 ? { args } : {}),
    ...(cwd ? { cwd } : {}),
    ...(envPassthrough && envPassthrough.length > 0 ? { env_passthrough: envPassthrough } : {}),
    ...(env && Object.keys(env).length > 0 ? { env: env as Record<string, string> } : {}),
  };
}

const HANDLE_PLACEHOLDER = "${handle}";

function containsPlaceholder(value: unknown): boolean {
  if (value === HANDLE_PLACEHOLDER) return true;
  if (Array.isArray(value)) return value.some(containsPlaceholder);
  if (value && typeof value === "object") return Object.values(value).some(containsPlaceholder);
  return false;
}

// Shaping only pays off if the model can get the full data back, so every handle rule must
// name operations that exist and a READ continuation that takes the handle id.
function validateResultShaping(shaping: AdapterResultShaping, schema: AdapterSchemaDocument): AdapterResultShaping {
  if (shaping.max_result_chars !== undefined && (!Number.isSafeInteger(shaping.max_result_chars) || shaping.max_result_chars < 0)) {
    throw new Error("result_shaping.max_result_chars must be a non-negative integer.");
  }
  if (shaping.drop_duplicate_text !== undefined && typeof shaping.drop_duplicate_text !== "boolean") {
    throw new Error("result_shaping.drop_duplicate_text must be a boolean.");
  }
  const endpointOf = new Map<string, string>();
  for (const [endpoint, operations] of Object.entries(schema.operations)) {
    for (const operation of operations ?? []) endpointOf.set(operation.name, endpoint);
  }
  for (const [index, rule] of (shaping.handles ?? []).entries()) {
    const label = `result_shaping.handles[${index}]`;
    if (!Array.isArray(rule.operations) || rule.operations.length === 0) throw new Error(`${label}.operations must list at least one operation.`);
    for (const name of rule.operations) {
      if (!endpointOf.has(name)) throw new Error(`${label} names operation '${name}', which is not in the adapter.`);
    }
    if (typeof rule.id_path !== "string" || rule.id_path === "") throw new Error(`${label}.id_path must be a non-empty string.`);
    if (!Array.isArray(rule.keep_paths) || rule.keep_paths.some((path) => typeof path !== "string" || path === "")) {
      throw new Error(`${label}.keep_paths must be an array of non-empty strings.`);
    }
    if (!rule.keep_paths.includes(rule.id_path)) throw new Error(`${label}.keep_paths must include id_path '${rule.id_path}'.`);
    const continuation = rule.continuation;
    if (!continuation || endpointOf.get(continuation.operation) !== "read") {
      throw new Error(`${label}.continuation.operation must be a READ operation in the adapter.`);
    }
    if (!containsPlaceholder(continuation.params)) {
      throw new Error(`${label}.continuation.params must pass the handle as "${HANDLE_PLACEHOLDER}".`);
    }
  }
  return shaping;
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

  const overridden = bundle.normalized_bundle.operations.map((operation) => applyOverrides(operation, overrides?.operations));
  const excludedEndpoints = new Set(overrides?.exclude_endpoints ?? []);
  const excludedOperations: NonNullable<SchemaBuildOutput["metadata"]["excluded_operations"]> = [];

  // Exclusion is a safety control, so it fails closed: an exclude key that names no operation
  // is an error, and an operation is excluded if any override that names it says so (by source
  // tool name, bundle operation name, or the name an override renamed it to).
  const excludeKeys = Object.entries(overrides?.operations ?? {}).filter(([, value]) => value.exclude === true).map(([key]) => key);
  const namesFor = (index: number) => {
    const source = bundle.normalized_bundle.operations[index];
    return [source.source_tool_name, source.operation_name, overridden[index].operation_name];
  };
  for (const key of excludeKeys) {
    if (!overridden.some((_, index) => namesFor(index).includes(key))) {
      throw new Error(`Override '${key}' sets exclude, but no operation in the bundle has that name.`);
    }
  }
  const operations = overridden.filter((operation, index) => {
    const excludingKey = namesFor(index).find((name) => excludeKeys.includes(name));
    const reason = excludingKey
      ? overrides?.operations?.[excludingKey]?.exclude_reason ?? "excluded by operation override"
      : excludedEndpoints.has(operation.endpoint) ? `endpoint ${operation.endpoint} excluded by exclude_endpoints` : undefined;
    if (!reason) return true;
    excludedOperations.push({
      source_tool_name: operation.source_tool_name,
      operation_name: operation.operation_name,
      endpoint: operation.endpoint,
      reason,
    });
    return false;
  });
  const adapterName = overrides?.adapter?.name ?? `${bundle.source.name}-adapter`;
  const tokenEnv = overrides?.adapter?.token_env ?? bundle.source.auth.token_env;

  const captureConfig = bundle.source.capture_config_redacted;
  const isNativeTransport = captureConfig?.transport === "native-applescript"
    || bundle.source.server_url.startsWith("native-applescript://");
  // Interrogation configs record transport as { type, ...launch fields }; hand-written captures may use a bare string.
  const transportConfig = captureConfig?.transport && typeof captureConfig.transport === "object" && !Array.isArray(captureConfig.transport)
    ? captureConfig.transport as Record<string, unknown>
    : undefined;
  const isStdioTransport = !isNativeTransport
    && (captureConfig?.transport === "stdio" || transportConfig?.type === "stdio" || bundle.source.server_url.startsWith("stdio://"));
  const transport: AdapterSchemaDocument["target"]["transport"] = isNativeTransport
    ? "native-applescript"
    : isStdioTransport ? "stdio" : "http";
  if (overrides?.stdio && !isStdioTransport) {
    throw new Error("overrides.stdio applies only to stdio upstreams.");
  }
  const application = isNativeTransport
    ? (captureConfig?.application as string | undefined) ?? bundle.source.server?.name
    : undefined;
  const stdio = isStdioTransport ? resolveStdioTarget(transportConfig ?? captureConfig, overrides?.stdio) : undefined;

  // Request headers exist only on HTTP upstreams.
  const capturedHeaders = isStdioTransport ? undefined : captureConfig?.headers;
  const headers: Record<string, string> | undefined =
    capturedHeaders && typeof capturedHeaders === "object" && !Array.isArray(capturedHeaders)
      ? Object.fromEntries(
          Object.entries(capturedHeaders as Record<string, unknown>)
            .filter(([, value]) => typeof value === "string"),
        ) as Record<string, string>
      : undefined;

  const tenancy = overrides?.tenancy;
  if (tenancy) {
    if (transport !== "http") {
      throw new Error("Tenancy is supported only for HTTP upstreams.");
    }
    validateTenancy(tenancy, operations);
    // The adapter chooses the tenant per call, so a captured static tenant header must not ride along.
    if (headers) {
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === tenancy.header.toLowerCase()) delete headers[name];
      }
    }
  }

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
      ...(stdio ? { stdio } : {}),
    },
    auth:
      bundle.source.auth.type === "bearer" && !isStdioTransport
        ? {
            type: "bearer",
            header: "Authorization",
            prefix: "Bearer ",
            token_env: tokenEnv,
          }
        : undefined,
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    ...(tenancy ? { tenancy } : {}),
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

  if (overrides?.result_shaping) {
    schema.result_shaping = validateResultShaping(overrides.result_shaping, schema);
  }

  const builderWarnings: SchemaBuildOutput["warnings"] = isStdioTransport && bundle.source.auth.type === "bearer"
    ? [
        {
          code: "STDIO_AUTH_IGNORED",
          severity: "warning",
          message: "Bearer auth does not apply to stdio upstreams and was dropped; pass credentials with overrides.stdio.env \"${env:VAR}\" references or env_passthrough.",
        },
      ]
    : [];
  const warnings = [...bundle.normalized_bundle.warnings, ...builderWarnings];

  return {
    schema,
    metadata: {
      generated_at: options.generatedAt ?? new Date().toISOString(),
      source_server_name: bundle.source.server?.name,
      source_server_version: bundle.source.server?.version,
      source_capture_name: bundle.source.name,
      warning_count: warnings.length,
      operation_count: operations.length,
      ...(excludedOperations.length > 0 ? { excluded_operations: excludedOperations } : {}),
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
    warnings,
  };
}

function jsonContent(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function packageName(schema: AdapterSchemaDocument, config?: AdapterPackageConfig): string {
  return config?.name ?? `@mcpaql/generated-${schema.name}`;
}

const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const BIN_NAME = /^[a-z0-9][a-z0-9._-]*$/;

function binName(config: AdapterPackageConfig): string {
  return config.bin ?? config.name.slice(config.name.lastIndexOf("/") + 1);
}

function validatePackageConfig(config: AdapterPackageConfig): void {
  if (typeof config.name !== "string" || config.name.length > 214 || !NPM_PACKAGE_NAME.test(config.name)) {
    throw new Error(`package name '${String(config.name)}' is not a valid npm package name`);
  }
  if (!BIN_NAME.test(binName(config))) {
    throw new Error(`package bin '${binName(config)}' must be lowercase letters, digits, '.', '_' or '-'`);
  }
  if (config.version !== undefined && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(config.version)) {
    throw new Error(`package version '${config.version}' is not a semver version`);
  }
}

/** Env vars a generated adapter reads: [variable, required, description]. */
function adapterEnvVars(schema: AdapterSchemaDocument): Array<[string, boolean, string]> {
  const vars: Array<[string, boolean, string]> = [];
  if (schema.auth?.type === "bearer") {
    vars.push([schema.auth.token_env ?? "UPSTREAM_BEARER_TOKEN", true, "upstream API token"]);
  }
  for (const [name, value] of Object.entries(schema.headers ?? {})) {
    const variable = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)?.[1];
    if (variable) vars.push([variable, true, `sent as the \`${name}\` header`]);
  }
  if (schema.tenancy?.default_env) {
    vars.push([schema.tenancy.default_env, false, `starting ${schema.tenancy.noun}, by id or name`]);
  }
  for (const [name, value] of Object.entries(schema.target.stdio?.env ?? {})) {
    const variable = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)?.[1];
    if (variable) vars.push([variable, true, `passed to the upstream as \`${name}\``]);
  }
  for (const name of schema.target.stdio?.env_passthrough ?? []) {
    vars.push([name, false, "passed through to the upstream process"]);
  }
  return vars;
}

function buildInstallSection(schema: AdapterSchemaDocument, config: AdapterPackageConfig): string {
  const vars = adapterEnvVars(schema);
  const env = Object.fromEntries(vars.filter(([, required]) => required).map(([variable]) => [variable, "..."]));
  const serverKey = binName(config);
  const clientConfig = JSON.stringify(
    { mcpServers: { [serverKey]: { command: "npx", args: ["-y", config.name], ...(Object.keys(env).length > 0 ? { env } : {}) } } },
    null,
    2,
  );
  const claudeEnv = Object.keys(env).map((variable) => `-e ${variable}=... `).join("");
  const varLines = vars.map(([variable, required, description]) => `- \`${variable}\` (${required ? "required" : "optional"}): ${description}.`);
  return `## Install

Add the adapter to any MCP client; \`npx\` downloads and runs it, with nothing to clone or build:

\`\`\`json
${clientConfig}
\`\`\`

Or, in Claude Code:

\`\`\`bash
claude mcp add ${serverKey} ${claudeEnv}-- npx -y ${config.name}
\`\`\`
${varLines.length > 0 ? `\n${varLines.join("\n")}\n` : ""}
`;
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

const CALL_CONTROL_SECTION = `Upstream calls follow the caller's cancellation and forward upstream progress. Optional limits:

- \`MCPAQL_UPSTREAM_TIMEOUT_MS\` (default 60000): per-call deadline, reset by each upstream progress notification.
- \`MCPAQL_UPSTREAM_MAX_TOTAL_TIMEOUT_MS\`: hard cap per call, regardless of progress; the upstream call is cancelled when it is reached.

Every endpoint except EXECUTE also accepts a batch, \`{ operations: [{ operation, params }, ...] }\`, run in order (\`MCPAQL_MAX_BATCH_OPERATIONS\`, default 25). A batch stops before any dangerous or confirmation-gated operation, which must be called on its own; a batch's duration is the sum of its operations.
`;

function resultShapingSection(schema: AdapterSchemaDocument): string {
  const shaping = schema.result_shaping;
  if (!shaping) return "";
  const lines = ["", "Result shaping is on:", ""];
  if (shaping.drop_duplicate_text) {
    lines.push("- Text content that duplicates structured content is dropped.");
  }
  const operations = (shaping.handles ?? []).flatMap((rule) => rule.operations).length;
  if (operations > 0) {
    lines.push(
      `- Over ${shaping.max_result_chars ?? 0} characters (\`MCPAQL_RESULT_BUDGET_CHARS\` overrides; 0 disables), results of ${operations} operations become a summary plus a ready-to-call continuation that pages the retained result.`,
    );
  }
  lines.push("- Every shaped result lists what it omitted in `_meta.shaped`. Pass `params._full_result: true` to get the unshaped result.");
  return `${lines.join("\n")}\n`;
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

  if (schema.target.transport === "stdio" && schema.target.stdio) {
    const launch = [schema.target.stdio.command, ...(schema.target.stdio.args ?? [])].join(" ");
    const varLines = adapterEnvVars(schema).map(
      ([variable, required, description]) => `- \`${variable}\` (${required ? "required" : "optional"}): ${description}.`,
    );
    return `## Running

Requires Node.js 20 or newer.

On the first call, this adapter starts its upstream MCP server as a child process and keeps it running:

\`\`\`bash
${launch}
\`\`\`

The child receives a minimal environment (the MCP SDK default) plus only the variables listed below. Its stderr goes to the adapter's stderr.
${varLines.length > 0 ? `\n${varLines.join("\n")}\n` : ""}
\`\`\`bash
npm install
npm run start
\`\`\`

${CALL_CONTROL_SECTION}${resultShapingSection(schema)}`;
  }

  const authLine =
    schema.auth?.type === "bearer"
      ? `Set \`${schema.auth.token_env ?? "UPSTREAM_BEARER_TOKEN"}\` and run:`
      : "Run:";
  // Header values of the form \${env:VAR} must be set before the first call; the tenancy start variable is optional.
  const headerEnvVars = Object.entries(schema.headers ?? {})
    .map(([name, value]) => [name, /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)?.[1]] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[1]));
  const envLines = [
    ...headerEnvVars.map(([name, variable]) => `- \`${variable}\` (required): sent as the \`${name}\` header.`),
    ...(schema.tenancy?.default_env
      ? [`- \`${schema.tenancy.default_env}\` (optional): starting ${schema.tenancy.noun}, by id or name.`]
      : []),
  ];
  const envSection = envLines.length > 0 ? `\nAlso set:\n\n${envLines.join("\n")}\n` : "";

  return `## Running

Requires Node.js 20 or newer.

Set \`MCPAQL_TARGET_BASE_URL\` if you want this adapter to connect to a different upstream server than the bundled \`${schema.target.base_url}\`.

${authLine}
${envSection}
\`\`\`bash
npm install
npm run start
\`\`\`

${CALL_CONTROL_SECTION}${resultShapingSection(schema)}`;
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
    content: [{ type: "text", text: JSON.stringify(payload) }],
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

/** Emitted upstream runtime for streamable-HTTP adapters: bearer auth, captured headers, base URL override. */
const HTTP_UPSTREAM_RUNTIME = `let upstreamClient: Client | undefined;
let upstreamTransport: StreamableHTTPClientTransport | undefined;

function textResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
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

// A captured header value of the exact form "\${env:VAR_NAME}" is read from the
// environment at connect time, so per-tenant identifiers (project or workspace ids)
// never have to be committed in the generated schema.
function resolveHeaderValue(name: string, value: string): string {
  const match = /^\\$\\{env:([A-Za-z_][A-Za-z0-9_]*)\\}$/.exec(value);
  if (!match) {
    return value;
  }
  const resolved = process.env[match[1]];
  if (!resolved) {
    throw new Error(\`Missing env var '\${match[1]}' for upstream header '\${name}'.\`);
  }
  return resolved;
}

function resolveBaseUrl(): string {
  const override = process.env.MCPAQL_TARGET_BASE_URL?.trim();
  if (override) {
    return override;
  }

  return schema.target.base_url;
}

function buildUpstreamHeaders(): Record<string, string> {
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
    headers[name] = resolveHeaderValue(name, value);
  }
  if (schema.auth?.type === "bearer") {
    headers[authHeaderName] = \`\${schema.auth.prefix ?? "Bearer "}\${resolveToken()}\`;
  }
  return headers;
}

async function getUpstreamClient(): Promise<Client> {
  if (upstreamClient) {
    return upstreamClient;
  }

  const headers = buildUpstreamHeaders();
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
`;

/**
 * Emitted upstream runtime for stdio adapters. The child is spawned lazily and kept
 * for the life of the adapter so upstream session state survives across calls. Its
 * environment is the SDK's minimal default plus explicitly declared variables, and
 * its stderr goes to the adapter's stderr, never into tool results. If the child
 * exits unexpectedly, the next call reports that once (session state is gone) and
 * the call after that starts a fresh child.
 */
const STDIO_UPSTREAM_RUNTIME = `let upstreamClient: Client | undefined;
let upstreamTransport: StdioClientTransport | undefined;
let upstreamConnecting: Promise<Client> | undefined;
let startingTransport: StdioClientTransport | undefined;
let upstreamExitNotice: string | undefined;
let closingUpstream = false;

function textResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function resolveStdioTarget(): NonNullable<AdapterSchema["target"]["stdio"]> {
  const stdio = schema.target.stdio;
  if (!stdio?.command) {
    throw new Error("stdio schema is missing target.stdio.command");
  }
  return stdio;
}

// A configured value of the exact form "\${env:VAR_NAME}" is read from the adapter's
// environment at spawn time, so secrets never have to be committed in the schema.
function resolveChildEnvValue(name: string, value: string): string {
  const match = /^\\$\\{env:([A-Za-z_][A-Za-z0-9_]*)\\}$/.exec(value);
  if (!match) {
    return value;
  }
  const resolved = process.env[match[1]];
  if (resolved === undefined) {
    throw new Error(\`Missing env var '\${match[1]}' for upstream environment variable '\${name}'.\`);
  }
  return resolved;
}

function buildChildEnvironment(): Record<string, string> {
  const stdio = resolveStdioTarget();
  const env: Record<string, string> = { ...getDefaultEnvironment() };
  for (const name of stdio.env_passthrough ?? []) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(stdio.env ?? {})) {
    env[name] = resolveChildEnvValue(name, value);
  }
  return env;
}

// Concurrent first calls share one in-flight connection, so the adapter never runs two children.
async function getUpstreamClient(): Promise<Client> {
  if (upstreamClient) {
    return upstreamClient;
  }
  if (upstreamConnecting) {
    return upstreamConnecting;
  }
  if (upstreamExitNotice) {
    const notice = upstreamExitNotice;
    upstreamExitNotice = undefined;
    throw new Error(notice);
  }
  upstreamConnecting = connectUpstream().finally(() => {
    upstreamConnecting = undefined;
  });
  return upstreamConnecting;
}

async function connectUpstream(): Promise<Client> {
  const stdio = resolveStdioTarget();
  const transport = new StdioClientTransport({
    command: stdio.command,
    args: stdio.args ?? [],
    cwd: stdio.cwd,
    env: buildChildEnvironment(),
    stderr: "inherit",
  });
  const client = new Client({ name: schema.name, version: schema.version });
  client.onclose = () => {
    if (upstreamClient !== client) return;
    upstreamClient = undefined;
    upstreamTransport = undefined;
    if (!closingUpstream) {
      upstreamExitNotice = "The upstream process exited and its session state was lost. Retry to start a fresh upstream.";
    }
  };
  startingTransport = transport;
  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close();
    throw error;
  } finally {
    startingTransport = undefined;
  }
  // Shutdown may have started while the child was starting; it could not see this transport yet.
  if (closingUpstream) {
    await transport.close();
    throw new Error("The adapter is shutting down.");
  }
  upstreamClient = client;
  upstreamTransport = transport;
  return upstreamClient;
}
`;

function buildServerSource(schema: AdapterSchemaDocument): string {
  const tenancy = Boolean(schema.tenancy);
  const stdio = schema.target.transport === "stdio";
  if (stdio && !schema.target.stdio?.command) {
    throw new Error("stdio adapter schema requires target.stdio.command");
  }
  const upstreamImport = stdio
    ? `import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";`
    : `import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";`;
  return `import { Client } from "@modelcontextprotocol/sdk/client/index.js";
${upstreamImport}
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
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
    stdio?: {
      command: string;
      args?: string[];
      cwd?: string;
      env_passthrough?: string[];
      env?: Record<string, string>;
    };
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
  operations?: unknown;
};

const schema = rawSchema as unknown as AdapterSchema;
// Provenance is generated by the schema builder; this is a read-side projection of the broader metadata shape.
const adapterProvenance = provenance as unknown as AdapterProvenance;
${tenancy ? TENANCY_RUNTIME : ""}
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

${stdio ? STDIO_UPSTREAM_RUNTIME : HTTP_UPSTREAM_RUNTIME}
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
  delete clone.operations;
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
    ...(endpoint === "EXECUTE"
      ? ["", "Call EXECUTE operations one at a time; batches are not accepted."]
      : ["", \`Batch independent operations: { operations: [{ operation, params }, ...] } (up to \${MAX_BATCH_OPERATIONS}).\`]),
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
          // Batches are accepted on every endpoint except EXECUTE.
          capabilities: { batch: true, batch_max_operations: MAX_BATCH_OPERATIONS, batch_excluded_endpoints: ["EXECUTE"] },
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

type ResultHandleRule = {
  operations: string[];
  id_path: string;
  keep_paths: string[];
  continuation: { operation: string; params: Record<string, unknown> };
};
type ResultShaping = { max_result_chars?: number; drop_duplicate_text?: boolean; handles?: ResultHandleRule[] };
type ProxiedResult = { source_tool: string; content: unknown; structured_content: unknown; is_error: boolean };

const RESULT_SHAPING = (schema as unknown as { result_shaping?: ResultShaping }).result_shaping;
const RESULT_BUDGET_CHARS = process.env.MCPAQL_RESULT_BUDGET_CHARS?.trim() === "0"
  ? 0
  : positiveIntegerEnv("MCPAQL_RESULT_BUDGET_CHARS") ?? RESULT_SHAPING?.max_result_chars ?? 0;

function valueAtPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function pickPaths(value: unknown, paths: string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const path of paths) {
    const found = valueAtPath(value, path);
    if (found === undefined) continue;
    const segments = path.split(".");
    let target = picked;
    for (const segment of segments.slice(0, -1)) {
      target = (target[segment] ??= {}) as Record<string, unknown>;
    }
    target[segments[segments.length - 1]] = found;
  }
  return picked;
}

function withHandle(value: unknown, handle: string): unknown {
  if (value === "\${handle}") return handle;
  if (Array.isArray(value)) return value.map((entry) => withHandle(entry, handle));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, withHandle(entry, handle)]));
  }
  return value;
}

// Opt-in shaping of a successful result. Nothing is dropped silently: _meta.shaped lists what
// was omitted, and params._full_result: true returns the unshaped result.
function shapeResult(operationName: string, data: ProxiedResult, fullResult: boolean): { data: unknown; meta?: Record<string, unknown> } {
  if (!RESULT_SHAPING || fullResult) return { data };
  const omitted: string[] = [];
  let shaped: Record<string, unknown> = { ...data };
  if (RESULT_SHAPING.drop_duplicate_text && data.structured_content !== null && Array.isArray(data.content)) {
    const kept = (data.content as Array<{ type?: string }>).filter((block) => block.type !== "text");
    if (kept.length !== data.content.length) {
      shaped.content = kept;
      omitted.push("content text blocks (duplicate of structured_content)");
    }
  }
  if (RESULT_BUDGET_CHARS > 0 && JSON.stringify(shaped).length > RESULT_BUDGET_CHARS) {
    const rule = RESULT_SHAPING.handles?.find((candidate) => candidate.operations.includes(operationName));
    const handle = rule ? valueAtPath(data.structured_content, rule.id_path) : undefined;
    if (rule && typeof handle === "string" && handle !== "") {
      shaped = {
        source_tool: data.source_tool,
        content: [],
        structured_content: pickPaths(data.structured_content, rule.keep_paths),
        is_error: data.is_error,
        handle,
        continuation: withHandle(rule.continuation, handle),
      };
      omitted.push("content", \`structured_content except \${rule.keep_paths.join(", ")}\`);
    }
  }
  if (omitted.length === 0) return { data };
  return {
    data: shaped,
    meta: {
      shaped: {
        original_chars: JSON.stringify(data).length,
        returned_chars: JSON.stringify(shaped).length,
        omitted,
        full_result: "Repeat the call with params._full_result: true for the unshaped result.",
      },
    },
  };
}

type UpstreamCallContext = {
  signal?: AbortSignal;
  progressToken?: string | number;
  sendProgress?: (progress: { progress: number; total?: number; message?: string }) => Promise<void>;
};

// Node timers hold at most 2^31 - 1 ms; larger delays silently fire after 1 ms.
const MAX_TIMER_MS = 2_147_483_647;

function positiveIntegerEnv(name: string, unit = "milliseconds"): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = /^\\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new Error(\`\${name} must be a positive integer number of \${unit}, at most \${MAX_TIMER_MS}.\`);
  }
  return value;
}

// Per-call upstream deadline. Upstream progress notifications reset it, so long analyses that
// report progress keep running. MCPAQL_UPSTREAM_MAX_TOTAL_TIMEOUT_MS caps a call regardless of
// progress; the adapter enforces it with its own timer so the upstream is cancelled on time.
const UPSTREAM_TIMEOUT_MS = positiveIntegerEnv("MCPAQL_UPSTREAM_TIMEOUT_MS") ?? 60_000;
const UPSTREAM_MAX_TOTAL_TIMEOUT_MS = positiveIntegerEnv("MCPAQL_UPSTREAM_MAX_TOTAL_TIMEOUT_MS");

function upstreamCallError(error: unknown, call: UpstreamCallContext | undefined, sourceTool: string, capReached: boolean) {
  const message = error instanceof Error ? error.message : String(error);
  // The SDK reports aborts as RequestTimeout too, so check who aborted first. A cancelled
  // downstream request gets no response; this result is for logs and tests.
  if (call?.signal?.aborted) {
    return { success: false, error: { code: "CANCELLED", message: \`Call to upstream tool '\${sourceTool}' was cancelled.\` } };
  }
  if (capReached) {
    return {
      success: false,
      error: {
        code: "UPSTREAM_TIMEOUT",
        message: \`Upstream tool '\${sourceTool}' exceeded the maximum total time.\`,
        details: { source_tool: sourceTool, limit: "max_total", timeout_ms: UPSTREAM_MAX_TOTAL_TIMEOUT_MS },
      },
    };
  }
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
    return { success: false, error: { code: "UPSTREAM_TIMEOUT", message, details: { source_tool: sourceTool, limit: "per_call", timeout_ms: UPSTREAM_TIMEOUT_MS } } };
  }
  return { success: false, error: { code: "UPSTREAM_CALL_FAILED", message, details: { source_tool: sourceTool } } };
}

async function proxyOperation(operationName: string, params: Record<string, unknown>, call?: UpstreamCallContext) {
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

${tenancy ? `  let tenant: TenantRef | undefined;
  try {
    if (item.definition.maps_to.startsWith("adapter:")) {
      return await handleTenancyOperation(operationName, params);
    }
    params = { ...params };
    tenant = await resolveCallTenant(operationName, params);
  } catch (error) {
    return tenancyErrorResult(error);
  }
  const upstream = await getTenantClient(tenant?.id);
  const tenantMeta = tenant ? { [TENANCY.noun]: { id: tenant.id, name: tenant.name, source: tenant.source } } : {};` : `  let upstream: Client;
  try {
    upstream = await getUpstreamClient();
  } catch (error) {
    return {
      success: false,
      error: {
        code: "UPSTREAM_UNAVAILABLE",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }`}
  const sourceTool = item.definition.maps_to.replace(/^tool:/, "");
  // _full_result is the adapter's own flag; it never reaches the upstream.
  const fullResult = params._full_result === true;
  if ("_full_result" in params) {
    params = { ...params };
    delete params._full_result;
  }
  const upstreamParams = mapParamsToUpstream(operationName, params);
  // One signal for both cancellation sources: the downstream request and the max-total cap.
  // Aborting it makes the SDK send notifications/cancelled to the upstream immediately.
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(call?.signal?.reason);
  if (call?.signal?.aborted) controller.abort(call.signal.reason);
  call?.signal?.addEventListener("abort", forwardAbort, { once: true });
  let capReached = false;
  const capTimer = UPSTREAM_MAX_TOTAL_TIMEOUT_MS
    ? setTimeout(() => {
        capReached = true;
        controller.abort(new Error("Maximum total time exceeded."));
      }, UPSTREAM_MAX_TOTAL_TIMEOUT_MS)
    : undefined;
  let result: Awaited<ReturnType<Client["callTool"]>>;
  try {
    result = await upstream.callTool(
      { name: sourceTool, arguments: upstreamParams },
      undefined,
      {
        signal: controller.signal,
        timeout: UPSTREAM_TIMEOUT_MS,
        resetTimeoutOnProgress: true,
        // Always ask the upstream for progress so it can extend the deadline; forward it only
        // when the caller asked for progress on this request.
        onprogress: (progress) => {
          if (call?.progressToken !== undefined && call.sendProgress) {
            void call.sendProgress(progress).catch(() => undefined);
          }
        },
      },
    );
  } catch (error) {
    return {
      ...upstreamCallError(error, call, sourceTool, capReached),
${tenancy ? "      _meta: tenantMeta,\n" : ""}    };
  } finally {
    clearTimeout(capTimer);
    call?.signal?.removeEventListener("abort", forwardAbort);
  }

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
${tenancy ? "      _meta: tenantMeta,\n" : ""}    };
  }

  const shaped = shapeResult(operationName, {
    source_tool: sourceTool,
    content: result.content,
    structured_content: result.structuredContent ?? null,
    is_error: Boolean(result.isError),
  }, fullResult);
  return {
    success: true,
    data: shaped.data,
${tenancy ? "    _meta: { ...tenantMeta, ...shaped.meta },\n" : "    ...(shaped.meta ? { _meta: shaped.meta } : {}),\n"}  };
}

const server = new Server(
  { name: schema.name, version: schema.version },
  { capabilities: { tools: {} } },
);

// EXECUTE takes one operation per call; the other endpoints also accept a batch.
function endpointInputSchema(endpoint: EndpointKey): ListToolsResult["tools"][number]["inputSchema"] {
  const properties: Record<string, object> = {
    operation: { type: "string", description: "MCP-AQL operation name." },
    params: { type: "object", description: "Operation parameters." },
  };
  if (endpoint === "execute") {
    return { type: "object", properties, required: ["operation"] };
  }
  properties.operations = {
    type: "array",
    description: \`Batch: up to \${MAX_BATCH_OPERATIONS} { operation, params } entries run in order. Use instead of operation.\`,
    items: {
      type: "object",
      properties: { operation: { type: "string" }, params: { type: "object" } },
      required: ["operation"],
    },
  };
  return { type: "object", properties };
}

server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => ({
  tools: (Object.entries(schema.operations) as Array<[EndpointKey, OperationDefinition[] | undefined]>)
    .filter(([, operations]) => Array.isArray(operations) && operations.length > 0)
    .map(([endpoint, operations]) => ({
      name: TOOL_NAME_BY_ENDPOINT[endpoint.toUpperCase() as EndpointName],
      description: buildToolDescription(endpoint.toUpperCase() as EndpointName, operations ?? []),
      inputSchema: endpointInputSchema(endpoint),
      annotations: {
        // schema.operations keys are lowercase here because they come directly from the JSON schema document.
        readOnlyHint: endpoint === "read",
        destructiveHint: endpoint === "delete" || endpoint === "execute",
      },
    })),
}));

async function runOperation(toolName: string, operation: string, params: Record<string, unknown>, call: UpstreamCallContext) {
  if (operation === "introspect") {
    return buildIntrospection(params);
  }

  const item = TOOL_BY_OPERATION.get(operation);
  if (!item) {
    return { success: false, error: { code: "NOT_FOUND_OPERATION", message: \`Unknown operation: \${operation}\` } };
  }

  const expectedToolName = TOOL_NAME_BY_ENDPOINT[item.endpoint];
  if (toolName !== expectedToolName) {
    return {
      success: false,
      error: {
        code: "VALIDATION_WRONG_ENDPOINT",
        message: \`Operation '\${operation}' must be called via \${expectedToolName}.\`,
      },
    };
  }

  return proxyOperation(operation, params, call);
}

const MAX_BATCH_OPERATIONS = positiveIntegerEnv("MCPAQL_MAX_BATCH_OPERATIONS", "operations") ?? 25;

// An operation the host must approve on its own. The host's per-call prompt is the
// confirmation, so a batch must never carry one: the batch halts there (spec 7.5). Switching
// the active tenant is single-call too: if it failed inside a batch, the rest of the batch
// would run against the previous tenant.
function singleCallReason(operation: string): string | undefined {
  const definition = TOOL_BY_OPERATION.get(operation)?.definition;
  if (!definition) return undefined;
  if (definition.requires_confirmation) return "requires confirmation";
  if (definition.danger_level === "dangerous") return "is dangerous";
  if (definition.maps_to.startsWith("adapter:set_active_")) return "changes the active tenant for the operations after it";
  return undefined;
}

function pendingEntry(entry: unknown, index: number) {
  const record = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as OperationArguments : undefined;
  return {
    index,
    operation: typeof record?.operation === "string" ? record.operation : "",
    params: record ? resolveParams(record) : {},
  };
}

async function runBatch(toolName: string, entries: unknown[], call: UpstreamCallContext) {
  const endpoint = (Object.keys(TOOL_NAME_BY_ENDPOINT) as EndpointName[]).find((name) => TOOL_NAME_BY_ENDPOINT[name] === toolName);
  if (!endpoint || endpoint === "EXECUTE") {
    return {
      success: false,
      error: {
        code: "VALIDATION_BATCH_NOT_ALLOWED",
        message: endpoint === "EXECUTE"
          ? \`\${toolName} does not accept batches; call each EXECUTE operation on its own so each one is approved.\`
          : \`Unknown endpoint tool '\${toolName}'.\`,
      },
    };
  }
  if (entries.length === 0 || entries.length > MAX_BATCH_OPERATIONS) {
    return {
      success: false,
      error: {
        code: "VALIDATION_BATCH_SIZE",
        message: \`A batch needs 1 to \${MAX_BATCH_OPERATIONS} operations; got \${entries.length}.\`,
      },
    };
  }

  // Progress for a batch is reported per batch, so it only ever increases: operation i of n
  // spans [i, i+1), filled in by the upstream's own progress when it reports a total.
  const total = entries.length;
  let lastProgress = -1;
  const report = async (progress: number, message: string) => {
    if (!call.sendProgress || progress <= lastProgress) return;
    lastProgress = progress;
    await call.sendProgress({ progress, total, message }).catch(() => undefined);
  };
  const callFor = (index: number, operation: string): UpstreamCallContext => {
    // Without a total, each upstream notification still moves progress forward (approaching
    // index + 1), so hosts that extend deadlines on progress keep long operations alive.
    let notifications = 0;
    return {
      ...call,
      sendProgress: call.sendProgress
        ? async (progress) => {
            notifications += 1;
            const fraction = progress.total
              ? Math.min(progress.progress / progress.total, 0.99)
              : 0.99 * (1 - 1 / (1 + notifications));
            void report(index + fraction, \`\${operation}\${progress.message ? \`: \${progress.message}\` : ""}\`);
          }
        : undefined,
    };
  };

  const results: Array<{ index: number; operation: string; result: unknown }> = [];
  let succeeded = 0;
  for (const [index, entry] of entries.entries()) {
    if (call.signal?.aborted) break;
    const record = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as OperationArguments : undefined;
    const operation = typeof record?.operation === "string" ? record.operation : "";
    if (!record || !operation) {
      results.push({ index, operation, result: { success: false, error: { code: "VALIDATION_MISSING_OPERATION", message: "Batch entry needs an operation name." } } });
      continue;
    }
    const params = resolveParams(record);
    // Routing comes first: an operation from another endpoint is refused here and never runs.
    const item = TOOL_BY_OPERATION.get(operation);
    if (item && TOOL_NAME_BY_ENDPOINT[item.endpoint] !== toolName) {
      results.push({ index, operation, result: await runOperation(toolName, operation, params, call) });
      continue;
    }
    const reason = singleCallReason(operation);
    if (reason) {
      return {
        success: true,
        data: null,
        results,
        halted_at: {
          index,
          operation,
          result: {
            success: false,
            error: {
              code: "VALIDATION_SINGLE_CALL_REQUIRED",
              message: \`Operation '\${operation}' \${reason}, so it must be called on its own, not in a batch.\`,
            },
          },
        },
        pending_operations: entries.slice(index + 1).map((pending, offset) => pendingEntry(pending, index + 1 + offset)),
        summary: { total, succeeded, failed: results.length - succeeded, halted: 1, pending: total - index - 1 },
      };
    }
    void report(index, operation);
    const result = await runOperation(toolName, operation, params, callFor(index, operation)) as { success?: boolean };
    if (result.success) succeeded += 1;
    results.push({ index, operation, result });
  }
  // Awaited so the final progress event is sent before the response.
  await report(total, "batch complete");
  return {
    success: true,
    data: null,
    results,
    summary: { total, succeeded, failed: results.length - succeeded },
  };
}

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest, extra): Promise<CallToolResult> => {
  const toolName = request.params.name;
  const args = (request.params.arguments ?? {}) as OperationArguments;
  const progressToken = request.params._meta?.progressToken;
  const call: UpstreamCallContext = {
    signal: extra.signal,
    progressToken,
    sendProgress: progressToken === undefined
      ? undefined
      : (progress) => extra.sendNotification({ method: "notifications/progress", params: { ...progress, progressToken } }),
  };

  if (Array.isArray(args.operations)) {
    if (args.operation !== undefined) {
      return textResult({
        success: false,
        error: { code: "VALIDATION_AMBIGUOUS_REQUEST", message: "Send either operation or operations, not both." },
      });
    }
    return textResult(await runBatch(toolName, args.operations, call));
  }

  const operation = typeof args.operation === "string" ? args.operation : "";
  return textResult(await runOperation(toolName, operation, resolveParams(args), call));
});

const transport = new StdioServerTransport();
await server.connect(transport);

async function closeUpstreamTransport() {
${tenancy ? "  await closeTenantClients();\n" : ""}${stdio ? "  closingUpstream = true;\n  // A child still starting is not yet upstreamTransport; stop it too so it is never orphaned.\n  await startingTransport?.close();\n" : ""}  if (upstreamTransport) {
    await upstreamTransport.close();
    upstreamTransport = undefined;
    upstreamClient = undefined;
  }
}

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  void closeUpstreamTransport().finally(() => process.exit(0));
}

process.on("beforeExit", async () => {
  await closeUpstreamTransport();
});

// A host may end the session by closing the adapter's stdin without a signal. An open
// upstream connection keeps the event loop alive, so beforeExit alone would never fire.
server.onclose = shutdown;
process.stdin.on("end", shutdown);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, shutdown);
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
  /** npm metadata; when present the package is emitted publishable with a bin. */
  packageConfig?: AdapterPackageConfig;
}): AdapterPackageContents {
  let schema = options.schema;
  const packageConfig = options.packageConfig;
  if (packageConfig) {
    validatePackageConfig(packageConfig);
  }
  const provenance = options.provenance ?? { generated_at: options.generatedAt ?? new Date().toISOString() };
  if (schema.target.transport === "native-applescript" && !schema.target.application) {
    throw new Error("native-applescript adapter schema requires target.application");
  }

  const hasTemplates = options.templates !== undefined
    && Object.keys(options.templates.templates ?? {}).length > 0;
  if (hasTemplates) {
    // A template with the name of an excluded operation would re-add what the schema build left out.
    const excluded = new Set(
      ((provenance as { excluded_operations?: Array<{ operation_name?: unknown }> }).excluded_operations ?? [])
        .map((entry) => entry.operation_name)
        .filter((name): name is string => typeof name === "string"),
    );
    const reintroduced = Object.keys(options.templates!.templates ?? {}).filter((name) => excluded.has(name));
    if (reintroduced.length > 0) {
      throw new Error(`Templates cannot re-add excluded operations: ${reintroduced.join(", ")}.`);
    }
    validateTemplates(options.templates!, schema);
    schema = applyTemplatesToSchema(schema, options.templates!);
  }

  const baseServerSource = schema.target.transport === "native-applescript"
    ? buildNativeAppleScriptServerSource(schema, hasTemplates)
    : buildServerSource(schema);
  // A bin entry needs a shebang; tsc carries it through to dist/server.js.
  const serverSource = packageConfig ? `#!/usr/bin/env node\n${baseServerSource}` : baseServerSource;

  const dependencies: Record<string, string> = { "@modelcontextprotocol/sdk": "^1.27.1" };

  const publishFields = packageConfig
    ? {
        version: packageConfig.version ?? schema.version,
        description: packageConfig.description ?? schema.description,
        license: packageConfig.license,
        repository: packageConfig.repository
          ? { type: "git", url: packageConfig.repository.url, directory: packageConfig.repository.directory }
          : undefined,
        homepage: packageConfig.homepage,
        keywords: packageConfig.keywords,
        bin: { [binName(packageConfig)]: "dist/server.js" },
        files: ["dist", "README.md"],
        publishConfig: { access: "public" },
      }
    : { private: true };

  const packageJson = {
    name: packageName(schema, packageConfig),
    ...publishFields,
    type: "module",
    engines: {
      node: ">=20",
    },
    scripts: {
      build: "tsc -p tsconfig.json",
      start: "tsx src/server.ts",
      ...(packageConfig ? { prepublishOnly: "npm run build" } : {}),
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

  const installSection = packageConfig && schema.target.transport !== "native-applescript"
    ? buildInstallSection(schema, packageConfig)
    : "";

  return {
    packageName: packageName(schema, packageConfig),
    files: [
      ...files,
      { path: "package.json", content: jsonContent(packageJson) },
      { path: "tsconfig.json", content: jsonContent(tsconfig) },
      { path: "src/server.ts", content: serverSource },
      {
        path: "README.md",
        content: `# ${prettyToolName(schema.name)}\n\nGenerated MCP-AQL adapter package for ${adapterReadmeSubject(schema.description)}.\n\n## Supported Endpoints\n\n${buildEndpointDescriptions(schema)}\n\n${installSection}${buildRunningSection(schema)}`,
      },
    ],
  };
}
