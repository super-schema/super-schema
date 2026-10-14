import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Story 13.7 — `assetHref` (src/lib/navigation/asset-href.ts) is the single
 * source of truth for in-app `/schemas/...` URLs. This guard fails when any
 * other file hand-builds one with template interpolation.
 */
const ALLOW = new Set(["src/lib/navigation/asset-href.ts"]);

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "generated") out.push(...(await walk(p)));
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

describe("links", () => {
  it("every /schemas link is built by assetHref", async () => {
    const offenders: string[] = [];
    for (const f of await walk("src")) {
      if (ALLOW.has(f)) continue;
      const text = await readFile(f, "utf8");
      if (/[`"']\/schemas\/\$\{/.test(text)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
