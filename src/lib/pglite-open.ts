// Opening the embedded PGlite database: the one place that knows how a data directory is prepared, opened, shared and recovered.
// Relative imports only (it also runs under tsx / esbuild-bundled scripts).
//
//  - `ensurePgliteDataDir`: PGlite's own mkdir is not recursive, so a fresh checkout without ./data crashed `db ensure` with ENOENT.
//  - `openPglite`: waits until the database is ready; an unopenable directory (a killed process left it half-written) fails with the way out
//    (`npm run db:reset`) instead of a bare `RuntimeError: Aborted()`.
//  - `resetPgliteDataDir`: moves such a directory aside (never deletes it) so `db ensure` can build a fresh one.
//  - `sharedPglite`: ONE client per directory per process, kept on globalThis. Next bundles route handlers, server actions and the proxy as
//    separate module graphs, each with its own module-level singleton; a second PGlite on the same directory aborts (the dev log's
//    "Unhandled Rejection: Aborted()").
//  - `closeOnSignals`: closes the client on SIGINT / SIGTERM so stopping the dev server does not leave the directory half-written.

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";

/** `memory://`, `idb://` ...: not a directory on disk. */
const isFileSystemPath = (dir: string): boolean => !dir.includes("://");

export function ensurePgliteDataDir(dir: string): void {
  if (!isFileSystemPath(dir)) return;
  mkdirSync(dir, { recursive: true });
}

export class PgliteOpenError extends Error {
  constructor(readonly dir: string, readonly cause: unknown) {
    super(
      `The PGlite database at "${dir}" could not be opened (${cause instanceof Error ? cause.message.split("\n")[0] : String(cause)}). ` +
        `A process killed while writing usually leaves it that way, or another process holds it. ` +
        `Stop every process that uses it, then run \`npm run db:reset\` (moves it aside to "${dir}.corrupt-<time>" and builds a fresh one).`,
    );
    this.name = "PgliteOpenError";
  }
}

/** A ready client on `dir` (created with its parents), or a {@link PgliteOpenError}. */
export async function openPglite(dir: string): Promise<PGlite> {
  ensurePgliteDataDir(dir);
  const db = new PGlite(dir);
  try {
    await db.waitReady;
    return db;
  } catch (cause) {
    await db.close().catch(() => undefined);
    throw new PgliteOpenError(dir, cause);
  }
}

export interface ResetOutcome {
  moved: boolean;
  backup?: string;
  reason: string;
}

/**
 * Moves the data directory aside as `<dir>.corrupt-<now>`. Without `force` it only does so when the directory cannot be opened: a healthy
 * database (possibly in use by the dev server) is never moved by accident.
 */
export async function resetPgliteDataDir(dir: string, options: { force?: boolean; now?: () => number } = {}): Promise<ResetOutcome> {
  if (!isFileSystemPath(dir) || !existsSync(dir)) return { moved: false, reason: `nothing at "${dir}"` };
  if (!options.force) {
    try {
      await (await openPglite(dir)).close();
      return { moved: false, reason: `"${dir}" opens fine; pass --force to move it aside anyway` };
    } catch (error) {
      if (!(error instanceof PgliteOpenError)) throw error;
    }
  }
  const backup = `${dir}.corrupt-${(options.now ?? Date.now)()}`;
  mkdirSync(dirname(backup), { recursive: true });
  renameSync(dir, backup);
  return { moved: true, backup, reason: `moved "${dir}" to "${backup}"` };
}

const SHARED = Symbol.for("super-schema.pglite.clients");
type Registry = Map<string, PGlite>;

/** One client per directory per process (see the header). `create` is the test seam; the default opens the directory. */
export function sharedPglite(dir: string, create: () => PGlite = () => (ensurePgliteDataDir(dir), new PGlite(dir))): PGlite {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
  const registry = (holder[SHARED] ??= new Map());
  let client = registry.get(dir);
  if (!client) {
    client = create();
    registry.set(dir, client);
    // Nobody awaits `waitReady` for a client the adapter uses lazily: report a failed open once, with the way out, instead of an
    // unhandled rejection.
    client.waitReady?.catch((cause: unknown) => console.error(new PgliteOpenError(dir, cause).message));
  }
  return client;
}

/** Closes every shared client of this process (a script's last step: an open PGlite keeps the process alive after the work is done). */
export async function closeSharedPglite(): Promise<void> {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
  const registry = holder[SHARED];
  if (!registry) return;
  const clients = [...registry.values()];
  registry.clear();
  await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
}

const SIGNALS = Symbol.for("super-schema.pglite.signals");

/**
 * Closes `client` when the process is asked to stop, once per process. When this is the only listener the process would otherwise keep
 * running (a listener replaces the default exit), so it is stopped after the close; when another listener exists (Next's own) that one
 * decides.
 */
export function closeOnSignals(client: PGlite): void {
  const holder = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (holder[SIGNALS]) return;
  holder[SIGNALS] = true;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      const closing = client.close().catch(() => undefined);
      if (process.listenerCount(signal) === 0) void closing.finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
    });
  }
}
