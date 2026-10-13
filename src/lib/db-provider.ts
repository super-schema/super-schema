// Database provider selection.
//
// The app supports two Prisma driver-adapter backends, chosen at runtime by the
// `DB_PROVIDER` environment variable:
//   - "pglite"     — embedded PostgreSQL (WASM, in-process). Zero-config default.
//   - "postgresql" — a real PostgreSQL server (via DATABASE_URL).
//
// Both speak the same PostgreSQL dialect, so a single Prisma schema and a single
// migration history serve both. One provider per deployment.

export type DbProvider = "pglite" | "postgresql";

/**
 * Resolve the active database provider. Defaults to the embedded PGlite backend
 * when `DB_PROVIDER` is unset, so a fresh checkout runs with no configuration.
 */
export function getDbProvider(): DbProvider {
  const raw = (process.env.DB_PROVIDER ?? "pglite").trim().toLowerCase();
  if (raw === "pglite") return "pglite";
  if (raw === "postgres" || raw === "postgresql") return "postgresql";
  throw new Error(
    `Invalid DB_PROVIDER="${process.env.DB_PROVIDER}". Expected "pglite" or "postgresql".`,
  );
}

/**
 * Filesystem location of the embedded PGlite data directory. Used only when
 * `DB_PROVIDER=pglite`. Defaults to `./data/pglite` (gitignored).
 */
export function getPgliteDataDir(): string {
  return process.env.PGLITE_DATA_DIR?.trim() || "./data/pglite";
}
