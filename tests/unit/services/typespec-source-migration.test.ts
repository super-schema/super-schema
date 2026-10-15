import { describe, it, expect, vi } from "vitest";
import { migrateEntityTypeSpecSource, runTypeSpecSourceMigration } from "@/services/typespec-source-migration.service";

function fakeDb(
  entities: Array<{ id: string; typespecSource: string | null; metadata?: unknown }>,
  opts: { updateManyCount?: number } = {}
) {
  const updates: Array<{ id: string; data: Record<string, unknown>; where: Record<string, unknown> }> = [];
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
      update: vi.fn(async () => {
        throw new Error("migration must write via updateMany (guarded on typespecSource: null)");
      }),
      updateMany: vi.fn(
        async ({ where, data }: { where: { id: string; typespecSource?: null }; data: Record<string, unknown> }) => {
          updates.push({ id: where.id, data, where });
          return { count: opts.updateManyCount ?? 1 };
        }
      ),
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
    const compile = vi.fn(async () => ({ success: true, diagnostics: [] }) as never);
    const res = await migrateEntityTypeSpecSource(db as never, "e1", {
      generate: () => "model Order {}",
      compile,
    });
    expect(res.success && res.data.status).toBe("MIGRATED");
    expect(db.updates[0].data.typespecSource).toBe("model Order {}");
    expect(compile).toHaveBeenCalledWith("model Order {}");
    // Guarded write: never overwrites source saved concurrently.
    expect(db.updates[0].where).toEqual({ id: "e1", typespecSource: null });
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
    expect(db.updates[0].where).toEqual({ id: "e1", typespecSource: null });
  });

  it("returns SKIPPED when the guarded write matches no row (source saved concurrently)", async () => {
    const db = fakeDb([{ id: "e1", typespecSource: null }], { updateManyCount: 0 });
    const res = await migrateEntityTypeSpecSource(db as never, "e1", {
      generate: () => "model Order {}",
      compile: async () => ({ success: true, diagnostics: [] }) as never,
    });
    expect(res.success && res.data.status).toBe("SKIPPED");
  });

  it("returns SKIPPED when the guarded FLAGGED write matches no row", async () => {
    const db = fakeDb([{ id: "e1", typespecSource: null }], { updateManyCount: 0 });
    const res = await migrateEntityTypeSpecSource(db as never, "e1", {
      generate: () => "model Order { x: Nope }",
      compile: async () => ({ success: false, diagnostics: [] }) as never,
    });
    expect(res.success && res.data.status).toBe("SKIPPED");
  });

  it("converts an unexpected throw into an ERROR outcome instead of throwing", async () => {
    const db = fakeDb([{ id: "e1", typespecSource: null }]);
    const res = await migrateEntityTypeSpecSource(db as never, "e1", {
      generate: () => "model Order {}",
      compile: async () => {
        throw new Error("compiler exploded");
      },
    });
    expect(res.success).toBe(true);
    expect(res.success && res.data).toMatchObject({ entityId: "e1", status: "ERROR", error: "compiler exploded" });
    expect(db.updates).toHaveLength(0);
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
    expect(res.success && res.data).toMatchObject({ migrated: 1, skipped: 1, flagged: 0, errored: 0 });
  });

  it("continues past a throwing entity and counts it as errored", async () => {
    const db = fakeDb([
      { id: "e1", typespecSource: null },
      { id: "e2", typespecSource: null },
    ]);
    let calls = 0;
    const res = await runTypeSpecSourceMigration(db as never, {
      generate: () => "model B {}",
      compile: async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
        return { success: true, diagnostics: [] } as never;
      },
    });
    expect(res.success && res.data).toMatchObject({ migrated: 1, skipped: 0, flagged: 0, errored: 1 });
    expect(res.success && res.data.outcomes.map((o) => o.status)).toEqual(["ERROR", "MIGRATED"]);
  });

  it("turns a non-success result (entity deleted mid-run) into an ERROR outcome and continues", async () => {
    const db = fakeDb([
      { id: "e1", typespecSource: null },
      { id: "e2", typespecSource: null },
    ]);
    // e1 is listed by findMany but gone by the time it is migrated.
    const realFindUnique = db.entity.findUnique.getMockImplementation()!;
    db.entity.findUnique.mockImplementation(async (args: { where: { id: string } }) =>
      args.where.id === "e1" ? null : realFindUnique(args)
    );
    const res = await runTypeSpecSourceMigration(db as never, {
      generate: () => "model B {}",
      compile: async () => ({ success: true, diagnostics: [] }) as never,
    });
    expect(res.success && res.data).toMatchObject({ migrated: 1, errored: 1 });
    expect(res.success && res.data.outcomes[0]).toMatchObject({ entityId: "e1", status: "ERROR" });
  });

  it("returns a failed Result (not a throw) when the entity list cannot be read", async () => {
    const db = fakeDb([]);
    db.entity.findMany.mockRejectedValueOnce(new Error("db down"));
    const res = await runTypeSpecSourceMigration(db as never, {
      generate: () => "",
      compile: vi.fn(),
    });
    expect(res.success).toBe(false);
  });
});
