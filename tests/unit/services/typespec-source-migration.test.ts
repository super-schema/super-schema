import { describe, it, expect, vi } from "vitest";
import { migrateEntityTypeSpecSource, runTypeSpecSourceMigration } from "@/services/typespec-source-migration.service";

function fakeDb(entities: Array<{ id: string; typespecSource: string | null; metadata?: unknown }>) {
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  return {
    updates,
    entity: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const e = entities.find((x) => x.id === where.id);
        return e
          ? { ...e, name: "Order", description: "", status: "ACTIVE", version: 1, domainId: "d1", metadata: e.metadata ?? null, domain: { id: "d1", name: "Payments" } }
          : null;
      }),
      findMany: vi.fn(async () => entities.map((e) => ({ id: e.id }))),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push({ id: where.id, data });
        return {};
      }),
    },
    field: { findMany: vi.fn(async () => []) },
  };
}

describe("migrateEntityTypeSpecSource", () => {
  it("skips entities that already have typespecSource (idempotent)", async () => {
    const db = fakeDb([{ id: "e1", typespecSource: "model Order {}" }]);
    const res = await migrateEntityTypeSpecSource(db as never, "e1", {
      generate: () => "model X {}",
      compile: vi.fn(),
    });
    expect(res.success && res.data.status).toBe("SKIPPED");
    expect(db.updates).toHaveLength(0);
  });

  it("writes source when it round-trips clean", async () => {
    const db = fakeDb([{ id: "e1", typespecSource: null }]);
    const res = await migrateEntityTypeSpecSource(db as never, "e1", {
      generate: () => "model Order {}",
      compile: async () => ({ success: true, diagnostics: [] }) as never,
    });
    expect(res.success && res.data.status).toBe("MIGRATED");
    expect(db.updates[0].data.typespecSource).toBe("model Order {}");
  });

  it("flags entities whose generated source fails to compile, leaving typespecSource null", async () => {
    const db = fakeDb([{ id: "e1", typespecSource: null, metadata: { tags: ["x"] } }]);
    const diag = { severity: "error", code: "unknown-identifier", message: "bad", target: "Order" };
    const res = await migrateEntityTypeSpecSource(db as never, "e1", {
      generate: () => "model Order { x: Nope }",
      compile: async () => ({ success: false, diagnostics: [diag] }) as never,
    });
    expect(res.success && res.data.status).toBe("FLAGGED");
    const data = db.updates[0].data as { typespecSource?: unknown; metadata: Record<string, unknown> };
    expect(data.typespecSource).toBeUndefined();
    expect(data.metadata.tags).toEqual(["x"]);
    expect((data.metadata.typespecMigration as { status: string }).status).toBe("FLAGGED");
  });
});

describe("runTypeSpecSourceMigration", () => {
  it("summarises outcomes across all entities", async () => {
    const db = fakeDb([
      { id: "e1", typespecSource: "model A {}" },
      { id: "e2", typespecSource: null },
    ]);
    const res = await runTypeSpecSourceMigration(db as never, {
      generate: () => "model B {}",
      compile: async () => ({ success: true, diagnostics: [] }) as never,
    });
    expect(res.success && res.data).toMatchObject({ migrated: 1, skipped: 1, flagged: 0 });
  });
});
