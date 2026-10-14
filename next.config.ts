import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {
    root: __dirname,
  },
  experimental: {
    // Reuse a dynamic page's RSC payload for 30s on back/forth navigation
    // instead of a fresh server round trip each time (Next 16 default is 0).
    // Server actions that mutate data call revalidatePath/router.refresh, which
    // evict the client router cache, so edits are never shown stale.
    staleTimes: { dynamic: 30 },
  },
};

export default nextConfig;
