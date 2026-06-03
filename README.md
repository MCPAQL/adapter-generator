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
