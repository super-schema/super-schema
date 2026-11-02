import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // `@typespec/compiler` loads its stdlib and library JS with a runtime `import(fileUrl)` (NodeHost.getJsImport).
  // When Turbopack bundles the package, that becomes "Cannot find module as expression is too dynamic", so every
  // in-process compile reported errors under `next dev` (the entity publish regeneration check rejected every
  // entity whose stored source was missing or stale; verified live in Playwright). A server-external package is a
  // plain Node import, which is what the compiler needs.
  // `@electric-sql/pglite` reads its WASM with `fs.readFile(new URL("./pglite.wasm", import.meta.url))`. Bundled by Turbopack, that URL is
  // Turbopack's own object and `fs` refuses it ("Received an instance of URL"), so a production build on DB_PROVIDER=pglite (the default)
  // could not open its database. External, it is a plain Node import whose `import.meta.url` is the file in node_modules.
  serverExternalPackages: ["@typespec/compiler", "@electric-sql/pglite"],
  // D14: the AsyncAPI preview iframe reads these files at runtime (standalone output must ship them).
  // The key is a glob over the route path. Verified with a standalone build: under Turbopack the literal
  // dynamic-segment key "/api/asyncapi-preview/[asset]" matches nothing, so neither file ships.
  //
  // The AsyncAPI parser worker: `src/lib/event-specs/validation/parser-runner.ts` starts `worker-dist/asyncapi-parser-worker.cjs` as a child
  // process (`child_process.fork`), a path no tracer can see through. It is ONE self-contained file (esbuild inlines the parser and
  // everything it needs: `scripts/build-parser-worker.mjs`, run by `npm run build:parser-worker`, which `prebuild` runs), so it is all the
  // standalone output needs: no package of `node_modules` has to be shipped for it. Every route may reach the parser (an event page
  // validates, publishes, imports), so the key is a glob over ALL routes (a literal route key would match nothing under Turbopack, see
  // above; `/**` ships the file with `next build --webpack` and with the default Turbopack build, both checked).
  // `scripts/verify-parser-worker.mjs` runs the worker from a copy of `.next/standalone` that has no `node_modules`.
  outputFileTracingIncludes: {
    "/api/asyncapi-preview/*": [
      "./node_modules/@asyncapi/react-component/browser/standalone/index.js",
      "./node_modules/@asyncapi/react-component/styles/default.min.css",
    ],
    "/**": ["./worker-dist/asyncapi-parser-worker.cjs"],
  },
  turbopack: {
    root: __dirname,
  },
  experimental: {
    // Reuse a dynamic page's RSC payload for 30s on ANY client navigation to a
    // page visited in that window (sidebar clicks and links as well as
    // back/forward) instead of a fresh server round trip (Next 16 default is 0).
    // RULE: the client router cache is only evicted by a server action that
    // calls revalidatePath/revalidateTag (or by router.refresh). Any server
    // action that mutates data a cached page renders MUST revalidate after
    // success, otherwise that page can show stale data for up to 30s.
    // tests/unit/app/revalidate-after-mutation.test.ts pins this for the admin,
    // governance and type-mapping actions.
    staleTimes: { dynamic: 30 },
  },
};

export default nextConfig;
