import { describe, expect, it, vi } from "vitest";
import { assertUpgradeRuntime } from "../../../scripts/pglite-upgrade-runtime.mjs";

function runtime(version: unknown) {
  const probe = {
    query: vi.fn().mockResolvedValue({ rows: [{ server_version_num: version }] }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const PGlite = vi.fn(function () { return probe; });
  return { probe, PGlite };
}

describe("PGlite upgrade runtime preflight", () => {
  it("accepts the target engine and closes its in-memory probe", async () => {
    const { probe, PGlite } = runtime("180006");
    await expect(assertUpgradeRuntime(PGlite, 18)).resolves.toBeUndefined();
    expect(PGlite).toHaveBeenCalledWith();
    expect(probe.query).toHaveBeenCalledWith("SHOW server_version_num");
    expect(probe.close).toHaveBeenCalledOnce();
  });

  it("refuses stale PostgreSQL 17 dependencies before replacing any database", async () => {
    const { probe, PGlite } = runtime("170005");
    await expect(assertUpgradeRuntime(PGlite, 18)).rejects.toThrow(/run npm ci/);
    expect(probe.close).toHaveBeenCalledOnce();
  });

  it("refuses an unknown engine instead of assuming it is compatible", async () => {
    const { PGlite } = runtime(undefined);
    await expect(assertUpgradeRuntime(PGlite, 18)).rejects.toThrow(/PostgreSQL \(unknown\)/);
  });

  it("preserves the startup failure even when closing the failed engine also rejects", async () => {
    const { probe, PGlite } = runtime("180006");
    probe.query.mockRejectedValue(new Error("engine could not start"));
    probe.close.mockRejectedValue(new Error("close failed"));
    await expect(assertUpgradeRuntime(PGlite, 18)).rejects.toThrow("engine could not start");
    expect(probe.close).toHaveBeenCalledOnce();
  });
});
