import {
  buildSchemaFromDiscoveryBundle,
  type DiscoveryBundle,
  type SchemaBuildOutput,
  type SchemaBuildOverrides,
} from "@mcpaql/adapter-generator-core";

import { readJsonFile, writeJsonFile } from "./shared.js";

export async function buildSchemaFromBundle(options: {
  bundlePath: string;
  overridesPath?: string;
}): Promise<SchemaBuildOutput> {
  const bundle = await readJsonFile<DiscoveryBundle>(options.bundlePath);
  const overrides = options.overridesPath
    ? await readJsonFile<SchemaBuildOverrides>(options.overridesPath)
    : undefined;

  return buildSchemaFromDiscoveryBundle({ bundle, overrides });
}

export async function persistSchemaBuild(output: SchemaBuildOutput, outDir: string): Promise<void> {
  await writeJsonFile(`${outDir}/adapter-schema.json`, output.schema);
  await writeJsonFile(`${outDir}/adapter-provenance.json`, output.metadata);
  await writeJsonFile(`${outDir}/schema-build-report.json`, {
    warnings: output.warnings,
    operations: output.metadata.operations,
  });
}
