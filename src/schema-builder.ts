import type {
  AdapterSchemaDocument,
  AdapterSchemaOperation,
  DiscoveryBundle,
  DiscoveryOperation,
  SchemaBuildOutput,
  SchemaBuildOverrides,
} from "./types.js";
import { readJsonFile, writeJsonFile } from "./shared.js";

const ENDPOINT_KEY_BY_CATEGORY = {
  CREATE: "create",
  READ: "read",
  UPDATE: "update",
  DELETE: "delete",
  EXECUTE: "execute",
} as const;

const VALID_ENDPOINTS = new Set(["CREATE", "READ", "UPDATE", "DELETE", "EXECUTE"]);
const VALID_DANGER_LEVELS = new Set(["safe", "reversible", "destructive", "dangerous", "forbidden"]);

function validateOverrides(overrides?: SchemaBuildOverrides): void {
  if (!overrides?.operations) {
    return;
  }

  for (const [key, value] of Object.entries(overrides.operations)) {
    if (value.endpoint && !VALID_ENDPOINTS.has(value.endpoint)) {
      throw new Error(`Invalid override endpoint '${value.endpoint}' for operation key '${key}'.`);
    }

    if (value.danger_level && !VALID_DANGER_LEVELS.has(value.danger_level)) {
      throw new Error(`Invalid override danger_level '${value.danger_level}' for operation key '${key}'.`);
    }
  }
}

function applyOverrides(
  operation: DiscoveryOperation,
  overrides?: SchemaBuildOverrides["operations"],
): DiscoveryOperation {
  // Prefer source_tool_name when both keys exist so pre-normalized bundles stay stable across rename overrides.
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

export async function buildSchemaFromBundle(options: {
  bundlePath: string;
  overridesPath?: string;
}): Promise<SchemaBuildOutput> {
  const bundle = await readJsonFile<DiscoveryBundle>(options.bundlePath);
  const overrides = options.overridesPath
    ? await readJsonFile<SchemaBuildOverrides>(options.overridesPath)
    : undefined;
  validateOverrides(overrides);

  const operations = bundle.normalized_bundle.operations.map((operation) => applyOverrides(operation, overrides?.operations));
  const adapterName = overrides?.adapter?.name ?? `${bundle.source.name}-adapter`;
  const tokenEnv = overrides?.adapter?.token_env ?? bundle.source.auth.token_env;

  const schema: AdapterSchemaDocument = {
    name: adapterName,
    type: "adapter",
    version: overrides?.adapter?.version ?? "0.1.0",
    description:
      overrides?.adapter?.description ??
      `Generated MCP-AQL adapter for ${bundle.source.server?.title ?? bundle.source.name}.`,
    target: {
      base_url: bundle.source.server_url.replace(/\/$/, ""),
      transport: "http",
      protocol: "custom",
      serialization: "json",
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

  const output: SchemaBuildOutput = {
    schema,
    metadata: {
      generated_at: new Date().toISOString(),
      source_server_name: bundle.source.server?.name,
      source_server_version: bundle.source.server?.version,
      source_capture_name: bundle.source.name,
      warning_count: bundle.normalized_bundle.warnings.length,
      operation_count: operations.length,
      operations: operations.map((operation) => ({
        source_tool_name: operation.source_tool_name,
        operation_name: operation.operation_name,
        endpoint: operation.endpoint,
        needs_review: operation.needs_review,
        review_reasons: operation.review_reasons,
      })),
    },
    warnings: bundle.normalized_bundle.warnings,
  };

  return output;
}

export async function persistSchemaBuild(output: SchemaBuildOutput, outDir: string): Promise<void> {
  await writeJsonFile(`${outDir}/adapter-schema.json`, output.schema);
  await writeJsonFile(`${outDir}/adapter-provenance.json`, output.metadata);
  await writeJsonFile(`${outDir}/schema-build-report.json`, {
    warnings: output.warnings,
    operations: output.metadata.operations,
  });
}
