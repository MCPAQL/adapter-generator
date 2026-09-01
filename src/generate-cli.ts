import { parseArgs } from "./shared.js";
import { generateAdapterPackage } from "./generator.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const input = args.input;
  const outDir = args.out;

  if (!input || !outDir) {
    throw new Error(
      "Usage: mcpaql-generate-adapter --input <adapter-schema.json> --out <package-directory> [--provenance <adapter-provenance.json>] [--templates <templates.json>]",
    );
  }

  await generateAdapterPackage({
    schemaPath: input,
    provenancePath: args.provenance,
    templatesPath: args.templates,
    outDir,
  });

  console.log(JSON.stringify({ out_dir: outDir }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
