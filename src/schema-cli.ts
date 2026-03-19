import { parseArgs } from "./shared.js";
import { buildSchemaFromBundle, persistSchemaBuild } from "./schema-builder.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const input = args.input;
  const outDir = args.out;

  if (!input || !outDir) {
    throw new Error("Usage: mcpaql-schema-build --input <discovery-bundle.json> --out <directory> [--overrides <overrides.json>]");
  }

  const output = await buildSchemaFromBundle({
    bundlePath: input,
    overridesPath: args.overrides,
  });
  await persistSchemaBuild(output, outDir);

  console.log(
    JSON.stringify(
      {
        out_dir: outDir,
        operation_count: output.metadata.operation_count,
        warning_count: output.metadata.warning_count,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
