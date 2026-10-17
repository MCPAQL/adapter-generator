export type EndpointCategory = "CREATE" | "READ" | "UPDATE" | "DELETE" | "EXECUTE";

export type DangerLevel = "safe" | "reversible" | "destructive" | "dangerous" | "forbidden";

export interface DiscoveryParam {
  name: string;
  original_name: string;
  type: string;
  required: boolean;
  description?: string;
  default?: unknown;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  pattern?: string;
  format?: string;
  source_path: string;
}

export interface DiscoveryOperation {
  source_tool_name: string;
  operation_name: string;
  description: string;
  endpoint: EndpointCategory;
  endpoint_confidence: "high" | "medium" | "low";
  danger_level: DangerLevel;
  needs_review: boolean;
  review_reasons: string[];
  params: DiscoveryParam[];
  maps_to: string;
  title?: string;
}

export interface DiscoveryBundle {
  schema_version: "1.0.0-draft";
  source: {
    name: string;
    server_url: string;
    server?: {
      name?: string;
      version?: string;
      title?: string;
    };
    auth: {
      type: "bearer" | "none";
      token_env?: string;
    };
    /**
     * The redacted capture config used by mcpaql-interrogate. Contains transport,
     * application (for native transports), headers, etc. Schemas of inner fields
     * vary by transport, so this is a free-form record.
     */
    capture_config_redacted?: Record<string, unknown>;
  };
  normalized_bundle: {
    operations: DiscoveryOperation[];
    warnings: Array<{
      code: string;
      severity: "info" | "warning" | "error";
      message: string;
      tool?: string;
      field?: string;
      heuristic?: string;
    }>;
  };
}

/**
 * Declares that the upstream scopes calls to a tenant (project, workspace, team) chosen
 * by a request header. The generated adapter then lets the model list tenants, see and
 * switch the active one, and target a tenant per call, instead of pinning one in config.
 */
export interface AdapterTenancy {
  /** Upstream header that selects the tenant, e.g. "X-Project-Id". */
  header: string;
  /** Singular noun for generated names: "project" -> get_active_project, set_active_project, project_id. */
  noun: string;
  /** READ operation that lists the tenants the credential can reach. Called without the tenant header. */
  list_operation: string;
  /** Key of the array in the list operation's structured result. Defaults to "data". */
  list_path?: string;
  /** Field holding each tenant's id. */
  id_field: string;
  /** Field holding each tenant's display name. */
  name_field: string;
  /** Optional boolean field marking the account's default tenant. */
  default_field?: string;
  /** Optional env var naming the starting tenant (id or name). */
  default_env?: string;
  /** Operations that act account-wide or take the tenant as their own parameter; sent without the header. */
  unscoped_operations?: string[];
}

/**
 * npm package metadata for a generated adapter. When supplied, the package is
 * emitted publishable (not private) with a runnable bin, instead of the default
 * private workspace package.
 */
export interface AdapterPackageConfig {
  /** Scoped or unscoped npm package name, e.g. "@mcpaql/chief-mcp". */
  name: string;
  /** Defaults to the schema version. */
  version?: string;
  description?: string;
  /** Command name for the bin entry; defaults to the unscoped package name. */
  bin?: string;
  license?: string;
  repository?: { url: string; directory?: string };
  homepage?: string;
  keywords?: string[];
}

/**
 * How a generated adapter launches a local stdio upstream. The adapter spawns the
 * command lazily on the first call and keeps the child for the life of the adapter,
 * so upstream sessions persist across calls.
 */
export interface AdapterStdioTarget {
  /** Executable to spawn, e.g. "npx". Pin package versions in args, never `@latest`. */
  command: string;
  args?: string[];
  cwd?: string;
  /**
   * Names of adapter environment variables copied into the child. The child otherwise
   * receives only the SDK's minimal default environment, never the full parent environment.
   */
  env_passthrough?: string[];
  /** Fixed child environment values; a value of the exact form "${env:VAR}" is read from the adapter's environment. */
  env?: Record<string, string>;
}

/**
 * Opt-in shaping of successful upstream results, applied by the generated adapter. With no
 * result_shaping, results pass through unchanged.
 */
export interface AdapterResultShaping {
  /**
   * Over this many characters (serialized result data), operations with a handle rule return a
   * summary and a continuation instead of the full result. 0 disables; the adapter's
   * MCPAQL_RESULT_BUDGET_CHARS overrides it.
   */
  max_result_chars?: number;
  /** Drop text content blocks when the upstream also returned structuredContent (the same data twice). */
  drop_duplicate_text?: boolean;
  handles?: AdapterResultHandle[];
}

/** How to replace an oversized result with a retained-result handle the model can page. */
export interface AdapterResultHandle {
  /** Operations whose results the upstream retains and can serve again through `continuation`. */
  operations: string[];
  /** Dotted path of the handle id inside structuredContent, e.g. "evidence_id". */
  id_path: string;
  /** Dotted structuredContent paths always kept in the summary (identity, coverage, limitations, ...). */
  keep_paths: string[];
  /** Ready-to-call follow-up; every string exactly "${handle}" is replaced with the id. */
  continuation: { operation: string; params: Record<string, unknown> };
}

