import path from "node:path";

import {
  generateAdapterPackage as generateAdapterPackageContents,
  type AdapterSchemaDocument,
  type TemplateOverridesDocument,
} from "@mcpaql/adapter-generator-core";

import { readJsonFile, writeTextFile } from "./shared.js";

export async function generateAdapterPackage(options: {
  schemaPath: string;
  provenancePath?: string;
  templatesPath?: string;
  outDir: string;
}): Promise<void> {
  const schema = await readJsonFile<AdapterSchemaDocument>(options.schemaPath);
  const provenance = options.provenancePath
    ? await readJsonFile<Record<string, unknown>>(options.provenancePath)
    : undefined;
  const templates = options.templatesPath
    ? await readJsonFile<TemplateOverridesDocument>(options.templatesPath)
    : undefined;
  // Preserve supplied provenance verbatim; core only creates generated_at when it is absent.
  const adapterPackage = generateAdapterPackageContents({ schema, provenance, templates });

  for (const file of adapterPackage.files) {
    await writeTextFile(path.join(options.outDir, file.path), file.content);
  }
}
