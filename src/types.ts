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

export interface SchemaBuildOverrides {
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
    transport: "http" | "native-applescript";
    protocol: "custom";
    serialization: "json";
    /** The macOS application name (for native-applescript transport). */
    application?: string;
  };
  auth?: {
    type: "bearer";
    header: "Authorization";
    prefix: "Bearer ";
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

export interface TemplateOverride {
  language: "JavaScript" | "AppleScript";
  script: string;
  params?: Record<string, { type: string; optional?: boolean; description?: string }>;
  /** CRUDE endpoint — required for template-only operations not in the sdef-derived schema */
  endpoint?: "read" | "create" | "update" | "delete" | "execute";
  /** Human-readable description for introspection */
  description?: string;
  /** Danger level classification */
  danger_level?: "safe" | "reversible" | "destructive" | "dangerous";
}

export interface TemplateOverridesDocument {
  schema_version: string;
  application: string;
  templates: Record<string, TemplateOverride>;
}

export interface CurationDocument {
  schema_version: string;
  mode: "include" | "exclude";
  operations?: string[];
  exclude_patterns?: string[];
}
