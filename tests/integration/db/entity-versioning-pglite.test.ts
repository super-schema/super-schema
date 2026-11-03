import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { applyPgliteMigrations } from "@/lib/pglite-migrate";
import {
  MARK_DRAFT_CHANGED_SQL,
  CLEAR_SOURCE_STALE_SQL,
  WRITE_BACK_SOURCE_SQL,
  markEntityDraftChanged,
} from "@/lib/entity-versioning/draft-state";
import type { TestDb } from "../../helpers/pglite-db";

// The service tests below run the real entity-version service on a second PGlite database (the app's `@/lib/db`, which the audit trail
// writes through). The TypeSpec compile gate is a pass-through with a hook (the compiler is not what is tested here): `afterCompile` fires in
// the gap between a save's phase 1 (compile, no lock) and its locked transaction.
const holder = vi.hoisted(() => ({ db: undefined as undefined | TestDb, afterCompile: null as null | (() => Promise<void>) }));
vi.mock("@/lib/db", async () => {
  holder.db = await (await import("../../helpers/pglite-db")).createPgliteDb();
  return { prisma: holder.db.prisma };
});
vi.mock("@/lib/compiler/typespec-compiler", () => ({
  compileTypeSpecWithGovernance: async () => {
    const hook = holder.afterCompile;
    holder.afterCompile = null;
    if (hook) await hook();
    return { success: true, diagnostics: [] };
  },
}));

import {
  publishEntity,
  promoteEntityVersion,
  getEntityVersion,
  getLatestPublishedVersion,
  listEntityVersions,
  loadReferenceStaleness,
} from "@/services/entity-version.service";
import { readReferencedVersions } from "@/lib/entity-versioning/referenced-versions";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

let db: PGlite;
let applied: string[];

beforeAll(async () => {
  db = new PGlite();
  applied = await applyPgliteMigrations(db);
  await db.exec(`INSERT INTO "users" ("id", "email", "updatedAt") VALUES ('u1', 'u1@example.test', CURRENT_TIMESTAMP)`);
}, 60_000);
afterAll(async () => {
  await db.close();
  await holder.db?.close();
});

async function metadataOf(id: string): Promise<unknown> {
  const res = await db.query<{ metadata: unknown }>(`SELECT "metadata" FROM "entities" WHERE "id" = $1`, [id]);
  return res.rows[0].metadata;
}

describe("entity versioning migrations on PGlite", () => {
  it("apply from scratch, enforce immutability and cascade versions with their entity", async () => {
    expect(applied).toContain("20261015_entity_versioning");
    expect(applied).toContain("20261015_entity_versioning_backfill");

    const cols = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'entities' AND column_name IN ('latestVersionId', 'hasUnpublishedChanges')`
    );
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual(["hasUnpublishedChanges", "latestVersionId"]);
    const refs = await db.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_references'`);
    expect(refs.rows).toHaveLength(1);

    await db.exec(
      `INSERT INTO "entities" ("id", "name", "slug", "tenantId", "ownerId", "updatedAt")
       VALUES ('e1', 'E', 'e', 'tenant_default', 'u1', CURRENT_TIMESTAMP)`
    );
    await db.exec(
      `INSERT INTO "entity_versions" ("id", "entityId", "major", "minor", "sequence", "resolvedSource", "fieldSnapshot", "changeKind", "publishedById", "releasedAt")
       VALUES ('v1', 'e1', 1, 0, 1, 'model E {}', '[]', 'INITIAL', 'u1', CURRENT_TIMESTAMP)`
    );
    await db.exec(`UPDATE "entities" SET "latestVersionId" = 'v1', "hasUnpublishedChanges" = false WHERE "id" = 'e1'`);

    await expect(db.exec(`UPDATE "entity_versions" SET "minor" = 1 WHERE "id" = 'v1'`)).rejects.toThrow(/immutable/);

    await db.exec(`DELETE FROM "entities" WHERE "id" = 'e1'`);
    const left = await db.query(`SELECT 1 FROM "entity_versions" WHERE "id" = 'v1'`);
    expect(left.rows).toHaveLength(0);
  });

  it("refuses a direct DELETE of a version but still cascades with its entity", async () => {
    expect(applied).toContain("20261015_entity_versions_no_delete");

    await db.exec(
      `INSERT INTO "entities" ("id", "name", "slug", "tenantId", "ownerId", "updatedAt")
       VALUES ('e3', 'E3', 'e3', 'tenant_default', 'u1', CURRENT_TIMESTAMP)`
    );
    await db.exec(
      `INSERT INTO "entity_versions" ("id", "entityId", "major", "minor", "sequence", "resolvedSource", "fieldSnapshot", "changeKind", "publishedById", "releasedAt")
       VALUES ('v3', 'e3', 1, 0, 1, 'model E3 {}', '[]', 'INITIAL', 'u1', CURRENT_TIMESTAMP)`
    );
    await db.exec(`UPDATE "entities" SET "latestVersionId" = 'v3', "hasUnpublishedChanges" = false WHERE "id" = 'e3'`);

    await expect(db.exec(`DELETE FROM "entity_versions" WHERE "id" = 'v3'`)).rejects.toThrow(/cannot be deleted/);
    expect((await db.query(`SELECT 1 FROM "entity_versions" WHERE "id" = 'v3'`)).rows).toHaveLength(1);

    await db.exec(`DELETE FROM "entities" WHERE "id" = 'e3'`);
    expect((await db.query(`SELECT 1 FROM "entity_versions" WHERE "id" = 'v3'`)).rows).toHaveLength(0);
  });

  it("runs the stale-source statements (R42) with the same SQL text as PostgreSQL", async () => {
    await db.exec(
      `INSERT INTO "entities" ("id", "name", "slug", "tenantId", "ownerId", "updatedAt", "hasUnpublishedChanges")
       VALUES ('e2', 'E2', 'e2', 'tenant_default', 'u1', CURRENT_TIMESTAMP, false)`
    );

    // NULL metadata -> { sourceStale: true }, draft flag set.
    await db.query(MARK_DRAFT_CHANGED_SQL, ["e2"]);
    expect(await metadataOf("e2")).toEqual({ sourceStale: true });
    const flag = await db.query<{ hasUnpublishedChanges: boolean }>(
      `SELECT "hasUnpublishedChanges" FROM "entities" WHERE "id" = 'e2'`
    );
    expect(flag.rows[0].hasUnpublishedChanges).toBe(true);

    // Other metadata keys survive the mark and the clear.
    await db.exec(`UPDATE "entities" SET "metadata" = '{"tags":["a"],"schemaVersions":{"avro":[]}}'::jsonb WHERE "id" = 'e2'`);
    await db.query(MARK_DRAFT_CHANGED_SQL, ["e2"]);
    expect(await metadataOf("e2")).toEqual({ tags: ["a"], schemaVersions: { avro: [] }, sourceStale: true });
    await db.query(CLEAR_SOURCE_STALE_SQL, ["e2"]);
    expect(await metadataOf("e2")).toEqual({ tags: ["a"], schemaVersions: { avro: [] } });

    // Write-back stores the source and drops sourceStale and the 12.7 flag.
    await db.exec(
      `UPDATE "entities" SET "metadata" = '{"tags":["a"],"sourceStale":true,"typespecMigration":{"status":"FLAGGED"}}'::jsonb WHERE "id" = 'e2'`
    );
    await db.query(WRITE_BACK_SOURCE_SQL, ["e2", "model E2 {}"]);
    expect(await metadataOf("e2")).toEqual({ tags: ["a"] });
    const src = await db.query<{ typespecSource: string }>(`SELECT "typespecSource" FROM "entities" WHERE "id" = 'e2'`);
    expect(src.rows[0].typespecSource).toBe("model E2 {}");

    // A JSON-null / NULL metadata clear is a no-op.
    await db.exec(`UPDATE "entities" SET "metadata" = NULL WHERE "id" = 'e2'`);
    await db.query(CLEAR_SOURCE_STALE_SQL, ["e2"]);
    expect(await metadataOf("e2")).toBeNull();
  });
});

