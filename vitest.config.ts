import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    include: ["tests/unit/**/*.test.{ts,tsx}", "tests/integration/**/*.test.{ts,tsx}"],
    setupFiles: ["./tests/setup.ts"],
    // codemirror-json-schema's ESM build uses extensionless relative imports, which Node's ESM loader cannot resolve; inlining makes vitest
    // bundle it (through Vite, which can) instead of handing it to Node.
    server: { deps: { inline: ["codemirror-json-schema"] } },
    coverage: {
      provider: "v8",
    },
  },
});
