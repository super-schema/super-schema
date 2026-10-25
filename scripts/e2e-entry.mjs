// "Is this module the script node was started with?", for every script of the suite (and the build scripts): one helper, so none of them
// compares `import.meta.url` with `process.argv[1]` by hand.
//
// Why not a string compare: `import.meta.url` is the REAL path of the module (node resolves symlinks for the entry point), while
// `process.argv[1]` keeps a symlink on the way (macOS: /tmp, /var and /private are links; a worktree's node_modules is one). A compare of
// the two as strings is false there, `main()` silently does not run, and the script exits 0 having done nothing. Here the two are compared
// as real paths, and when the file that was run has THIS script's name and still is not this file, it throws: a run that does nothing and
// says nothing is the worst way to fail.
//
// Dependency-free; unit tested in tests/unit/scripts/e2e-entry.test.ts (every script, run through a symlinked path).

import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @param {string} moduleUrl `import.meta.url`
 * @param {string | undefined} argv1 `process.argv[1]`
 * @param {(file: string) => string} [realpath]
 */
export function isEntryPoint(moduleUrl, argv1, realpath = realpathSync) {
  if (!argv1) return false;
  const self = fileURLToPath(moduleUrl);
  const real = (file) => {
    try {
      return realpath(file);
    } catch {
      return path.resolve(file);
    }
  };
  const [run, me] = [real(argv1), real(self)];
  if (run === me) return true;
  if (path.basename(argv1) === path.basename(self)) {
    throw new Error(`[${path.basename(self)}] ${argv1} has this script's name but resolves to ${run}, not ${me}: refusing to exit 0 without running anything.`);
  }
  return false;
}