const SNAPSHOT_MIGRATION = "20261102000000_snapshot_versioning";

/** The backfill block shipped in the snapshot migration (between its BEGIN/END backfill markers), re-run here against legacy-shaped rows. */
function snapshotBackfillSql(): string {
  const sql = readFileSync(join(process.cwd(), "prisma/migrations", SNAPSHOT_MIGRATION, "migration.sql"), "utf8");
  const block = /-- BEGIN backfill\n([\s\S]*?)-- END backfill/.exec(sql);
  if (!block) throw new Error("backfill markers not found in the snapshot migration");
  return block[1];
}

describe("snapshot versioning migration on PGlite", () => {
  let seq = 0;
  const NOW = "CURRENT_TIMESTAMP";

  beforeAll(async () => {
    await db.exec(`INSERT INTO "domains" ("id","tenantId","name","slug","updatedAt") VALUES ('sd1','tenant_default','SD','sd',${NOW})`);
    await db.exec(`INSERT INTO "products" ("id","domainId","name","slug","updatedAt") VALUES ('sp1','sd1','SP','sp',${NOW})`);
  });

  async function newEntity(): Promise<string> {
    const id = `se${++seq}`;
    await db.exec(
      `INSERT INTO "entities" ("id","name","slug","tenantId","ownerId","updatedAt") VALUES ('${id}','${id}','${id}','tenant_default','u1',${NOW})`
    );
    return id;
  }

  async function newEventSpec(): Promise<string> {
    const id = `ss${++seq}`;
    await db.exec(
      `INSERT INTO "event_specs" ("id","name","document","tenantId","domainId","productId","updatedAt")
       VALUES ('${id}','${id}','{}','tenant_default','sd1','sp1',${NOW})`
    );
    return id;
  }

  type Row = { id: string; major?: number; minor?: number; patch?: number; sequence?: number; stage?: "SNAPSHOT" | "RELEASED"; changeKind?: string };

  /** RELEASED rows carry releasedAt (CHECK); SNAPSHOT rows do not. */
  function insertEntityVersion(entityId: string, r: Row) {
    const stage = r.stage ?? "RELEASED";
    return db.exec(
      `INSERT INTO "entity_versions" ("id","entityId","major","minor","patch","sequence","stage","releasedAt","releasedById","resolvedSource","fieldSnapshot","changeKind","publishedById")
       VALUES ('${r.id}','${entityId}',${r.major ?? 1},${r.minor ?? 0},${r.patch ?? 0},${r.sequence ?? 1},'${stage}',
               ${stage === "RELEASED" ? NOW : "NULL"},${stage === "RELEASED" ? "'u1'" : "NULL"},'model X {}','[]','${r.changeKind ?? "INITIAL"}','u1')`
    );
  }

  function insertEventSpecVersion(eventSpecId: string, r: Row) {
    const stage = r.stage ?? "RELEASED";
    return db.exec(
      `INSERT INTO "event_spec_versions" ("id","eventSpecId","major","minor","patch","sequence","stage","releasedAt","releasedById","document","sourceDocument","frozenTraits","changeKind","publishedById")
       VALUES ('${r.id}','${eventSpecId}',${r.major ?? 1},${r.minor ?? 0},${r.patch ?? 0},${r.sequence ?? 1},'${stage}',
               ${stage === "RELEASED" ? NOW : "NULL"},${stage === "RELEASED" ? "'u1'" : "NULL"},'{}','{}','[]','${r.changeKind ?? "INITIAL"}','u1')`
    );
  }

  it("is applied", () => {
    expect(applied).toContain(SNAPSHOT_MIGRATION);
  });

  it("updates a SNAPSHOT row, including promoting it to RELEASED", async () => {
    const e = await newEntity();
    await insertEntityVersion(e, { id: `${e}-v1`, stage: "SNAPSHOT" });
    await db.exec(`UPDATE "entity_versions" SET "fieldSnapshot" = '[{"name":"id"}]' WHERE "id" = '${e}-v1'`);
    const row = await db.query<{ fieldSnapshot: unknown }>(`SELECT "fieldSnapshot" FROM "entity_versions" WHERE "id" = '${e}-v1'`);
    expect(row.rows[0].fieldSnapshot).toEqual([{ name: "id" }]);

    // Promotion is the last allowed UPDATE: afterwards the row is released and immutable.
    await db.exec(`UPDATE "entity_versions" SET "stage" = 'RELEASED', "releasedAt" = ${NOW}, "releasedById" = 'u1' WHERE "id" = '${e}-v1'`);
    await expect(db.exec(`UPDATE "entity_versions" SET "changeSummary" = 'x' WHERE "id" = '${e}-v1'`)).rejects.toThrow(
      /Released versions are immutable/
    );

    const s = await newEventSpec();
    await insertEventSpecVersion(s, { id: `${s}-v1`, stage: "SNAPSHOT" });
    await db.exec(`UPDATE "event_spec_versions" SET "document" = '{"a":1}' WHERE "id" = '${s}-v1'`);
    const doc = await db.query<{ document: unknown }>(`SELECT "document" FROM "event_spec_versions" WHERE "id" = '${s}-v1'`);
    expect(doc.rows[0].document).toEqual({ a: 1 });
  });

  it("rejects updating a RELEASED row", async () => {
    const e = await newEntity();
    await insertEntityVersion(e, { id: `${e}-v1` });
    await expect(db.exec(`UPDATE "entity_versions" SET "fieldSnapshot" = '[]' WHERE "id" = '${e}-v1'`)).rejects.toThrow(
      /Released versions are immutable; save a new snapshot instead/
    );
    // A released row cannot be turned back into a snapshot either.
    await expect(db.exec(`UPDATE "entity_versions" SET "stage" = 'SNAPSHOT' WHERE "id" = '${e}-v1'`)).rejects.toThrow(
      /Released versions are immutable/
    );

    const s = await newEventSpec();
    await insertEventSpecVersion(s, { id: `${s}-v1` });
    await expect(db.exec(`UPDATE "event_spec_versions" SET "document" = '{}' WHERE "id" = '${s}-v1'`)).rejects.toThrow(
      /Released versions are immutable; save a new snapshot instead/
    );
  });

  it("allows exactly one SNAPSHOT per entity and per event spec", async () => {
    const e = await newEntity();
    await insertEntityVersion(e, { id: `${e}-v1`, stage: "SNAPSHOT", sequence: 1 });
    await expect(insertEntityVersion(e, { id: `${e}-v2`, stage: "SNAPSHOT", minor: 1, sequence: 2 })).rejects.toThrow(
      /entity_versions_one_snapshot/
    );
    // Another entity may hold its own snapshot, and released rows do not count.
    const other = await newEntity();
    await insertEntityVersion(other, { id: `${other}-v1`, stage: "SNAPSHOT" });
    await insertEntityVersion(e, { id: `${e}-r1`, major: 2, sequence: 3, changeKind: "MAJOR" });

    const s = await newEventSpec();
    await insertEventSpecVersion(s, { id: `${s}-v1`, stage: "SNAPSHOT", sequence: 1 });
    await expect(insertEventSpecVersion(s, { id: `${s}-v2`, stage: "SNAPSHOT", minor: 1, sequence: 2 })).rejects.toThrow(
      /event_spec_versions_one_snapshot/
    );
  });

  it("defaults new rows to RELEASED x.y.0 and requires releasedAt on RELEASED rows", async () => {
    const e = await newEntity();
    await db.exec(
      `INSERT INTO "entity_versions" ("id","entityId","major","minor","sequence","releasedAt","resolvedSource","fieldSnapshot","changeKind","publishedById")
       VALUES ('${e}-v1','${e}',1,0,1,${NOW},'model X {}','[]','INITIAL','u1')`
    );
    const row = await db.query<{ patch: number; stage: string; updatedAt: Date | null }>(
      `SELECT "patch", "stage", "updatedAt" FROM "entity_versions" WHERE "id" = '${e}-v1'`
    );
    expect(row.rows[0]).toMatchObject({ patch: 0, stage: "RELEASED" });
    expect(row.rows[0].updatedAt).not.toBeNull();

    await expect(
      db.exec(
        `INSERT INTO "entity_versions" ("id","entityId","major","minor","sequence","resolvedSource","fieldSnapshot","changeKind","publishedById")
         VALUES ('${e}-v2','${e}',1,1,2,'model X {}','[]','MINOR','u1')`
      )
    ).rejects.toThrow(/entity_versions_released_check/);

    const s = await newEventSpec();
    await expect(
      db.exec(
        `INSERT INTO "event_spec_versions" ("id","eventSpecId","major","minor","sequence","document","sourceDocument","frozenTraits","changeKind","publishedById")
         VALUES ('${s}-v1','${s}',1,0,1,'{}','{}','[]','INITIAL','u1')`
      )
    ).rejects.toThrow(/event_spec_versions_released_check/);
  });

  it("stores PATCH change kinds and refuses a negative patch", async () => {
    const e = await newEntity();
    await insertEntityVersion(e, { id: `${e}-v1`, sequence: 1 });
    await insertEntityVersion(e, { id: `${e}-v2`, patch: 1, sequence: 2, changeKind: "PATCH" });
    await expect(insertEntityVersion(e, { id: `${e}-v3`, patch: -1, sequence: 3, changeKind: "PATCH" })).rejects.toThrow(
      /entity_versions_numbers_check/
    );
    const s = await newEventSpec();
    await expect(insertEventSpecVersion(s, { id: `${s}-v1`, patch: -1 })).rejects.toThrow(/event_spec_versions_numbers_check/);
  });

  it("backfills legacy rows as RELEASED x.y.0", async () => {
    // Every migration is already applied, so recreate the pre-migration shape: a row with no releasedAt / releasedById
    // (the CHECK is dropped for the duration), then run the migration's own backfill block. Rolled back afterwards.
    const e = await newEntity();
    const s = await newEventSpec();
    await db.transaction(async (tx) => {
      await tx.exec(`ALTER TABLE "entity_versions" DROP CONSTRAINT "entity_versions_released_check"`);
      await tx.exec(`ALTER TABLE "event_spec_versions" DROP CONSTRAINT "event_spec_versions_released_check"`);
      await tx.exec(
        `INSERT INTO "entity_versions" ("id","entityId","major","minor","sequence","resolvedSource","fieldSnapshot","changeKind","publishedById","publishedAt")
         VALUES ('${e}-legacy','${e}',2,3,1,'model X {}','[]','MINOR','u1','2025-01-02T03:04:05.678Z')`
      );
      await tx.exec(
        `INSERT INTO "event_spec_versions" ("id","eventSpecId","major","minor","sequence","document","sourceDocument","frozenTraits","changeKind","publishedById","publishedAt")
         VALUES ('${s}-legacy','${s}',4,1,1,'{}','{}','[]','MINOR','u1','2025-02-03T04:05:06.789Z')`
      );

      await tx.exec(snapshotBackfillSql());
      await tx.exec(snapshotBackfillSql()); // idempotent

      const ev = await tx.query<Record<string, unknown>>(
        `SELECT "major","minor","patch","stage","releasedAt","releasedById","publishedAt","updatedAt" FROM "entity_versions" WHERE "id" = '${e}-legacy'`
      );
      expect(ev.rows[0]).toMatchObject({ major: 2, minor: 3, patch: 0, stage: "RELEASED", releasedById: "u1" });
      expect(ev.rows[0].releasedAt).toEqual(ev.rows[0].publishedAt);
      expect(ev.rows[0].updatedAt).toEqual(ev.rows[0].publishedAt);

      const sv = await tx.query<Record<string, unknown>>(
        `SELECT "major","minor","patch","stage","releasedAt","releasedById","publishedAt" FROM "event_spec_versions" WHERE "id" = '${s}-legacy'`
      );
      expect(sv.rows[0]).toMatchObject({ major: 4, minor: 1, patch: 0, stage: "RELEASED", releasedById: "u1" });
      expect(sv.rows[0].releasedAt).toEqual(sv.rows[0].publishedAt);

      // The backfill re-enables immutability: the backfilled rows are frozen again.
      await expect(tx.exec(`UPDATE "entity_versions" SET "changeSummary" = 'x' WHERE "id" = '${e}-legacy'`)).rejects.toThrow(
        /Released versions are immutable/
      );
      await tx.rollback();
    });
  });

  it("rejects reusing a released number", async () => {
    const e = await newEntity();
    await insertEntityVersion(e, { id: `${e}-v1`, sequence: 1 });
    await expect(insertEntityVersion(e, { id: `${e}-v2`, stage: "SNAPSHOT", sequence: 2 })).rejects.toThrow(
      /entity_versions_entityId_major_minor_patch_key/
    );
    // Same major.minor with another patch is a different version.
    await insertEntityVersion(e, { id: `${e}-v3`, patch: 1, sequence: 3, changeKind: "PATCH" });

    const s = await newEventSpec();
    await insertEventSpecVersion(s, { id: `${s}-v1`, sequence: 1 });
    await expect(insertEventSpecVersion(s, { id: `${s}-v2`, stage: "SNAPSHOT", sequence: 2 })).rejects.toThrow(
      /event_spec_versions_eventSpecId_major_minor_patch_key/
    );
  });
});

