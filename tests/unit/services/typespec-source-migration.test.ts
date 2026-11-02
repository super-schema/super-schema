import { describe, it, expect, vi } from "vitest";
import { migrateEntityTypeSpecSource, runTypeSpecSourceMigration } from "@/services/typespec-source-migration.service";
import { FLAGGED_WRITE_SQL, MIGRATED_WRITE_SQL } from "@/lib/entity-versioning/draft-state";

function fakeDb(
  entities: Array<{ id: string; typespecSource: string | null; metadata?: unknown }>,
  opts: { writeCount?: number } = {}
) {
  const writes: Array<{ sql: string; args: unknown[] }> = [];
  return {
    writes,
    entity: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const e = entities.find((x) => x.id === where.id);
        return e
          ? { ...e, name: "Order", description: "", status: "ACTIVE", version: 1, domainId: "d1", metadata: e.metadata ?? null, domain: { id: "d1", name: "Payments" } }
          : null;
      }),
      findMany: vi.fn(async () => entities.map((e) => ({ id: e.id }))),
      update: vi.fn(async () => {
        throw new Error("migration must write via $executeRawUnsafe (guarded on typespecSource IS NULL, one key per statement)");
      }),
      updateMany: vi.fn(async () => {
        throw new Error("migration must write via $executeRawUnsafe (guarded on typespecSource IS NULL, one key per statement)");
      }),
    },
    $executeRawUnsafe: vi.fn(async (sql: string, ...args: unknown[]) => {
      writes.push({ sql, args });
      return opts.writeCount ?? 1;
    }),
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
    expect(db.writes).toHaveLength(0);
  });

  it("writes source when it round-trips clean", async () => {
    const db = fakeDb([{ id: "e1", typespecSource: null }]);
    const compile = vi.fn(async () => ({ success: true, diagnostics: [] }) as never);
    const res = await migrateEntityTypeSpecSource(db as never, "e1", {
      generate: () => "model Order {}",
      compile,
    });
    expect(res.success && res.data.status).toBe("MIGRATED");
    expect(compile).toHaveBeenCalledWith("model Order {}");
    expect(db.writes).toEqual([{ sql: MIGRATED_WRITE_SQL, args: ["e1", "model Order {}"] }]);
    // Guarded write: never overwrites source saved concurrently.
    expect(MIGRATED_WRITE_SQL).toContain(`"typespecSource" IS NULL`);
  });

  it("the MIGRATED write touches only the typespecMigration key of the metadata (the other keys are kept by the row; see the PGlite test)", async () => {
    const db = fakeDb([{ id: "e1", typespecSource: null, metadata: { tags: ["x"], typespecMigration: { status: "FLAGGED" } } }]);
    await migrateEntityTypeSpecSource(db as never, "e1", {
      generate: () => "model Order {}",
      compile: async () => ({ success: true, diagnostics: [] }) as never,
    });
    expect(db.writes[0].sql).toBe(MIGRATED_WRITE_SQL);
    expect(MIGRATED_WRITE_SQL).toContain(`- 'typespecMigration'`);
    expect(db.entity.updateMany).not.toHaveBeenCalled();
  });

  it("flags entities whose generated source fails to compile, leaving typespecSource null", async () => {
    const db = fakeDb([{ id: "e1", typespecSource: null, metadata: { tags: ["x"] } }]);
    const diag = { severity: "error", code: "unknown-identifier", message: "bad", target: "Order" };
    const res = await migrateEntityTypeSpecSource(db as never, "e1", {
      generate: () => "model Order { x: Nope }",
      compile: async () => ({ success: false, diagnostics: [diag] }) as never,
    });
    expect(res.success && res.data.status).toBe("FLAGGED");
    expect(db.writes).toHaveLength(1);
    const [write] = db.writes;
    expect(write.sql).toBe(FLAGGED_WRITE_SQL);
    expect(write.args[0]).toBe("e1");
    // The statement sets the marker only: it never assigns typespecSource.
    expect(write.sql).not.toMatch(/"typespecSource" =/);
    const marker = JSON.parse(write.args[1] as string) as { status: string; diagnostics: unknown[] };
    expect(marker.status).toBe("FLAGGED");
    expect(marker.diagnostics).toEqual([diag]);
  });

  it("returns SKIPPED when the guarded write matches no row (source saved concurrently)", async () => {
    const db = fakeDb([{ id: "e1", typespecSource: null }], { writeCount: 0 });
    const res = await migrateEntityTypeSpecSource(db as never, "e1", {
      generate: () => "model Order {}",
      compile: async () => ({ success: true, diagnostics: [] }) as never,
    });
    expect(res.success && res.data.status).toBe("SKIPPED");
  });

  it("returns SKIPPED when the guarded FLAGGED write matches no row", async () => {
    const db = fakeDb([{ id: "e1", typespecSource: null }], { writeCount: 0 });
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
    expect(db.writes).toHaveLength(0);
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
