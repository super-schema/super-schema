import "server-only";

import { readdir, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { NodeHost, type CompilerHost } from "@typespec/compiler";

/**
 * A `CompilerHost` for compiling USER-AUTHORED TypeSpec in-process: `NodeHost`, except that JavaScript can only be
 * loaded from installed libraries.
 *
 * `compile(NodeHost, …)` executes any `.js` / `.mjs` a source imports (`getJsImport` is a dynamic `import()`). The
 * import guard (`@/lib/typespec/import-guard`) is what normally stops a source from naming such a file; this host
 * is the second layer, so a source that gets past the guard (a guard bug, a new TypeSpec syntax, a future caller
 * that forgets it) still cannot run code from the host: the library loader asks for a path and gets an error
 * (reported by the compiler as a `js-error` diagnostic) unless that path really lives in a trusted root.
 *
 * Trusted roots (real paths, symlinks resolved): `<cwd>/node_modules`, the compiler's own package root, every
 * package directly under `node_modules/@typespec` and `node_modules/@superschema` (these are symlinks to
 * workspace checkouts in development), and the nearest enclosing `node_modules` of such a linked package (where
 * its own dependencies are hoisted). Nothing an author can write to is in that list.
 *
 * `readUrl` is disabled outright (no remote imports). Reading files, `stat` and `realpath` stay as they are:
 * module resolution walks parent directories looking for `package.json` and relies on the usual not-found errors.
 */

export interface LibraryOnlyHostOptions {
  base?: CompilerHost;
  cwd?: string;
}

const isInside = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

async function tryRealpath(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/** First ancestor of `dir` (itself excluded) that has a `node_modules` directory, as that directory's real path. */
async function enclosingNodeModules(dir: string): Promise<string | null> {
  for (let current = dirname(dir); current !== dirname(current); current = dirname(current)) {
    const found = await tryRealpath(join(current, "node_modules"));
    if (found) return found;
  }
  return null;
}

async function computeTrustedRoots(base: CompilerHost, cwd: string): Promise<string[]> {
  const nodeModules = join(cwd, "node_modules");
  const realNodeModules = await tryRealpath(nodeModules);
  const roots = new Set<string>();
  const add = async (path: string): Promise<string | null> => {
    const real = await tryRealpath(path);
    if (real) roots.add(real);
    return real;
  };
  if (realNodeModules) roots.add(realNodeModules);
  await add(base.getExecutionRoot?.() ?? nodeModules);
  for (const scope of ["@typespec", "@superschema"]) {
    const names = await readdir(join(nodeModules, scope)).catch(() => [] as string[]);
    for (const name of names) {
      const real = await add(join(nodeModules, scope, name));
      if (real && (!realNodeModules || !isInside(real, realNodeModules))) {
        const hoisted = await enclosingNodeModules(real);
        if (hoisted) roots.add(hoisted);
      }
    }
  }
  return [...roots];
}

export function createLibraryOnlyHost(options: LibraryOnlyHostOptions = {}): CompilerHost {
  const base = options.base ?? NodeHost;
  const cwd = options.cwd ?? process.cwd();
  let trusted: Promise<string[]> | undefined;
  const trustedRoots = () => (trusted ??= computeTrustedRoots(base, cwd));
  return {
    ...base,
    async getJsImport(path: string) {
      const real = await tryRealpath(path);
      const roots = await trustedRoots();
      if (!real || !roots.some((root) => isInside(real, root))) {
        throw new Error(`JavaScript can only be loaded from installed TypeSpec libraries; "${path}" is not one`);
      }
      return base.getJsImport(path);
    },
    async readUrl(url: string): Promise<never> {
      throw new Error(`Remote imports are disabled ("${url}")`);
    },
  };
}
