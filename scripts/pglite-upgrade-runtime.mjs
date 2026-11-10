/** Verify the actual engine before an upgrade installs tools or replaces any data directory. */
export async function assertUpgradeRuntime(PGlite, expectedMajor) {
  const probe = new PGlite();
  try {
    const result = await probe.query("SHOW server_version_num");
    const major = Math.floor(Number(result.rows[0]?.server_version_num) / 10000);
    if (!Number.isInteger(major) || major !== expectedMajor) {
      throw new Error(
        `The installed PGlite runs PostgreSQL ${Number.isInteger(major) ? major : "(unknown)"}; this upgrade requires PostgreSQL ${expectedMajor}. ` +
          "Dependencies are out of date: run npm ci, then retry npm run db:pglite-upgrade. No database directory was replaced.",
      );
    }
  } finally {
    await probe.close().catch(() => {});
  }
}
