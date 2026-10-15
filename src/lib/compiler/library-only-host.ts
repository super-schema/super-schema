import "server-only";

import { readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { NodeHost, type CompilerHost } from "@typespec/compiler";

/**
 * A `CompilerHost` for compiling USER-AUTHORED TypeSpec in-process: `NodeHost`, except that JavaScript can only be
 * loaded from installed TypeSpec libraries.
 *
 * `compile(NodeHost, …)` executes any `.js` / `.mjs` a source imports (`getJsImport` is a dynamic `import()`). The
 * import guard (`@/lib/typespec/import-guard`) is what normally stops a source from naming such a file; this host
 * is the second layer, so a source that gets past the guard (a guard bug, a new TypeSpec syntax, a future caller
 * that forgets it) still cannot run code from the host: the library loader asks for a path and gets an error
 * (reported by the compiler as a `js-error` diagnostic) unless that path really lives in a trusted root.
 *
 * Trusted roots are deliberately narrow (real paths, symlinks resolved): the compiler's own package root and the
 * directory of every package installed directly under `<cwd>/node_modules/@typespec` and
 * `<cwd>/node_modules/@superschema` (in development some of these are symlinks to workspace checkouts; their real
 * directories are what is trusted). These are exactly the packages the import guard lets a source name. A package
 * anywhere else, including any other directory of `node_modules` or a `node_modules` higher up the tree, is NOT
 * trusted. A library's own dependencies are loaded by Node itself when the library's entry point is imported, not
 * through `getJsImport`, so they need no entry here.
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

async function computeTrustedRoots(base: CompilerHost, cwd: string): Promise<string[]> {
  const nodeModules = join(cwd, "node_modules");
  const roots = new Set<string>();
  const add = async (path: string): Promise<void> => {
    const real = await tryRealpath(path);
    if (real) roots.add(real);
  };
  await add(base.getExecutionRoot());
  for (const scope of ["@typespec", "@superschema"]) {
    const names = await readdir(join(nodeModules, scope)).catch(() => [] as string[]);
    for (const name of names) await add(join(nodeModules, scope, name));
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