describe("entity snapshots and promotion (service, PGlite)", () => {
  const TENANT = "tenant_default";
  let ctx: ServiceContext;
  let n = 0;
  const prisma = () => holder.db!.prisma;

  beforeAll(async () => {
    const user = await prisma().user.create({ data: { email: "snapshots@example.test" } });
    ctx = { userId: user.id, userRole: "AUTHOR", assignments: [{ role: "ADMIN", scope: { kind: "GLOBAL" } }], prisma: prisma() };
  }, 120_000);

  function unwrap<T>(r: Result<T>): T {
    if (!r.success) throw new Error(`${r.error.code}: ${r.error.message}`);
    return r.data;
  }
  const codeOf = (r: Result<unknown>) => (r.success ? "OK" : r.error.code);

  /** A fresh domain + product; entities and fields created through the helpers live under it. */
  async function scope() {
    const s = `s${++n}`;
    const domainName = `snap-${s}`;
    const domain = await prisma().domain.create({ data: { name: domainName, slug: domainName, tenantId: TENANT } });
    const product = await prisma().product.create({ data: { domainId: domain.id, name: "P", slug: `p-${s}` } });
    const field = (entityId: string, name: string, opts: { type?: string; sortOrder?: number; decorators?: Record<string, string> } = {}) =>
      prisma().field.create({
        data: { entityId, name, slug: name, type: opts.type ?? "string", nullable: true, sortOrder: opts.sortOrder ?? 0, decorators: opts.decorators ?? {} },
      });
    const entity = async (name: string) => {
      const e = await prisma().entity.create({
        data: { name, slug: `${name.toLowerCase()}-${s}`, tenantId: TENANT, domainId: domain.id, productId: product.id, ownerId: ctx.userId },
      });
      await field(e.id, "id");
      return e;
    };
    const reference = (entityId: string, name: string, target: { id: string; name: string }) =>
      field(entityId, name, {
        type: "reference",
        sortOrder: 1,
        decorators: { referencedEntityId: target.id, referencedEntityName: target.name, referencedQualifiedName: `${domainName}/P/${target.name}` },
      });
    let extra = 10;
    /** Edits the draft the way the field editor does: a new optional field, draft flagged changed and source stale. */
    const edit = async (entityId: string) => {
      await field(entityId, `f${extra}`, { sortOrder: extra++ });
      await markEntityDraftChanged(prisma(), entityId);
    };
    return { domainName, entity, field, reference, edit };
  }

  const versionsOf = (entityId: string) =>
    prisma().entityVersion.findMany({ where: { entityId }, orderBy: { sequence: "asc" } });
  const entityRow = (entityId: string) =>
    prisma().entity.findUniqueOrThrow({ where: { id: entityId }, select: { latestVersionId: true, hasUnpublishedChanges: true } });
  const pinEdgesFrom = (versionId: string) =>
    prisma().schemaReference.findMany({ where: { fromKind: "ENTITY_VERSION", fromId: versionId } });

  it("save → save → promote yields one RELEASED 1.0.0 and no snapshot", async () => {
    const sc = await scope();
    const e = await sc.entity("Order");

    const first = unwrap(await publishEntity(e.id, {}, ctx));
    expect(first).toMatchObject({ label: "1.0.0_snapshot", stage: "SNAPSHOT", releasedAt: null, changeKind: "INITIAL" });
    // No release yet: the snapshot is what unversioned lookups resolve to.
    expect(await entityRow(e.id)).toEqual({ latestVersionId: first.id, hasUnpublishedChanges: false });

    // Nothing changed since the save: a second save is refused, naming the snapshot.
    const again = await publishEntity(e.id, {}, ctx);
    expect(!again.success && again.error.message).toContain("1.0.0_snapshot");

    await sc.edit(e.id);
    const second = unwrap(await publishEntity(e.id, { changeSummary: "second" }, ctx));
    expect(second).toMatchObject({ id: first.id, label: "1.0.0_snapshot", stage: "SNAPSHOT", sequence: first.sequence, changeSummary: "second" });
    const [row] = await versionsOf(e.id);
    expect((row.fieldSnapshot as unknown[]).length).toBe(2);
    expect(new Date(second.publishedAt).getTime()).toBeGreaterThanOrEqual(new Date(first.publishedAt).getTime());

    const promoted = unwrap(await promoteEntityVersion(e.id, ctx));
    expect(promoted).toMatchObject({ id: first.id, label: "1.0.0", stage: "RELEASED", sequence: first.sequence });
    expect(promoted.releasedAt).not.toBeNull();

    const rows = await versionsOf(e.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ major: 1, minor: 0, patch: 0, stage: "RELEASED", releasedById: ctx.userId, changeSummary: "second" });
    expect(await entityRow(e.id)).toEqual({ latestVersionId: first.id, hasUnpublishedChanges: false });
    const audit = await prisma().auditLog.findMany({ where: { entityId: e.id, action: "PROMOTE_VERSION" } });
    expect(audit).toHaveLength(1);

    // Nothing left to promote; the released row cannot be written again.
    const twice = await promoteEntityVersion(e.id, ctx);
    expect(codeOf(twice)).toBe("NO_SNAPSHOT");
    await expect(prisma().entityVersion.update({ where: { id: first.id }, data: { changeSummary: "x" } })).rejects.toThrow(/immutable/);
  });

  it("save after release creates 1.1.0_snapshot and latestVersionId stays on 1.0.0", async () => {
    const sc = await scope();
    const e = await sc.entity("Order");
    unwrap(await publishEntity(e.id, {}, ctx));
    const release = unwrap(await promoteEntityVersion(e.id, ctx));
    const releasedBefore = await prisma().entityVersion.findUniqueOrThrow({ where: { id: release.id } });

    await sc.edit(e.id);
    const snap = unwrap(await publishEntity(e.id, { bump: "MINOR" }, ctx));
    expect(snap).toMatchObject({ label: "1.1.0_snapshot", stage: "SNAPSHOT", changeKind: "MINOR", sequence: release.sequence + 1 });
    expect(snap.id).not.toBe(release.id);
    expect((await entityRow(e.id)).latestVersionId).toBe(release.id);

    // Unversioned lookups prefer the release; the list shows the snapshot first.
    const latest = unwrap(await getLatestPublishedVersion(e.id, ctx));
    expect(latest?.id).toBe(release.id);
    const list = unwrap(await listEntityVersions(e.id, ctx));
    expect(list.map((v) => v.label)).toEqual(["1.1.0_snapshot", "1.0.0"]);

    // A breaking-level save raises the open snapshot in place (never a second snapshot).
    await sc.edit(e.id);
    const raised = unwrap(await publishEntity(e.id, { bump: "MAJOR" }, ctx));
    expect(raised).toMatchObject({ id: snap.id, label: "2.0.0_snapshot", changeKind: "MAJOR", sequence: snap.sequence });
    expect(await prisma().entityVersion.count({ where: { entityId: e.id, stage: "SNAPSHOT" } })).toBe(1);

    // The release was never touched.
    expect(await prisma().entityVersion.findUniqueOrThrow({ where: { id: release.id } })).toEqual(releasedBefore);

    const promoted = unwrap(await promoteEntityVersion(e.id, ctx));
    expect(promoted).toMatchObject({ id: snap.id, label: "2.0.0" });
    expect((await entityRow(e.id)).latestVersionId).toBe(snap.id);
  });

  it("replaces the snapshot's pin edges when it is saved again", async () => {
    const sc = await scope();
    const customer = await sc.entity("Customer");
    unwrap(await publishEntity(customer.id, {}, ctx));
    const c1 = unwrap(await promoteEntityVersion(customer.id, ctx));
    const order = await sc.entity("Order");
    await sc.reference(order.id, "buyer", customer);

    const snap = unwrap(await publishEntity(order.id, {}, ctx));
    expect((await pinEdgesFrom(snap.id)).map((r) => r.toId)).toEqual([c1.id]);

    await sc.edit(customer.id);
    unwrap(await publishEntity(customer.id, {}, ctx));
    const c2 = unwrap(await promoteEntityVersion(customer.id, ctx));

    await sc.edit(order.id);
    unwrap(await publishEntity(order.id, {}, ctx));
    expect((await pinEdgesFrom(snap.id)).map((r) => r.toId)).toEqual([c2.id]);
    const recorded = readReferencedVersions((await prisma().entityVersion.findUniqueOrThrow({ where: { id: snap.id } })).compatReport);
    expect(recorded.map((r) => r.version)).toEqual([c2.label]);
  });

  it("promote refuses a snapshot that references a snapshot, naming the entity; after that entity is promoted it records the release", async () => {
    const sc = await scope();
    const customer = await sc.entity("Customer");
    const cSnap = unwrap(await publishEntity(customer.id, {}, ctx));
    const order = await sc.entity("Order");
    await sc.reference(order.id, "buyer", customer);

    // A snapshot may reference a snapshot.
    const oSnap = unwrap(await publishEntity(order.id, {}, ctx));
    expect(readReferencedVersions((await prisma().entityVersion.findUniqueOrThrow({ where: { id: oSnap.id } })).compatReport).map((r) => r.version)).toEqual([
      "1.0.0_snapshot",
    ]);
    expect((await pinEdgesFrom(oSnap.id)).map((r) => r.toId)).toEqual([cSnap.id]);

    // A release may not.
    const refused = await promoteEntityVersion(order.id, ctx);
    expect(codeOf(refused)).toBe("SNAPSHOT_REFERENCES");
    expect(!refused.success && refused.error.message).toContain("Customer");
    expect((await versionsOf(order.id))[0].stage).toBe("SNAPSHOT");

    unwrap(await promoteEntityVersion(customer.id, ctx));
    const promoted = unwrap(await promoteEntityVersion(order.id, ctx));
    expect(promoted.label).toBe("1.0.0");
    // What the release records names released versions only.
    const row = await prisma().entityVersion.findUniqueOrThrow({ where: { id: oSnap.id } });
    expect(readReferencedVersions(row.compatReport).map((r) => r.version)).toEqual(["1.0.0"]);
  });

  it("promote refuses a snapshot whose referenced snapshot was saved again after it, until it is saved again itself", async () => {
    const sc = await scope();
    const customer = await sc.entity("Customer");
    unwrap(await publishEntity(customer.id, {}, ctx)); // Customer 1.0.0_snapshot, content C1
    const order = await sc.entity("Order");
    await sc.reference(order.id, "buyer", customer);
    const oSnap = unwrap(await publishEntity(order.id, {}, ctx)); // gated against C1

    await sc.edit(customer.id);
    unwrap(await publishEntity(customer.id, {}, ctx)); // C2, same row and number
    unwrap(await promoteEntityVersion(customer.id, ctx)); // released 1.0.0 at C2

    // Customer 1.0.0 is released, but at content Order's gate never checked.
    const refused = await promoteEntityVersion(order.id, ctx);
    expect(codeOf(refused)).toBe("SNAPSHOT_REFERENCES");
    expect(!refused.success && refused.error.message).toContain("Customer");
    expect((await prisma().entityVersion.findUniqueOrThrow({ where: { id: oSnap.id } })).stage).toBe("SNAPSHOT");

    // Saved again (gated against the released content), it promotes.
    await sc.edit(order.id);
    unwrap(await publishEntity(order.id, {}, ctx));
    const promoted = unwrap(await promoteEntityVersion(order.id, ctx));
    expect(promoted).toMatchObject({ id: oSnap.id, label: "1.0.0" });
    const row = await prisma().entityVersion.findUniqueOrThrow({ where: { id: oSnap.id } });
    expect(readReferencedVersions(row.compatReport).map((r) => r.version)).toEqual(["1.0.0"]);
  });

  it("promote refuses a dirty draft and a retired entity", async () => {
    const sc = await scope();
    const e = await sc.entity("Order");
    unwrap(await publishEntity(e.id, {}, ctx));
    await sc.edit(e.id);
    expect(codeOf(await promoteEntityVersion(e.id, ctx))).toBe("DRAFT_NOT_SAVED");
    unwrap(await publishEntity(e.id, {}, ctx));

    await prisma().entity.update({ where: { id: e.id }, data: { status: "RETIRED" } });
    const retired = await promoteEntityVersion(e.id, ctx);
    expect(codeOf(retired)).toBe("PUBLISH_BLOCKED");
    expect(!retired.success && retired.error.message).toContain("Retired");
    expect((await versionsOf(e.id))[0].stage).toBe("SNAPSHOT");
  });

  it("promote racing save: a CONFLICT when the other lands first, and never a second snapshot or a changed release", async () => {
    const sc = await scope();
    const e = await sc.entity("Order");
    unwrap(await publishEntity(e.id, {}, ctx));
    const release = unwrap(await promoteEntityVersion(e.id, ctx));
    const releasedBefore = await prisma().entityVersion.findUniqueOrThrow({ where: { id: release.id } });
    await sc.edit(e.id);
    const snap = unwrap(await publishEntity(e.id, {}, ctx)); // 1.1.0_snapshot, draft clean: promotable

    // 1. A promote that lands while a save is between its compile and its lock: the save is refused as a CONFLICT (it planned to update
    //    a snapshot that is now a release), and nothing it planned is written.
    await sc.edit(e.id);
    let promotedInGap: Result<unknown> | undefined;
    holder.afterCompile = async () => {
      // The draft is dirty, so a promote here must refuse; make it clean (as if the edit had been saved by someone else) to let it win.
      await prisma().entity.update({ where: { id: e.id }, data: { hasUnpublishedChanges: false } });
      promotedInGap = await promoteEntityVersion(e.id, ctx);
    };
    const save = await publishEntity(e.id, {}, ctx);
    expect(codeOf(promotedInGap as Result<unknown>)).toBe("OK");
    expect(codeOf(save)).toBe("CONFLICT");
    expect(await prisma().entityVersion.count({ where: { entityId: e.id, stage: "SNAPSHOT" } })).toBe(0);
    const promotedRow = await prisma().entityVersion.findUniqueOrThrow({ where: { id: snap.id } });
    expect(promotedRow).toMatchObject({ stage: "RELEASED", major: 1, minor: 1, patch: 0 });

    // 2. A save that lands between a promote's first look and its lock: the promote is refused as a CONFLICT (the snapshot it was asked to
    //    release changed under it).
    await prisma().entity.update({ where: { id: e.id }, data: { hasUnpublishedChanges: true } });
    const s2 = unwrap(await publishEntity(e.id, {}, ctx)); // 1.2.0_snapshot
    await sc.edit(e.id);
    const raced = new Proxy(prisma(), {
      get(target, prop) {
        if (prop === "$transaction") {
          return async (...args: unknown[]) => {
            unwrap(await publishEntity(e.id, {}, ctx)); // re-saves s2
            return (target.$transaction as (...a: unknown[]) => unknown)(...args);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const promote2 = await promoteEntityVersion(e.id, { ...ctx, prisma: raced as typeof ctx.prisma });
    expect(codeOf(promote2)).toBe("CONFLICT");
    expect((await prisma().entityVersion.findUniqueOrThrow({ where: { id: s2.id } })).stage).toBe("SNAPSHOT");

    // 3. Both at once, on a dirty draft (only the save is valid at the start). The save always wins. The promote is refused (CONFLICT
    //    when the save committed between its first look and its lock, DRAFT_NOT_SAVED when it locked first), or, when the save had
    //    fully committed before the promote even looked, promotes exactly what the save wrote (a valid serial order). Either way: never a
    //    second snapshot, never an update of a released row, never a released number twice.
    await sc.edit(e.id);
    const releasedBeforeRace = await prisma().entityVersion.findMany({ where: { entityId: e.id, stage: "RELEASED" }, orderBy: { id: "asc" } });
    const [saveResult, promoteResult] = await Promise.allSettled([publishEntity(e.id, {}, ctx), promoteEntityVersion(e.id, ctx)]);
    const saveCode = saveResult.status === "fulfilled" ? codeOf(saveResult.value) : "THREW";
    const promoteCode = promoteResult.status === "fulfilled" ? codeOf(promoteResult.value) : "THREW";
    expect(saveCode).toBe("OK");
    expect(["OK", "CONFLICT", "DRAFT_NOT_SAVED"]).toContain(promoteCode);
    const saved = saveResult.status === "fulfilled" && saveResult.value.success ? saveResult.value.data : undefined;
    if (promoteCode === "OK") {
      // The promote saw the new snapshot: it released that row, at the save's content.
      const promotedNow = await prisma().entityVersion.findUniqueOrThrow({ where: { id: saved!.id } });
      expect(promotedNow.stage).toBe("RELEASED");
      expect(promotedNow.publishedAt.toISOString()).toBe(saved!.publishedAt);
    }
    expect(await prisma().entityVersion.count({ where: { entityId: e.id, stage: "SNAPSHOT" } })).toBeLessThanOrEqual(1);
    expect(await prisma().entityVersion.findUniqueOrThrow({ where: { id: release.id } })).toEqual(releasedBefore);
    for (const before of releasedBeforeRace) {
      expect(await prisma().entityVersion.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
    }
    const released = await prisma().entityVersion.findMany({ where: { entityId: e.id, stage: "RELEASED" } });
    expect(new Set(released.map((v) => `${v.major}.${v.minor}.${v.patch}`)).size).toBe(released.length);
  });

  it("legacy referencedVersions '2.1' resolves to 2.1.0", async () => {
    const sc = await scope();
    const customer = await sc.entity("Customer");
    const base = { resolvedSource: "model Customer {}", fieldSnapshot: [], publishedById: ctx.userId };
    const c21 = await prisma().entityVersion.create({
      data: { ...base, entityId: customer.id, major: 2, minor: 1, patch: 0, sequence: 1, changeKind: "INITIAL", releasedAt: new Date(), releasedById: ctx.userId },
    });
    await prisma().entity.update({ where: { id: customer.id }, data: { latestVersionId: c21.id, hasUnpublishedChanges: false } });

    // An open snapshot of Order whose record names Customer in the legacy MAJOR.MINOR form.
    const order = await sc.entity("Order");
    const legacyRef = { ref: { entityId: customer.id, domain: sc.domainName, product: "P", entity: "Customer" }, version: "2.1", pinned: false };
    const oSnap = await prisma().entityVersion.create({
      data: {
        ...base, entityId: order.id, major: 1, minor: 0, patch: 0, sequence: 1, changeKind: "INITIAL", stage: "SNAPSHOT",
        resolvedSource: "model Order {}", compatReport: { referencedVersions: [legacyRef] },
      },
    });
    await prisma().entity.update({ where: { id: order.id }, data: { latestVersionId: oSnap.id, hasUnpublishedChanges: false } });

    // "2.1" is the released 2.1.0, not a snapshot reference: the promote goes through and keeps the record as it was.
    const promoted = unwrap(await promoteEntityVersion(order.id, ctx));
    expect(promoted.label).toBe("1.0.0");
    const row = await prisma().entityVersion.findUniqueOrThrow({ where: { id: oSnap.id } });
    expect(readReferencedVersions(row.compatReport)).toEqual([legacyRef]);

    // Staleness compares "2.1" as 2.1.0.
    expect(unwrap(await loadReferenceStaleness(prisma(), order.id))).toEqual([]);
    const c22 = await prisma().entityVersion.create({
      data: { ...base, entityId: customer.id, major: 2, minor: 2, patch: 0, sequence: 2, changeKind: "MINOR", releasedAt: new Date(), releasedById: ctx.userId },
    });
    await prisma().entity.update({ where: { id: customer.id }, data: { latestVersionId: c22.id } });
    expect(unwrap(await loadReferenceStaleness(prisma(), order.id))).toEqual([{ ref: legacyRef.ref, recorded: "2.1", latest: "2.2.0" }]);
  });

  it("getEntityVersion keeps x.y.z and x.y.z_snapshot apart", async () => {
    const sc = await scope();
    const released = await sc.entity("Released");
    unwrap(await publishEntity(released.id, {}, ctx));
    unwrap(await promoteEntityVersion(released.id, ctx));
    expect(codeOf(await getEntityVersion(released.id, "1.0.0", ctx))).toBe("OK");
    expect(codeOf(await getEntityVersion(released.id, "1.0", ctx))).toBe("OK");
    expect(codeOf(await getEntityVersion(released.id, "1.0.0_snapshot", ctx))).toBe("NOT_FOUND");

    const snapshot = await sc.entity("Snapshot");
    unwrap(await publishEntity(snapshot.id, {}, ctx));
    expect(codeOf(await getEntityVersion(snapshot.id, "1.0.0_snapshot", ctx))).toBe("OK");
    expect(codeOf(await getEntityVersion(snapshot.id, "1.0.0", ctx))).toBe("NOT_FOUND");
  });
});
