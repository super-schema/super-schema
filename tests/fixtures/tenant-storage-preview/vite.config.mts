import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
const file = (path: string) => fileURLToPath(new URL(path, import.meta.url));
export default defineConfig({
  optimizeDeps: {
    entries: ["tests/fixtures/tenant-storage-preview/index.html"],
  },
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: "@/app/(dashboard)/admin/settings/storage/actions",
        replacement: file("./actions.ts"),
      },
      {
        find: "next/navigation",
        replacement: file("../gitops-preview/navigation.ts"),
      },
      { find: "next/link", replacement: file("../gitops-preview/link.tsx") },
      { find: "@", replacement: file("../../../src") },
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 4179,
    strictPort: true,
    watch: { ignored: ["**/.next/**"] },
  },
});
