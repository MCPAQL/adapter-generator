# MCP-AQL Adapter Generator

CLI and reusable generation logic for MCP-AQL adapter packages.

## Packages

- `@mcpaql/adapter-generator` provides the Node.js CLI commands:
  - `mcpaql-schema-build --input <discovery-bundle.json> --out <directory> [--overrides <overrides.json>]`
  - `mcpaql-generate-adapter --input <adapter-schema.json> --out <package-directory> [--provenance <adapter-provenance.json>]`
- `@mcpaql/adapter-generator-core` provides the browser/Worker-safe core logic used by the CLI.

## Core API

Worker consumers should import the core package directly:

```ts
import {
  buildSchemaFromDiscoveryBundle,
  generateAdapterPackage,
} from "@mcpaql/adapter-generator-core";
```

`buildSchemaFromDiscoveryBundle({ bundle, overrides, generatedAt })` accepts an in-memory discovery bundle and optional overrides, then returns the same `SchemaBuildOutput` shape written by the CLI.

`generateAdapterPackage({ schema, provenance, generatedAt })` accepts an in-memory adapter schema and optional provenance object, then returns:

```ts
{
  packageName: string;
  files: Array<{ path: string; content: string }>;
}
```

The core package does not import Node-only APIs such as `fs`, `path`, or `child_process`. The root CLI package is responsible for reading inputs from disk and writing returned file payloads to the output directory.

## Tenant-scoped upstreams

Some MCP servers pick the tenant (project, workspace, team) from a request header that is fixed when the server is configured. The model cannot see which tenant it is in or change it. Declare `tenancy` in the overrides file and the generated adapter handles tenants at runtime instead:

```json
{
  "tenancy": {
    "header": "X-Project-Id",
    "noun": "project",
    "list_operation": "list_projects",
    "list_path": "data",
    "id_field": "project_id",
    "name_field": "name",
    "default_field": "default",
    "default_env": "CHIEF_PROJECT",
    "unscoped_operations": ["create_project", "update_project", "list_project_members", "create_project_invitation", "delete_project_invitation"]
  }
}
```

The generated adapter then:

- adds `get_active_<noun>` (READ), which returns the active tenant, how it was chosen, and every tenant the credential can reach
- adds `set_active_<noun>` (UPDATE), which switches the active tenant for the session by id or case-insensitive name
- adds an optional `<noun>_id` parameter (id or name) to every scoped operation, for one call against another tenant
- reports the tenant each scoped call ran against in `_meta.<noun>`
- sends `list_operation` and `unscoped_operations` without the tenant header
- picks the starting tenant from `default_env` if set, otherwise the tenant flagged by `default_field`, otherwise the only tenant
- drops any captured static tenant header and keeps one upstream connection per tenant

Schema build fails if the upstream is not HTTP, `list_operation` is not a READ operation or has required parameters, an operation that declares `<noun>_id` is not listed as unscoped, an unscoped operation is unknown, `noun` is not lowercase snake_case, or a generated operation name collides with an existing one. See `examples/generated/chief-mcp-projects` for a worked example.

## Publishable packages

Generated adapters are private workspace packages by default. Pass `--package <package-config.json>` to `generate-cli` (or `packageConfig` to `generateAdapterPackage`) to emit one that can be published to npm and run with `npx`:

```json
{
  "name": "@mcpaql/chief-mcp",
  "version": "0.1.0",
  "license": "AGPL-3.0-only",
  "repository": { "url": "git+https://github.com/MCPAQL/examples.git", "directory": "generated/chief-mcp/adapter" }
}
```

The package then gets a `bin` entry (named after the unscoped package name unless `bin` is set), `files: ["dist", "README.md"]`, public `publishConfig`, a `prepublishOnly` build, and a shebang on `src/server.ts`. `version` defaults to the schema version. The generated README gains an Install section with the MCP client config and a `claude mcp add` line, listing the env vars the adapter reads.
