// scripts/build-parser-worker.mjs
// Bundles the AsyncAPI parser worker (`src/lib/event-specs/validation/parser-worker.ts`) into ONE self-contained CommonJS file,
// `worker-dist/asyncapi-parser-worker.cjs`, which `parser-runner.ts` starts as a child process.
//
//   node scripts/build-parser-worker.mjs        (npm run build:parser-worker; runs before `dev` and `build`; vitest builds it in its global setup)
//
// Everything the worker needs is inlined (the parser, its schema parsers, `yaml`, our own pure code): the file has no `require` of a package,
// so it runs from any directory with only `node`, which is what the standalone output (`.next/standalone`, no `node_modules`) needs.
import { build } from "esbuild";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const WORKER_ENTRY = path.join(root, "src/lib/event-specs/validation/parser-worker.ts");
export const WORKER_OUTFILE = path.join(root, "worker-dist/asyncapi-parser-worker.cjs");

/** Builds the worker; resolves with the path of the file. Throws (esbuild's error) when the bundle cannot be made. */
export async function buildParserWorker() {
  mkdirSync(path.dirname(WORKER_OUTFILE), { recursive: true });
  // The directory holds build output only: ignore it from inside (the repository's own .gitignore stays untouched).
  const ignore = path.join(path.dirname(WORKER_OUTFILE), ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n!.gitignore\n");
  const result = await build({
    entryPoints: [WORKER_ENTRY],
    outfile: WORKER_OUTFILE,
    write: false,
    absWorkingDir: root,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    // `module` first: a package's ESM build bundles cleanly; its UMD `main` (jsonc-parser) loads its parts with `require` calls esbuild cannot follow.
    mainFields: ["module", "main"],
    // `server-only` is a marker package of Next that throws outside its bundler; the pure code the worker shares with the server may import it.
    alias: { "server-only": path.join(root, "scripts/stubs/server-only.cjs") },
    // Bundled code is no longer "from node_modules", so Node prints its punycode deprecation (DEP0040) at every start of the worker: nobody reads it there.
    banner: { js: "process.noDeprecation = true;" },
    legalComments: "none",
    logLevel: "warning",
  });
  // Written to a temporary name and renamed: a server that starts a worker while this runs (vitest and `next dev` side by side) never sees half a file.
  const temporary = `${WORKER_OUTFILE}.${process.pid}.tmp`;
  writeFileSync(temporary, result.outputFiles[0].contents);
  renameSync(temporary, WORKER_OUTFILE);
  return WORKER_OUTFILE;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildParserWorker().then(
    (file) => console.log(`built ${path.relative(root, file)}`),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
