import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // `@typespec/compiler` loads its stdlib and library JS with a runtime `import(fileUrl)` (NodeHost.getJsImport).
  // When Turbopack bundles the package, that becomes "Cannot find module as expression is too dynamic", so every
  // in-process compile reported errors under `next dev` (the entity publish regeneration check rejected every
  // entity whose stored source was missing or stale; verified live in Playwright). A server-external package is a
  // plain Node import, which is what the compiler needs.
  serverExternalPackages: ["@typespec/compiler"],
  // D14: the AsyncAPI preview iframe reads these files at runtime (standalone output must ship them).
  // The key is a glob over the route path. Verified with a standalone build: under Turbopack the literal
  // dynamic-segment key "/api/asyncapi-preview/[asset]" matches nothing, so neither file ships.
  outputFileTracingIncludes: {
    "/api/asyncapi-preview/*": [
      "./node_modules/@asyncapi/react-component/browser/standalone/index.js",
      "./node_modules/@asyncapi/react-component/styles/default.min.css",
    ],
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
