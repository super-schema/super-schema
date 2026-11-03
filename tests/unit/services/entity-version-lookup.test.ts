import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
// The lookup never compiles: keep the compiler (and its TypeSpec packages) out of this test.
vi.mock("@/lib/entity-versioning/resolve-source", () => ({}));
vi.mock("@/lib/entity-versioning/publish-closure", () => ({}));

import { getEntityVersion } from "@/services/entity-version.service";

type Row = { id: string; entityId: string; major: number; minor: number; patch: number; stage: "SNAPSHOT" | "RELEASED" };
type Where = { entityId_major_minor_patch: { entityId: string; major: number; minor: number; patch: number }; stage: Row["stage"] };

const RELEASED_210: Row = { id: "v-210", entityId: "e1", major: 2, minor: 1, patch: 0, stage: "RELEASED" };
/** Like Prisma's findUnique with an extra non-unique filter: the unique key and `stage` must both match. */
const fakeDb = (rows: Row[]) => ({
  entityVersion: {
    findUnique: vi.fn(async ({ where }: { where: Where }) => {
      const k = where.entityId_major_minor_patch;
      return rows.find((r) => r.entityId === k.entityId && r.major === k.major && r.minor === k.minor && r.patch === k.patch && r.stage === where.stage) ?? null;
    }),
  },
});
const ctx = (db: unknown) => ({ userId: "u1", userRole: "AUTHOR", assignments: [], prisma: db }) as never;

describe("getEntityVersion", () => {
  it.each(["2.1.0", "v2.1.0", "2.1"])("finds the released 2.1.0 row for %j by its full number and stage", async (label) => {
    const db = fakeDb([RELEASED_210]);
    expect(await getEntityVersion("e1", label, ctx(db))).toEqual({ success: true, data: RELEASED_210 });
    expect(db.entityVersion.findUnique).toHaveBeenCalledWith({
      where: { entityId_major_minor_patch: { entityId: "e1", major: 2, minor: 1, patch: 0 }, stage: "RELEASED" },
    });
  });

  // The 2.1.0 row must not stand in for 2.1.7 or for a 2.1.0 snapshot.
  it.each(["2.1.7", "2.1.0_snapshot"])("refuses %j with NOT_FOUND when only the released 2.1.0 row exists", async (label) => {
    const r = await getEntityVersion("e1", label, ctx(fakeDb([RELEASED_210])));
    expect(r).toMatchObject({ success: false, error: { code: "NOT_FOUND", message: `Version ${label} of entity "e1" not found` } });
  });

  it("finds a 2.1.7 row and a snapshot row by their own labels", async () => {
    const patch: Row = { ...RELEASED_210, id: "v-217", patch: 7 };
    const snapshot: Row = { ...RELEASED_210, id: "v-220s", minor: 2, stage: "SNAPSHOT" };
    const db = fakeDb([RELEASED_210, patch, snapshot]);
    expect(await getEntityVersion("e1", "2.1.7", ctx(db))).toEqual({ success: true, data: patch });
    expect(await getEntityVersion("e1", "2.2.0_snapshot", ctx(db))).toEqual({ success: true, data: snapshot });
    // A snapshot is not found by its released label, and vice versa.
    expect(await getEntityVersion("e1", "2.2.0", ctx(db))).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
    expect(await getEntityVersion("e1", "2.1.7_snapshot", ctx(db))).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
  });
});
