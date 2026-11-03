import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
// The lookup never compiles: keep the compiler (and its TypeSpec packages) out of this test.
vi.mock("@/lib/entity-versioning/resolve-source", () => ({}));
vi.mock("@/lib/entity-versioning/publish-closure", () => ({}));

import { getEntityVersion } from "@/services/entity-version.service";

const ROW = { id: "v-21", entityId: "e1", major: 2, minor: 1 };
const fakeDb = () => ({ entityVersion: { findUnique: vi.fn(async () => ROW) } });
const ctx = (db: unknown) => ({ userId: "u1", userRole: "AUTHOR", assignments: [], prisma: db }) as never;

describe("getEntityVersion", () => {
  it.each(["2.1.0", "v2.1.0", "2.1"])("finds the stored row for %j by its major/minor key", async (label) => {
    const db = fakeDb();
    expect(await getEntityVersion("e1", label, ctx(db))).toEqual({ success: true, data: ROW });
    expect(db.entityVersion.findUnique).toHaveBeenCalledWith({ where: { entityId_major_minor: { entityId: "e1", major: 2, minor: 1 } } });
  });

  // Until the patch / stage columns land every stored version is a released x.y.0: the 2.1 row must not stand in for 2.1.7 or a snapshot.
  it.each(["2.1.7", "2.1.0_snapshot"])("refuses %j with NOT_FOUND instead of returning the 2.1 row", async (label) => {
    const db = fakeDb();
    const r = await getEntityVersion("e1", label, ctx(db));
    expect(r).toMatchObject({ success: false, error: { code: "NOT_FOUND", message: `Version ${label} of entity "e1" not found` } });
    expect(db.entityVersion.findUnique).not.toHaveBeenCalled();
  });
});
