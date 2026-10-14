import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient, Prisma } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  markEntityFieldsEdited,
  CLEAR_SOURCE_STALE_SQL,
  WRITE_BACK_SOURCE_SQL,
} from "@/lib/entity-versioning/draft-state";

let prisma: PrismaClient;
const TENANT = "tenant_default";

// The statement shipped in the backfill migration, re-run here to prove behaviour + idempotency.
const BACKFILL_SQL = readFileSync(
  join(process.cwd(), "prisma/migrations/20261015_entity_versioning_backfill/migration.sql"),
  "utf8"
)
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

class Rollback extends Error {}

/** Run fn in a transaction that is always rolled back — the backfill touches every eligible row. */
async function inRolledBackTx(fn: (tx: Prisma.TransactionClient) => Promise<void>) {
  try {
    await prisma.$transaction(
      async (tx) => {
        await fn(tx);
        throw new Rollback();
      },
      { timeout: 30_000 }
    );
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

function stamp() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

beforeAll(async () => {
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
});
afterAll(async () => prisma.$disconnect());

describe("entity versioning schema", () => {
  it("backfills INITIAL 1.0 for ACTIVE entities with source, leaves DRAFT and source-less ones, and is idempotent", async () => {
    await inRolledBackTx(async (tx) => {
      const user = await tx.user.findFirstOrThrow();
      const s = stamp();
      const d = await tx.domain.create({ data: { name: `bf-${s}`, slug: `bf-${s}`, tenantId: TENANT } });
      const p = await tx.product.create({ data: { domainId: d.id, name: "P", slug: `p-${s}` } });
      const base = { tenantId: TENANT, domainId: d.id, productId: p.id, ownerId: user.id };

      const active = await tx.entity.create({
        data: {
          ...base, name: "Active", slug: `active-${s}`, status: "ACTIVE", version: 3,
          typespecSource: "model Active { id: string; }",
          fields: { create: [{ name: "id", slug: "id", type: "string", nullable: false, isKey: true, sortOrder: 0 }] },
        },
      });
      const draft = await tx.entity.create({
        data: { ...base, name: "Drafty", slug: `drafty-${s}`, status: "DRAFT", typespecSource: "model Drafty {}" },
      });
      const noSource = await tx.entity.create({
        data: { ...base, name: "NoSource", slug: `nosource-${s}`, status: "ACTIVE" },
      });

      await tx.$executeRawUnsafe(BACKFILL_SQL);
      await tx.$executeRawUnsafe(BACKFILL_SQL);

      const versions = await tx.entityVersion.findMany({ where: { entityId: active.id } });
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({
        major: 1, minor: 0, sequence: 3, changeKind: "INITIAL",
        resolvedSource: "model Active { id: string; }", publishedById: user.id,
      });
      expect((versions[0].fieldSnapshot as Array<{ name: string; isKey: boolean; aliases: string[] }>)[0]).toMatchObject({
        name: "id", isKey: true, aliases: [],
      });

      const a = await tx.entity.findUniqueOrThrow({ where: { id: active.id } });
      expect(a).toMatchObject({ latestVersionId: versions[0].id, hasUnpublishedChanges: false, version: 3 });

      expect(await tx.entityVersion.count({ where: { entityId: { in: [draft.id, noSource.id] } } })).toBe(0);
      const dr = await tx.entity.findUniqueOrThrow({ where: { id: draft.id } });
      expect(dr).toMatchObject({ latestVersionId: null, hasUnpublishedChanges: true });
    });
  });

  it("keeps versions immutable, unique per MAJOR.MINOR and sequence, and cascades them with the entity", async () => {
    let domainId: string | undefined;
    try {
      const user = await prisma.user.findFirstOrThrow();
      const s = stamp();
      const d = await prisma.domain.create({ data: { name: `imm-${s}`, slug: `imm-${s}`, tenantId: TENANT } });
      domainId = d.id;
      const p = await prisma.product.create({ data: { domainId: d.id, name: "P", slug: `p-${s}` } });
      const e = await prisma.entity.create({
        data: { name: "Imm", slug: `imm-${s}`, tenantId: TENANT, domainId: d.id, productId: p.id, ownerId: user.id },
      });
      const row = { entityId: e.id, resolvedSource: "model Imm {}", fieldSnapshot: [], publishedById: user.id };
      const v = await prisma.entityVersion.create({ data: { ...row, major: 1, minor: 0, sequence: 1, changeKind: "INITIAL" } });
      await prisma.entity.update({ where: { id: e.id }, data: { latestVersionId: v.id, hasUnpublishedChanges: false } });

      await expect(prisma.$executeRaw`UPDATE "entity_versions" SET "minor" = 1 WHERE "id" = ${v.id}`).rejects.toThrow(/immutable/);
      await expect(
        prisma.entityVersion.create({ data: { ...row, major: 1, minor: 0, sequence: 2, changeKind: "MINOR" } })
      ).rejects.toThrow(/Unique constraint/);
      await expect(
        prisma.entityVersion.create({ data: { ...row, major: 1, minor: 1, sequence: 1, changeKind: "MINOR" } })
      ).rejects.toThrow(/Unique constraint/);

      // Circular FK (entities.latestVersionId ↔ entity_versions.entityId) must not block the delete.
      await prisma.entity.delete({ where: { id: e.id } });
      expect(await prisma.entityVersion.count({ where: { id: v.id } })).toBe(0);
    } finally {
      if (domainId) await prisma.domain.deleteMany({ where: { id: domainId } });
    }
  });

  it("refuses a direct DELETE of a published version, but still cascades with its entity and its domain", async () => {
    let domainId: string | undefined;
    try {
      const user = await prisma.user.findFirstOrThrow();
      const s = stamp();
      const d = await prisma.domain.create({ data: { name: `nodel-${s}`, slug: `nodel-${s}`, tenantId: TENANT } });
      domainId = d.id;
      const p = await prisma.product.create({ data: { domainId: d.id, name: "P", slug: `p-${s}` } });
      const mk = (name: string) =>
        prisma.entity.create({
          data: { name, slug: `${name.toLowerCase()}-${s}`, tenantId: TENANT, domainId: d.id, productId: p.id, ownerId: user.id },
        });
      const publish = async (entityId: string) => {
        const v = await prisma.entityVersion.create({
          data: { entityId, resolvedSource: "model X {}", fieldSnapshot: [], publishedById: user.id, major: 1, minor: 0, sequence: 1, changeKind: "INITIAL" },
        });
        await prisma.entity.update({ where: { id: entityId }, data: { latestVersionId: v.id, hasUnpublishedChanges: false } });
        return v;
      };
      const e1 = await mk("One");
      const v1 = await publish(e1.id);
      const e2 = await mk("Two");
      const v2 = await publish(e2.id);

      // A direct delete is refused (raw SQL and through Prisma), whether or not it is the latest version.
      await expect(prisma.$executeRaw`DELETE FROM "entity_versions" WHERE "id" = ${v1.id}`).rejects.toThrow(/cannot be deleted/);
      await expect(prisma.entityVersion.delete({ where: { id: v1.id } })).rejects.toThrow(/cannot be deleted/);
      await expect(prisma.entityVersion.deleteMany({ where: { entityId: e1.id } })).rejects.toThrow(/cannot be deleted/);
      expect(await prisma.entityVersion.count({ where: { id: v1.id } })).toBe(1);

      // Deleting the entity still cascades its version (the circular latestVersionId FK does not block it).
      await prisma.entity.delete({ where: { id: e1.id } });
      expect(await prisma.entityVersion.count({ where: { id: v1.id } })).toBe(0);

      // Deleting the whole domain cascades domain -> entity -> version.
      await prisma.domain.delete({ where: { id: d.id } });
      domainId = undefined;
      expect(await prisma.entityVersion.count({ where: { id: v2.id } })).toBe(0);
    } finally {
      if (domainId) await prisma.domain.deleteMany({ where: { id: domainId } });
    }
  });

  it("marks the stored source stale, keeps other metadata, copes with NULL metadata, and clears the marker (R42)", async () => {
    let domainId: string | undefined;
    try {
      const user = await prisma.user.findFirstOrThrow();
      const s = stamp();
      const d = await prisma.domain.create({ data: { name: `stale-${s}`, slug: `stale-${s}`, tenantId: TENANT } });
      domainId = d.id;
      const p = await prisma.product.create({ data: { domainId: d.id, name: "P", slug: `p-${s}` } });
      const e = await prisma.entity.create({
        data: { name: "Stale", slug: `stale-${s}`, tenantId: TENANT, domainId: d.id, productId: p.id, ownerId: user.id },
      });
      const meta = async () => (await prisma.entity.findUniqueOrThrow({ where: { id: e.id } })).metadata;

      // NULL metadata becomes { sourceStale: true } and the draft flag is set.
      await prisma.entity.update({ where: { id: e.id }, data: { hasUnpublishedChanges: false } });
      await markEntityFieldsEdited(prisma, e.id);
      expect(await prisma.entity.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({
        hasUnpublishedChanges: true,
        metadata: { sourceStale: true },
      });

      // Other metadata keys survive both the mark and the clear.
      await prisma.entity.update({ where: { id: e.id }, data: { metadata: { tags: ["a"], schemaVersions: { avro: [] } } } });
      await markEntityFieldsEdited(prisma, e.id);
      expect(await meta()).toEqual({ tags: ["a"], schemaVersions: { avro: [] }, sourceStale: true });
      await prisma.$executeRawUnsafe(CLEAR_SOURCE_STALE_SQL, e.id);
      expect(await meta()).toEqual({ tags: ["a"], schemaVersions: { avro: [] } });

      // Write-back stores the source and drops sourceStale and the 12.7 flag, keeping the rest.
      await prisma.entity.update({
        where: { id: e.id },
        data: { metadata: { tags: ["a"], sourceStale: true, typespecMigration: { status: "FLAGGED" } } },
      });
      await prisma.$executeRawUnsafe(WRITE_BACK_SOURCE_SQL, e.id, "model Stale {}");
      expect(await prisma.entity.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({
        typespecSource: "model Stale {}",
        metadata: { tags: ["a"] },
      });

      // Clearing an entity with NULL metadata is a harmless no-op.
      await prisma.entity.update({ where: { id: e.id }, data: { metadata: Prisma.DbNull } });
      await prisma.$executeRawUnsafe(CLEAR_SOURCE_STALE_SQL, e.id);
      expect(await meta()).toBeNull();
    } finally {
      if (domainId) await prisma.domain.deleteMany({ where: { id: domainId } });
    }
  });
});
