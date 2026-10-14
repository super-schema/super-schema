import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
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
