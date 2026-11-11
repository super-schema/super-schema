import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
const file = (path: string) => fileURLToPath(new URL(path, import.meta.url));
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: "@/app/(dashboard)/gitops/actions",
        replacement: file("./actions.ts"),
      },
      { find: "next/navigation", replacement: file("./navigation.ts") },
      { find: "next/link", replacement: file("./link.tsx") },
      { find: "@", replacement: file("../../../src") },
    ],
  },
  server: { host: "127.0.0.1", port: 4178, strictPort: true },
});