export interface SchemaBuildOverrides {
  tenancy?: AdapterTenancy;
  /** Copied into the adapter schema after validation against the final operation set. */
  result_shaping?: AdapterResultShaping;
  /**
   * Endpoints whose operations are left out of the adapter entirely (after per-operation
   * endpoint overrides apply), e.g. ["EXECUTE"] to ship a staged adapter with no runtime
   * operations. Excluded operations are recorded in metadata.excluded_operations.
   */
  exclude_endpoints?: EndpointCategory[];
  /** Replaces or completes the captured stdio launch config, e.g. to pin an exact upstream version. */
  stdio?: Partial<AdapterStdioTarget>;
  adapter?: {
    name?: string;
    version?: string;
    description?: string;
    token_env?: string;
  };
  // Operation override keys may use either the original source_tool_name or the normalized operation_name.
  operations?: Record<
    string,
    {
      operation_name?: string;
      endpoint?: EndpointCategory;
      danger_level?: Exclude<DangerLevel, "forbidden">;
      description?: string;
      needs_review?: boolean;
      review_reason?: string;
      /** Leave this operation out of the adapter; it is not listed, introspectable or callable. */
      exclude?: boolean;
      /** Recorded with the exclusion in metadata.excluded_operations. */
      exclude_reason?: string;
    }
  >;
}

export interface AdapterSchemaOperation {
  name: string;
  maps_to: string;
  description: string;
  params?: Record<
    string,
    {
      type: string;
      required?: boolean;
      description?: string;
      default?: unknown;
      enum?: string[];
      minimum?: number;
      maximum?: number;
      pattern?: string;
      format?: string;
    }
  >;
  response?: {
    type: "object";
    description: string;
  };
  danger_level?: DangerLevel;
  requires_confirmation?: boolean;
  non_idempotent?: boolean;
}

export interface AdapterSchemaDocument {
  name: string;
  type: "adapter";
  version: string;
  description: string;
  target: {
    base_url: string;
    transport: "http" | "native-applescript" | "stdio";
    protocol: "custom";
    serialization: "json";
    /** The macOS application name (for native-applescript transport). */
    application?: string;
    /** Child process launch config (for stdio transport). */
    stdio?: AdapterStdioTarget;
  };
  auth?: {
    type: "bearer";
    header: string;
    prefix: string;
    token_env?: string;
  };
  /**
   * Extra HTTP headers captured at discovery time (e.g., toolset selectors, region
   * selectors, tenant selectors). The generated adapter forwards these to upstream
   * on every request so it can reach the same tool surface the discovery saw.
   *
   * Populated from `bundle.source.capture_config_redacted.headers` by the schema
   * builder; secrets are excluded by the redaction performed during interrogation.
   */
  headers?: Record<string, string>;
  /** Present when the upstream is tenant-scoped; see AdapterTenancy. */
  tenancy?: AdapterTenancy;
  /** Opt-in result shaping; see AdapterResultShaping. */
  result_shaping?: AdapterResultShaping;
  operations: {
    create?: AdapterSchemaOperation[];
    read: AdapterSchemaOperation[];
    update?: AdapterSchemaOperation[];
    delete?: AdapterSchemaOperation[];
    execute?: AdapterSchemaOperation[];
  };
}

export interface SchemaBuildOutput {
  schema: AdapterSchemaDocument;
  metadata: {
    generated_at: string;
    source_server_name?: string;
    source_server_version?: string;
    source_capture_name: string;
    warning_count: number;
    operation_count: number;
    /** Operations in the bundle that overrides left out of the adapter. */
    excluded_operations?: Array<{
      source_tool_name: string;
      operation_name: string;
      endpoint: EndpointCategory;
      reason: string;
    }>;
    operations: Array<{
      source_tool_name: string;
      operation_name: string;
      endpoint: EndpointCategory;
      needs_review: boolean;
      review_reasons: string[];
      param_mappings?: Record<string, string>;
    }>;
  };
  warnings: DiscoveryBundle["normalized_bundle"]["warnings"];
}

/**
 * A parameter declaration for a native script template.
 */
export interface TemplateParamDef {
  type: "text" | "integer" | "boolean" | "real";
  /** May be omitted by callers without error (the script must cope). */
  optional?: boolean;
  /**
   * Value used when the caller omits the parameter. A defaulted parameter
   * is never treated as missing; the default is sanitized exactly like a
   * supplied value.
   */
  default?: unknown;
  description?: string;
}

/**
 * A hand-authored script template that replaces (or adds to) the
 * maps_to-derived behavior of a native-applescript adapter operation.
 */
export interface TemplateOverride {
  language: "JavaScript" | "AppleScript";
  /** Script body with {{param_name}} placeholders. */
  script: string;
  params?: Record<string, TemplateParamDef>;
  /** CRUDE endpoint — required for template-only operations not present in the schema. */
  endpoint?: EndpointCategory;
  description?: string;
}

export interface TemplateOverridesDocument {
  schema_version: "1.0.0-draft";
  templates: Record<string, TemplateOverride>;
}
