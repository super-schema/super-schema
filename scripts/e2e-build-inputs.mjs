// What a production build is made from, as one hash: the release runner (scripts/e2e-release.mjs) writes it into `.next` after a build and
// reuses the build (`--reuse-build`) only when the hash is the same again. A comparison of modification times cannot say that a
// `git checkout` to an older commit, a restored file or a changed NEXT_PUBLIC_ value in a `.env` file changed the build's inputs; a hash of the
// inputs does. Dependency-free; unit tested in tests/unit/scripts/e2e-build-inputs.test.ts.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Files, relative to the checkout, that `next build` (and its `prebuild`: prisma generate, the parser worker bundle) reads. `next.config.*` is added by pattern. */
export const BUILD_INPUT_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "postcss.config.mjs",
  "prisma/schema.prisma",
  "scripts/build-parser-worker.mjs",
]);

/** Directories, relative to the checkout, read whole (every file's content): the app's sources and its static files. */
export const BUILD_INPUT_DIRS = Object.freeze(["src", "public"]);

/** Left out of a directory walk: `src/generated` is the prisma client that `prebuild` writes (derived from the schema and the lockfile, both inputs). */
const SKIPPED = (relative) => relative === path.join("src", "generated") || path.basename(relative) === "node_modules" || path.basename(relative) === ".next";

/** The `.env` files `next build` reads in production mode, lowest priority first (a later file wins over an earlier one). */
export const ENV_FILES = Object.freeze([".env", ".env.production", ".env.local", ".env.production.local"]);

/** The `NEXT_PUBLIC_*` assignments of a `.env` file's text. */
export function nextPublicOf(text) {
  /** @type {Record<string, string>} */
  const found = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?(NEXT_PUBLIC_[A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    found[match[1]] = value;
  }
  return found;
}

const sha = (data) => createHash("sha1").update(data).digest("hex");

/** Every file under `dir` (relative paths, sorted), without the skipped directories. */
function walk(root, relativeDir) {
  const dir = path.join(root, relativeDir);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const relative = path.join(relativeDir, name);
    if (SKIPPED(relative)) continue;
    let stat;
    try {
      stat = statSync(path.join(root, relative));
    } catch {
      continue; // a dangling link
    }
    if (stat.isDirectory()) out.push(...walk(root, relative));
    else out.push(relative);
  }
  return out;
}

/**
 * The hash of everything a build is made from: the content of every input file, the NEXT_PUBLIC_* values that `next build` would bake
 * in (the `.env` files' and the shell's, which win), the build mode and the major version of Node.
 *
 * @param {{ root: string, env?: Record<string, string | undefined>, nodeVersion?: string }} input
 * @returns {string} hex
 */
export function hashBuildInputs({ root, env = {}, nodeVersion = process.versions.node }) {
  const files = new Set(BUILD_INPUT_FILES);
  for (const name of readdirSync(root)) if (/^next\.config\./.test(name)) files.add(name);
  for (const dir of BUILD_INPUT_DIRS) for (const file of walk(root, dir)) files.add(file);

  const hash = createHash("sha1");
  for (const file of [...files].sort()) {
    const full = path.join(root, file);
    hash.update(`file ${file} ${existsSync(full) ? sha(readFileSync(full)) : "missing"}\n`);
  }

  /** @type {Record<string, string>} */
  const baked = {};
  for (const name of ENV_FILES) {
    const full = path.join(root, name);
    if (existsSync(full)) Object.assign(baked, nextPublicOf(readFileSync(full, "utf8")));
  }
  for (const [key, value] of Object.entries(env)) if (key.startsWith("NEXT_PUBLIC_") && value !== undefined) baked[key] = value;
  hash.update(`baked ${JSON.stringify(Object.entries(baked).sort(([a], [b]) => a.localeCompare(b)))}\n`);
  hash.update(`mode webpack node ${nodeVersion.split(".")[0]}\n`);
  return hash.digest("hex");
}
