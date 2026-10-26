// @vitest-environment node
/**
 * The middleware runs in the Edge runtime, which has no `process.exit`, `process.stderr` or `node:` modules. Next reports each use of them in
 * anything the middleware imports (the dev server printed "A Node.js API is used (process.exit ...) which is not supported in the Edge Runtime"
 * for src/lib/auth-secret.ts, reached through src/lib/session-cookie.ts, and only a person reading the dev console could see it).
 *
 * This follows the app's own imports (`@/...` and relative) from src/middleware.ts and fails for a file that uses one of them.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ENTRY = "src/middleware.ts";
const NODE_ONLY = /\bprocess\.(exit|stderr|stdout|cwd|chdir|abort|kill|on|once|binding)\b|from\s+["']node:|require\(\s*["']node:|from\s+["'](fs|path|crypto|child_process|os|net|http|https|stream|util)["']/;

const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);
const code = (text: string): string => text.split("\n").filter((line) => !isComment(line)).join("\n");

function resolveImport(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/") ? join("src", specifier.slice(2)) : specifier.startsWith(".") ? resolve(dirname(from), specifier) : null;
  if (!base) return null; // a package: not this app's code
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), base]) if (existsSync(candidate) && /\.tsx?$/.test(candidate)) return candidate.replaceAll("\\", "/");
  return null;
}

/** Every app file reachable from the entry by static imports (a dynamic `import()` is a different chunk and is followed too). */
function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const next = resolveImport(file, match[1]);
      if (next) queue.push(next);
    }
  }
  return [...seen].sort();
}

describe("what the middleware imports is safe for the Edge runtime", () => {
  const files = reachable(ENTRY);

  it("the scan reaches the session secret (it is not vacuous)", () => {
    expect(files).toEqual(expect.arrayContaining([ENTRY, "src/lib/session-cookie.ts", "src/lib/auth-secret.ts"]));
  });

  it("no file the middleware imports uses a Node-only API", () => {
    const offenders = files.filter((file) => NODE_ONLY.test(code(readFileSync(file, "utf8"))));
    expect(offenders).toEqual([]);
  });

  it("the scan sees a Node-only API and ignores a comment (self-test)", () => {
    expect(NODE_ONLY.test(code("const exit = (c) => process.exit(c);"))).toBe(true);
    expect(NODE_ONLY.test(code('import { createHmac } from "node:crypto";'))).toBe(true);
    expect(NODE_ONLY.test(code("// process.exit is not here\n * process.stderr"))).toBe(false);
  });
});
