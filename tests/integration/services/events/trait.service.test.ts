import "dotenv/config"; // first: @/lib/db (pulled in by the service via withAudit) reads DB_PROVIDER at import time
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { publishEntity } from "@/services/entity-version.service";
import { createTrait, deleteTrait, getTrait, updateTrait } from "@/services/events/trait.service";
import { cleanupDomains, cleanupTenantTraits, connectTestDb, createProductScope, TENANT, testContext, unwrap } from "./helpers";
import { createForeignTenant } from "./foreign-tenant";

let prisma: PrismaClient;
let ctx: ServiceContext;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
});
afterAll(async () => prisma.$disconnect());

describe("trait service", () => {
  it("creates tenant / domain traits, pins MESSAGE headers (default latest) and mirrors the pin in SchemaReference", async () => {
    let domainId: string | undefined;
    const tenantTraits: string[] = [];
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const headers = await sc.publishedEntity("CloudEventsHeaders");

      const tenantTrait = unwrap(
        await createTrait({ level: "TENANT", tenantId: TENANT }, { name: `CloudEvents-${sc.s}`, kind: "MESSAGE", headers: { entityId: headers.entity.id } }, ctx)
      );
      tenantTraits.push(tenantTrait.id);
      expect(tenantTrait).toMatchObject({ domainId: null, productId: null, headers: { entityId: headers.entity.id, entityVersionId: headers.version.id } });
      const refs = await prisma.schemaReference.findMany({ where: { fromKind: "TRAIT", fromId: tenantTrait.id } });
      expect(refs.map((r) => [r.role, r.toKind, r.toId, r.isDraft])).toEqual([["HEADERS", "ENTITY_VERSION", headers.version.id, false]]);

      const tenantOwner = { level: "TENANT" as const, tenantId: TENANT };
      const cleared = unwrap(await updateTrait(tenantTrait.id, { name: tenantTrait.name, spec: { summary: "CE" }, headers: null }, tenantOwner, ctx));
      expect(cleared).toMatchObject({ headers: null, spec: { summary: "CE" } });
      expect(await prisma.schemaReference.count({ where: { fromKind: "TRAIT", fromId: tenantTrait.id } })).toBe(0);

      const op = unwrap(await createTrait({ level: "DOMAIN", domainId: sc.domain.id }, { name: `Retry-${sc.s}`, kind: "OPERATION", spec: { summary: "r" } }, ctx));
      expect(op).toMatchObject({ kind: "OPERATION", domainId: sc.domain.id, productId: null });
      const badHeaders = await createTrait({ level: "DOMAIN", domainId: sc.domain.id }, { name: `Bad-${sc.s}`, kind: "OPERATION", headers: { entityId: headers.entity.id } }, ctx);
      expect(!badHeaders.success && badHeaders.error.code).toBe("VALIDATION_ERROR");

      const wrongOwner = await deleteTrait(op.id, tenantOwner, ctx);
      expect(!wrongOwner.success && wrongOwner.error.code).toBe("FORBIDDEN");
      expect(unwrap(await deleteTrait(op.id, { level: "DOMAIN", domainId: sc.domain.id }, ctx))).toEqual({ id: op.id });
    } finally {
      await cleanupTenantTraits(prisma, tenantTraits);
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("re-pins headers on update (explicit older version, omitted = latest, null = unpinned) and rejects bad pins without changing the trait", async () => {
    let domainId: string | undefined;
    let foreign: Awaited<ReturnType<typeof createForeignTenant>> | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      foreign = await createForeignTenant(prisma, ctx);
      const owner = { level: "DOMAIN" as const, domainId: sc.domain.id };
      const headers = await sc.publishedEntity(`Headers${sc.s}`);
      await prisma.entity.update({ where: { id: headers.entity.id }, data: { description: "second version", hasUnpublishedChanges: true } });
      const v2 = unwrap(await publishEntity(headers.entity.id, {}, ctx));
      const v1 = headers.version;
      expect(v2.id).not.toBe(v1.id);
      const entityId = headers.entity.id;

      const trait = unwrap(await createTrait(owner, { name: `Pinned-${sc.s}`, kind: "MESSAGE", headers: { entityId } }, ctx));
      const edges = async () =>
        (await prisma.schemaReference.findMany({ where: { fromKind: "TRAIT", fromId: trait.id } })).map((r) => [r.role, r.toKind, r.toId, r.isDraft]);
      expect(trait.headers).toEqual({ entityId, entityVersionId: v2.id }); // omitted version = latest published
      expect(await edges()).toEqual([["HEADERS", "ENTITY_VERSION", v2.id, false]]);

      const older = unwrap(await updateTrait(trait.id, { name: trait.name, headers: { entityId, entityVersionId: v1.id } }, owner, ctx));
      expect(older.headers).toEqual({ entityId, entityVersionId: v1.id });
      expect(await edges()).toEqual([["HEADERS", "ENTITY_VERSION", v1.id, false]]);

      const latest = unwrap(await updateTrait(trait.id, { name: trait.name, headers: { entityId } }, owner, ctx));
      expect(latest.headers).toEqual({ entityId, entityVersionId: v2.id });
      expect(await edges()).toEqual([["HEADERS", "ENTITY_VERSION", v2.id, false]]);

      // an explicit null version keeps the entity but unpins it (draft preview only); no edge is written
      const unpinned = unwrap(await updateTrait(trait.id, { name: trait.name, headers: { entityId, entityVersionId: null } }, owner, ctx));
      expect(unpinned.headers).toEqual({ entityId, entityVersionId: null });
      expect(await edges()).toEqual([]);

      // a never-published entity with the version omitted is accepted unpinned (D5: "latest published" = none)
      const draftOnly = await sc.entity(`DraftOnly${sc.s}`);
      const draftPin = unwrap(await updateTrait(trait.id, { name: trait.name, headers: { entityId: draftOnly.id } }, owner, ctx));
      expect(draftPin.headers).toEqual({ entityId: draftOnly.id, entityVersionId: null });
      expect(await edges()).toEqual([]);

      // restore a real pin, then every bad pin must fail and leave it untouched
      const pinned = unwrap(await updateTrait(trait.id, { name: trait.name, headers: { entityId, entityVersionId: v1.id } }, owner, ctx));
      const bad: Array<[string, { entityId: string; entityVersionId?: string | null }]> = [
        ["entity from another tenant", { entityId: foreign.entity.id }],
        ["unknown entity", { entityId: "nope" }],
        ["version of another entity", { entityId: foreign.entity.id, entityVersionId: v1.id }],
        ["explicit version on an entity with no published version", { entityId: draftOnly.id, entityVersionId: v1.id }],
        ["unknown version id", { entityId, entityVersionId: "nope" }],
      ];
      for (const [label, headersPin] of bad) {
        const r = await updateTrait(trait.id, { name: trait.name, headers: headersPin }, owner, ctx);
        expect(!r.success && r.error.code, label).toBe("VALIDATION_ERROR");
      }
      expect(unwrap(await getTrait(trait.id, ctx))).toEqual(pinned);
      expect(await edges()).toEqual([["HEADERS", "ENTITY_VERSION", v1.id, false]]);

      // the same checks apply on create
      const createBad = await createTrait(owner, { name: `Other-${sc.s}`, kind: "MESSAGE", headers: { entityId: foreign.entity.id } }, ctx);
      expect(!createBad.success && createBad.error.code).toBe("VALIDATION_ERROR");
      expect(await prisma.trait.count({ where: { name: `Other-${sc.s}` } })).toBe(0);
    } finally {
      await cleanupDomains(prisma, [domainId]);
      await foreign?.cleanup();
    }
  });

  it("updateTrait is a full replace: omitted spec resets to {}, omitted headers unpins; kind and level columns are preserved", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const owner = { level: "DOMAIN" as const, domainId: sc.domain.id };
      const headers = await sc.publishedEntity(`Headers${sc.s}`);
      const trait = unwrap(
        await createTrait(owner, { name: `Full-${sc.s}`, kind: "MESSAGE", spec: { summary: "keep?", tags: [{ name: "x" }] }, headers: { entityId: headers.entity.id } }, ctx)
      );
      expect(trait).toMatchObject({ spec: { summary: "keep?" }, headers: { entityId: headers.entity.id, entityVersionId: headers.version.id } });

      // a `kind` in the input is ignored (immutable)
      const replaced = unwrap(await updateTrait(trait.id, { name: trait.name, kind: "OPERATION" } as never, owner, ctx));
      expect(replaced).toEqual({
        id: trait.id, name: trait.name, kind: "MESSAGE", spec: {}, headers: null,
        tenantId: TENANT, domainId: sc.domain.id, productId: null,
      });
      expect(await prisma.schemaReference.count({ where: { fromKind: "TRAIT", fromId: trait.id } })).toBe(0);
      expect(unwrap(await getTrait(trait.id, ctx))).toEqual(replaced);

      // an OPERATION trait cannot take headers on update either
      const op = unwrap(await createTrait(owner, { name: `Op-${sc.s}`, kind: "OPERATION" }, ctx));
      const withHeaders = await updateTrait(op.id, { name: op.name, headers: { entityId: headers.entity.id } }, owner, ctx);
      expect(!withHeaders.success && withHeaders.error.code).toBe("VALIDATION_ERROR");
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("line-unique names: cross-kind clashes on create and rename are NAME_CONFLICT; a failed write changes nothing", async () => {
    let domainId: string | undefined;
    const tenantTraits: string[] = [];
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const owner = { level: "DOMAIN" as const, domainId: sc.domain.id };
      const productOwner = { level: "PRODUCT" as const, productId: sc.product.id };
      await sc.entity(`Order${sc.s}`); // product-level entity: the domain is its ancestor, so the line is shared

      const clashEntity = await createTrait(owner, { name: `order${sc.s}`, kind: "MESSAGE" }, ctx);
      expect(!clashEntity.success && clashEntity.error.code).toBe("NAME_CONFLICT");

      const tenantClash = await createTrait({ level: "TENANT", tenantId: TENANT }, { name: `ORDER${sc.s}`, kind: "OPERATION" }, ctx);
      if (tenantClash.success) tenantTraits.push(tenantClash.data.id);
      expect(!tenantClash.success && tenantClash.error.code).toBe("NAME_CONFLICT");

      const a = unwrap(await createTrait(owner, { name: `A-${sc.s}`, kind: "MESSAGE", spec: { summary: "original" } }, ctx));
      const dupSameLevel = await createTrait(owner, { name: `a-${sc.s}`, kind: "OPERATION" }, ctx);
      expect(!dupSameLevel.success && dupSameLevel.error.code).toBe("NAME_CONFLICT");
      const dupBelow = await createTrait(productOwner, { name: `A-${sc.s}`, kind: "MESSAGE" }, ctx);
      expect(!dupBelow.success && dupBelow.error.code).toBe("NAME_CONFLICT");

      const rename = await updateTrait(a.id, { name: `ORDER${sc.s}`, spec: { summary: "changed" } }, owner, ctx);
      expect(!rename.success && rename.error.code).toBe("NAME_CONFLICT");
      expect(unwrap(await getTrait(a.id, ctx))).toMatchObject({ name: `A-${sc.s}`, spec: { summary: "original" } });

      expect(unwrap(await updateTrait(a.id, { name: `a-${sc.s}`, spec: { summary: "original" } }, owner, ctx)).name).toBe(`a-${sc.s}`);
    } finally {
      await cleanupTenantTraits(prisma, tenantTraits);
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("audits successful trait writes and writes nothing for a failed one", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const owner = { level: "DOMAIN" as const, domainId: sc.domain.id };
      await sc.entity(`Taken${sc.s}`);
      const countByName = (n: string) => prisma.auditLog.count({ where: { entityType: "Trait", afterState: { path: ["name"], equals: n } } });

      const trait = unwrap(await createTrait(owner, { name: `Audit-${sc.s}`, kind: "MESSAGE" }, ctx));
      const createRows = await prisma.auditLog.findMany({ where: { entityType: "Trait", action: "CREATE", afterState: { path: ["id"], equals: trait.id } } });
      expect(createRows).toHaveLength(1);
      expect(createRows[0]).toMatchObject({ userId: ctx.userId, entityId: "pending" });

      const takenName = `taken${sc.s}`;
      const failedCreate = await createTrait(owner, { name: takenName, kind: "MESSAGE" }, ctx);
      expect(!failedCreate.success && failedCreate.error.code).toBe("NAME_CONFLICT");
      expect(await countByName(takenName)).toBe(0);

      const updateRows = () => prisma.auditLog.findMany({ where: { entityType: "Trait", action: "UPDATE", entityId: trait.id } });
      expect(await updateRows()).toHaveLength(0);
      const renamed = unwrap(await updateTrait(trait.id, { name: `Renamed-${sc.s}`, spec: { summary: "s" } }, owner, ctx));
      const rows = await updateRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ userId: ctx.userId });
      expect(rows[0].beforeState).toMatchObject({ name: `Audit-${sc.s}`, spec: {} });
      expect(rows[0].afterState).toMatchObject({ name: renamed.name, spec: { summary: "s" } });

      const failedRename = await updateTrait(trait.id, { name: takenName }, owner, ctx);
      expect(!failedRename.success && failedRename.error.code).toBe("NAME_CONFLICT");
      const wrongOwner = await updateTrait(trait.id, { name: `Nope-${sc.s}` }, { level: "TENANT", tenantId: TENANT }, ctx);
      expect(!wrongOwner.success && wrongOwner.error.code).toBe("FORBIDDEN");
      expect(await updateRows()).toHaveLength(1);

      unwrap(await deleteTrait(trait.id, owner, ctx));
      const deleteRows = () => prisma.auditLog.count({ where: { entityType: "Trait", action: "DELETE", entityId: trait.id } });
      expect(await deleteRows()).toBe(1);
      const again = await deleteTrait(trait.id, owner, ctx);
      expect(!again.success && again.error.code).toBe("NOT_FOUND");
      expect(await deleteRows()).toBe(1);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });
});
