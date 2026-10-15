import { readFile } from "node:fs/promises";
import path from "node:path";

/** D14: static assets for the preview iframe fallback; an allow-list, never a path from the request. */
const ASSETS: Record<string, { file: string; type: string }> = {
  "standalone.js": { file: "node_modules/@asyncapi/react-component/browser/standalone/index.js", type: "text/javascript; charset=utf-8" },
  "default.min.css": { file: "node_modules/@asyncapi/react-component/styles/default.min.css", type: "text/css; charset=utf-8" },
};

export async function GET(_request: Request, { params }: { params: Promise<{ asset: string }> }) {
  const { asset } = await params;
  if (!Object.hasOwn(ASSETS, asset)) return new Response("Not found", { status: 404 });
  const entry = ASSETS[asset];
  try {
    // turbopackIgnore: `entry.file` comes from the allow-list above and is shipped via
    // `outputFileTracingIncludes` (next.config.ts); without the marker Turbopack traces the whole project.
    const body = await readFile(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ process.cwd(), entry.file));
    return new Response(body, {
      headers: {
        "Content-Type": entry.type,
        "Cache-Control": "public, max-age=86400",
        // Static, public library files: never sniffed, and inert if someone navigates to them directly.
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch {
    return new Response("Preview asset unavailable", { status: 503 });
  }
}
