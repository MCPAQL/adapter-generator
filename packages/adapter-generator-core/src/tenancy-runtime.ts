/**
 * Emitted into generated HTTP adapters whose schema declares `tenancy`. Gives the model
 * a live view of tenants (projects, workspaces) instead of a tenant pinned in config:
 *
 * - get_active_<noun> (READ): the active tenant, how it was chosen, and every tenant
 *   the credential can reach.
 * - set_active_<noun> (UPDATE): switch the active tenant for this adapter session.
 * - <noun>_id on every scoped operation: run one call against another tenant.
 * - Every scoped result reports the tenant it ran against in _meta.
 *
 * One upstream connection is kept per tenant, because the upstream reads the tenant
 * from a connection-level header. The code below is emitted verbatim: it must not use
 * backticks, template placeholders, or backslashes.
 */
export const TENANCY_RUNTIME = `
// ---- Tenancy (generated from schema.tenancy) ----
type TenancyConfig = {
  header: string;
  noun: string;
  list_operation: string;
  list_path?: string;
  id_field: string;
  name_field: string;
  default_field?: string;
  default_env?: string;
  unscoped_operations?: string[];
};
type Tenant = { id: string; name: string | null; is_default: boolean };
type TenantRef = { id: string; name: string | null; source: "env" | "default" | "only" | "selected" | "call" };

class TenancyError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

const TENANCY = (rawSchema as unknown as { tenancy: TenancyConfig }).tenancy;
const TENANT_PARAM = TENANCY.noun + "_id";
const GET_ACTIVE_TENANT = "get_active_" + TENANCY.noun;
const SET_ACTIVE_TENANT = "set_active_" + TENANCY.noun;
const UNSCOPED_OPERATIONS = new Set([TENANCY.list_operation, ...(TENANCY.unscoped_operations ?? [])]);
// Scoped operations that received the generated per-call tenant parameter.
const TENANT_PARAM_OPERATIONS = new Set<string>();

for (const operations of Object.values(schema.operations)) {
  for (const operation of operations ?? []) {
    if (UNSCOPED_OPERATIONS.has(operation.name) || operation.params?.[TENANT_PARAM]) continue;
    operation.params = {
      ...(operation.params ?? {}),
      [TENANT_PARAM]: {
        type: "string",
        required: false,
        description: "Run this call against another " + TENANCY.noun + " (id or exact name) instead of the active one.",
      },
    };
    TENANT_PARAM_OPERATIONS.add(operation.name);
  }
}

schema.operations.read = [
  ...(schema.operations.read ?? []),
  {
    name: GET_ACTIVE_TENANT,
    maps_to: "adapter:" + GET_ACTIVE_TENANT,
    description: "Show the active " + TENANCY.noun + ", how it was chosen, and every " + TENANCY.noun + " this credential can reach.",
    danger_level: "safe",
  },
];
schema.operations.update = [
  ...(schema.operations.update ?? []),
  {
    name: SET_ACTIVE_TENANT,
    maps_to: "adapter:" + SET_ACTIVE_TENANT,
    description: "Switch the active " + TENANCY.noun + " for the rest of this session. Pass " + TENANT_PARAM + " or name.",
    params: {
      [TENANT_PARAM]: { type: "string", required: false, description: "Id of the " + TENANCY.noun + " to make active." },
      name: { type: "string", required: false, description: "Exact name (case-insensitive) of the " + TENANCY.noun + " to make active." },
    },
    danger_level: "reversible",
  },
];

const tenantClients = new Map<string, { client: Client; transport: StreamableHTTPClientTransport }>();
let tenantCache: Tenant[] | undefined;
let activeTenant: TenantRef | undefined;

async function getTenantClient(tenantId: string | undefined): Promise<Client> {
  const key = tenantId ?? "";
  const existing = tenantClients.get(key);
  if (existing) return existing.client;

  const headers = buildUpstreamHeaders();
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === TENANCY.header.toLowerCase()) delete headers[name];
  }
  if (tenantId) headers[TENANCY.header] = tenantId;

  const transport = new StreamableHTTPClientTransport(new URL(resolveBaseUrl()), {
    requestInit: { headers },
  });
  const client = new Client({ name: schema.name, version: schema.version });
  await client.connect(transport);
  tenantClients.set(key, { client, transport });
  return client;
}

async function closeTenantClients(): Promise<void> {
  const entries = [...tenantClients.values()];
  tenantClients.clear();
  await Promise.allSettled(entries.map((entry) => entry.transport.close()));
}

async function listTenants(refresh = false): Promise<Tenant[]> {
  if (tenantCache && !refresh) return tenantCache;
  const listOperation = (schema.operations.read ?? []).find((operation) => operation.name === TENANCY.list_operation);
  if (!listOperation) throw new TenancyError("TENANCY_MISCONFIGURED", "List operation " + TENANCY.list_operation + " is missing.");

  const client = await getTenantClient(undefined);
  const result = await client.callTool({ name: listOperation.maps_to.replace(/^tool:/, ""), arguments: {} });
  if (result.isError) {
    throw new TenancyError("UPSTREAM_TOOL_ERROR", "Could not list " + TENANCY.noun + "s.", { content: result.content });
  }
  const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
  const raw = structured[TENANCY.list_path ?? "data"];
  // An account with no tenants may return null for the list.
  const items = raw === null || raw === undefined ? [] : raw;
  if (!Array.isArray(items)) {
    throw new TenancyError("TENANCY_MISCONFIGURED", "List result has no array at '" + (TENANCY.list_path ?? "data") + "'.");
  }
  tenantCache = items
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .filter((item) => typeof item[TENANCY.id_field] === "string")
    .map((item) => ({
      id: item[TENANCY.id_field] as string,
      name: typeof item[TENANCY.name_field] === "string" ? (item[TENANCY.name_field] as string) : null,
      is_default: TENANCY.default_field ? item[TENANCY.default_field] === true : false,
    }));
  return tenantCache;
}

async function findTenant(value: string): Promise<Tenant> {
  const match = (tenants: Tenant[]) =>
    tenants.find((tenant) => tenant.id === value)
    ?? tenants.find((tenant) => tenant.name !== null && tenant.name.toLowerCase() === value.toLowerCase());
  const found = match(await listTenants()) ?? match(await listTenants(true));
  if (!found) {
    throw new TenancyError("NOT_FOUND_" + TENANCY.noun.toUpperCase(), "No " + TENANCY.noun + " matches '" + value + "'.", {
      available: (tenantCache ?? []).map((tenant) => ({ id: tenant.id, name: tenant.name })),
    });
  }
  return found;
}

async function getActiveTenant(): Promise<TenantRef> {
  if (activeTenant) return activeTenant;
  const fromEnv = TENANCY.default_env ? process.env[TENANCY.default_env]?.trim() : undefined;
  if (fromEnv) {
    const tenant = await findTenant(fromEnv);
    activeTenant = { id: tenant.id, name: tenant.name, source: "env" };
    return activeTenant;
  }
  const tenants = await listTenants();
  const fallback = tenants.find((tenant) => tenant.is_default) ?? (tenants.length === 1 ? tenants[0] : undefined);
  if (!fallback) {
    throw new TenancyError("NO_ACTIVE_" + TENANCY.noun.toUpperCase(), "No active " + TENANCY.noun + ". Call " + SET_ACTIVE_TENANT + " first.", {
      available: tenants.map((tenant) => ({ id: tenant.id, name: tenant.name })),
    });
  }
  activeTenant = { id: fallback.id, name: fallback.name, source: fallback.is_default ? "default" : "only" };
  return activeTenant;
}

// Picks the tenant for one proxied call and strips the generated tenant parameter.
async function resolveCallTenant(operationName: string, params: Record<string, unknown>): Promise<TenantRef | undefined> {
  if (UNSCOPED_OPERATIONS.has(operationName)) return undefined;
  // Operations that declare their own <noun>_id keep it untouched and run against the active tenant.
  if (!TENANT_PARAM_OPERATIONS.has(operationName)) return getActiveTenant();
  const selector = params[TENANT_PARAM];
  delete params[TENANT_PARAM];
  if (selector === undefined || selector === null || selector === "") return getActiveTenant();
  if (typeof selector !== "string") {
    throw new TenancyError("VALIDATION_INVALID_PARAM_TYPE", TENANT_PARAM + " must be a " + TENANCY.noun + " id or name (string).");
  }
  const tenant = await findTenant(selector);
  return { id: tenant.id, name: tenant.name, source: "call" };
}

async function handleTenancyOperation(operationName: string, params: Record<string, unknown>) {
  if (operationName === GET_ACTIVE_TENANT) {
    const active = await getActiveTenant();
    const tenants = await listTenants(true);
    return {
      success: true,
      data: {
        active: active,
        available: tenants.map((tenant) => ({ ...tenant, active: tenant.id === active.id })),
      },
    };
  }
  const value = typeof params[TENANT_PARAM] === "string" ? params[TENANT_PARAM] : typeof params.name === "string" ? params.name : undefined;
  if (!value) {
    throw new TenancyError("VALIDATION_MISSING_PARAM", "Pass " + TENANT_PARAM + " or name.");
  }
  const previous = activeTenant ?? null;
  const tenant = await findTenant(value as string);
  activeTenant = { id: tenant.id, name: tenant.name, source: "selected" };
  return { success: true, data: { active: activeTenant, previous } };
}

function tenancyErrorResult(error: unknown) {
  if (error instanceof TenancyError) {
    return { success: false, error: { code: error.code, message: error.message, details: error.details } };
  }
  throw error;
}
// ---- End tenancy ----
`;
