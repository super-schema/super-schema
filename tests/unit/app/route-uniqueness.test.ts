/**
 * Build-health guard: no two App Router entry files may resolve to the same URL.
 *
 * Route groups — `(dashboard)`, `(auth)` — do not appear in the URL, so
 * `src/app/page.tsx` and `src/app/(dashboard)/page.tsx` BOTH serve `/`. Next
 * does not reject that in `next build`; the two entries end up with
 * inconsistent client-reference manifests and the webpack build fails while
 * prerendering `/`:
 *
 *   Error [InvariantError]: Invariant: The client reference manifest for
 *   route "/" does not exist. This is a bug in Next.js.
 *
 * (Turbopack tolerates it silently; `next build --webpack` does not.) Keeping
 * routes unique makes both bundlers agree. Parallel-route slots (`@slot`) and
 * intercepting routes (`(.)x`, `(..)x`, `(...)x`) intentionally share URLs with
 * another entry and are excluded.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const APP_DIR = path.resolve(__dirname, "../../../src/app");
const ENTRY_FILE = /^(page|route)\.(tsx|ts|jsx|js|mdx)$/;

/** Route-group segment like `(dashboard)`, but not an intercepting `(.)` / `(..)` / `(...)`. */
const isRouteGroup = (segment: string) =>
  /^\([^)]+\)$/.test(segment) && !/^\(\.{1,3}\)/.test(segment);

const isNonUrlDefining = (segment: string) =>
  segment.startsWith("@") || /^\(\.{1,3}\)/.test(segment);

function collectEntries(dir: string, segments: string[] = []) {
  const entries: { kind: string; route: string; file: string }[] = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (dirent.isDirectory()) {
      if (dirent.name.startsWith("_")) continue; // private folders are not routable
      entries.push(
        ...collectEntries(path.join(dir, dirent.name), [
          ...segments,
          dirent.name,
        ]),
      );
    } else if (ENTRY_FILE.test(dirent.name)) {
      if (segments.some(isNonUrlDefining)) continue;
      const url =
        "/" + segments.filter((s) => !isRouteGroup(s)).join("/");
      entries.push({
        kind: dirent.name.startsWith("page") ? "page" : "route",
        route: url,
        file: path.relative(APP_DIR, path.join(dir, dirent.name)),
      });
    }
  }
  return entries;
}

describe("App Router route uniqueness", () => {
  const entries = collectEntries(APP_DIR);

  it("finds the app's entry files (sanity check on the scanner)", () => {
    expect(entries.length).toBeGreaterThan(10);
    expect(entries.some((e) => e.route === "/schemas")).toBe(true);
  });

  it("has exactly one page/route file per URL", () => {
    const byRoute = new Map<string, string[]>();
    for (const e of entries) {
      byRoute.set(e.route, [...(byRoute.get(e.route) ?? []), e.file]);
    }
    const duplicates = [...byRoute.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([route, files]) => `${route}  <-  ${files.join("  +  ")}`);
    expect(
      duplicates,
      `Duplicate routes break \`next build --webpack\` (client reference manifest for the route is missing):\n${duplicates.join("\n")}`,
    ).toEqual([]);
  });
});
