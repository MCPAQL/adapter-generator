import path from "node:path";

import {
  generateAdapterPackage as generateAdapterPackageContents,
  type AdapterSchemaDocument,
} from "@mcpaql/adapter-generator-core";

import { readJsonFile, writeTextFile } from "./shared.js";

export async function generateAdapterPackage(options: {
  schemaPath: string;
  provenancePath?: string;
  outDir: string;
}): Promise<void> {
  const schema = await readJsonFile<AdapterSchemaDocument>(options.schemaPath);
  const provenance = options.provenancePath
    ? await readJsonFile<Record<string, unknown>>(options.provenancePath)
    : undefined;
  const adapterPackage = generateAdapterPackageContents({ schema, provenance });

  for (const file of adapterPackage.files) {
    await writeTextFile(path.join(options.outDir, file.path), file.content);
  }
}
