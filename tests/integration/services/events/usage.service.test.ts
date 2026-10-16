import "dotenv/config"; // first: @/lib/db (pulled in by the services) reads DB_PROVIDER at import time
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { findUsages } from "@/services/events/usage.service";
import { createForeignTenantFixture } from "./foreign-tenant-fixture";
import { cleanupDomains, connectTestDb, createEventSpecVersion, createProductScope, TENANT, testContext, unwrap } from "./helpers";

let prisma: PrismaClient;
let ctx: ServiceContext;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
});
afterAll(async () => prisma.$disconnect());

type Scope = Awaited<ReturnType<typeof createProductScope>>;

/**
 * `publishEntity` writes an immutable audit row into the shared dev DB per call, so the versions here are inserted
 * directly: `findUsages` reads only `EntityVersion` identity (major / minor) and the edge table.
 */
async function seedEntity(sc: Scope, name: string) {
  const entity = await sc.entity(name);
  const version = await prisma.entityVersion.create({
    data: { entityId: entity.id, major: 1, minor: 0, sequence: 1, resolvedSource: entity.typespecSource ?? "", fieldSnapshot: [], changeKind: "INITIAL", publishedById: ctx.userId },
  });
  await prisma.entity.update({ where: { id: entity.id }, data: { latestVersionId: version.id } });
  return { entity, version };
}

/** An event of the scope whose draft pins `entityVersionId`, optionally with a published version that pins it too. */
async function seedEvent(sc: Scope, name: string, entityVersionId: string, published = true) {
  const event = await prisma.eventSpec.create({
    data: { name, document: { documentVersion: 2, info: { title: name } }, tenantId: TENANT, domainId: sc.domain.id, productId: sc.product.id },
  });
  await prisma.schemaReference.create({ data: { fromKind: "EVENT_SPEC", fromId: event.id, role: "PAYLOAD", toKind: "ENTITY_VERSION", toId: entityVersionId, isDraft: true } });
  if (published) {
    const version = await createEventSpecVersion(prisma, {
      eventSpecId: event.id, major: 2, minor: 0, sequence: 1, document: {}, sourceDocument: {}, frozenTraits: [],
      resolvedSpec: { documentVersion: 2 }, changeKind: "INITIAL", publishedById: ctx.userId,
    });
    await prisma.schemaReference.create({ data: { fromKind: "EVENT_SPEC_VERSION", fromId: version.id, role: "PAYLOAD", toKind: "ENTITY_VERSION", toId: entityVersionId, isDraft: false } });
  }
  return event;
}

const summary = (rows: Array<{ label: string; isDraft: boolean; target: string }>) => rows.map((u) => [u.label, u.isDraft, u.target]);

describe("findUsages", () => {
  it("lists published uses before drafts for an entity and links them to the event page", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const order = await seedEntity(sc, "Order");
      const event = await seedEvent(sc, `checkout-${sc.s}`, order.version.id);

      const entityUses = unwrap(await findUsages({ kind: "entity", entityId: order.entity.id }, ctx, TENANT));
      expect(summary(entityUses)).toEqual([
        [`Event ${event.name} v2.0`, false, "Order v1.0"],
        [`Event ${event.name} (draft)`, true, "Order v1.0"],
      ]);
      expect(entityUses.map((u) => u.role)).toEqual(["PAYLOAD", "PAYLOAD"]);
      expect(entityUses.map((u) => u.fromKind)).toEqual(["EVENT_SPEC_VERSION", "EVENT_SPEC"]);
      expect(entityUses.every((u) => u.href === `/schemas/${sc.domain.slug}/${sc.product.slug}/events/${event.id}`)).toBe(true);

      const missing = await findUsages({ kind: "entity", entityId: "nope" }, ctx, TENANT);
      expect(!missing.success && missing.error.code).toBe("NOT_FOUND");
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("returns [] for an entity that was never published (no versions to reference)", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const draftOnly = await sc.entity("Draft");
      expect(unwrap(await findUsages({ kind: "entity", entityId: draftOnly.id }, ctx, TENANT))).toEqual([]);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("shows other products' referrers (read-only, linked to their own product) and library traits", async () => {
    const domainIds: Array<string | undefined> = [];
    const traitIds: string[] = [];
    try {
      const checkout = await createProductScope(prisma, ctx);
      const fraud = await createProductScope(prisma, ctx, "fraud");
      domainIds.push(checkout.domain.id, fraud.domain.id);
      const order = await seedEntity(checkout, "Order");
      // Fraud's event pins Checkout's Order (cross-product pins are allowed inside a tenant); only its draft does.
      const fraudEvent = await seedEvent(fraud, `order-seen-${fraud.s}`, order.version.id, false);
      // A domain-level library trait whose headers pin holds Order.
      const trait = await prisma.trait.create({
        data: { tenantId: TENANT, domainId: checkout.domain.id, kind: "MESSAGE", name: `Headers-${checkout.s}`, headersEntityId: order.entity.id, headersEntityVersionId: order.version.id },
      });
      traitIds.push(trait.id);
      await prisma.schemaReference.create({ data: { fromKind: "TRAIT", fromId: trait.id, role: "HEADERS", toKind: "ENTITY_VERSION", toId: order.version.id } });

      const uses = unwrap(await findUsages({ kind: "entity", entityId: order.entity.id }, ctx, TENANT));
      expect(summary(uses)).toEqual([
        [`Trait ${trait.name}`, false, "Order v1.0"],
        [`Event ${fraudEvent.name} (draft)`, true, "Order v1.0"],
      ]);
      expect(uses[1].href).toBe(`/schemas/${fraud.domain.slug}/${fraud.product.slug}/events/${fraudEvent.id}`);
      expect(uses[0].href).toBe(`/schemas/${checkout.domain.slug}?tab=traits`);
    } finally {
      await prisma.schemaReference.deleteMany({ where: { fromKind: "TRAIT", fromId: { in: traitIds } } });
      await prisma.trait.deleteMany({ where: { id: { in: traitIds } } });
      await cleanupDomains(prisma, domainIds);
    }
  });

  it("is tenant-scoped: a foreign tenant's subject is NOT_FOUND and its referrers never appear", async () => {
    let domainId: string | undefined;
    let foreign: Awaited<ReturnType<typeof createForeignTenantFixture>> | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      foreign = await createForeignTenantFixture(prisma, ctx);
      const order = await seedEntity(sc, "Order");
      const mine = await seedEvent(sc, `mine-${sc.s}`, order.version.id, false);

      // Subjects of another tenant look exactly like missing ones, whichever tenant the caller is in.
      const foreignEntity = await findUsages({ kind: "entity", entityId: foreign.entity.id }, ctx, TENANT);
      expect(!foreignEntity.success && foreignEntity.error.code).toBe("NOT_FOUND");
      const fromTheOtherSide = await findUsages({ kind: "entity", entityId: order.entity.id }, ctx, foreign.tenant.id);
      expect(!fromTheOtherSide.success && fromTheOtherSide.error.code).toBe("NOT_FOUND");
      // The foreign tenant's own view of its own entity works (the scope is the tenant, not a hard-coded one).
      const foreignEvent = await prisma.eventSpec.create({
        data: { name: `foreign-event-${foreign.s}`, document: { documentVersion: 2, info: { title: "f" } }, tenantId: foreign.tenant.id, domainId: foreign.domain.id, productId: foreign.product.id },
      });
      await prisma.schemaReference.create({
        data: { fromKind: "EVENT_SPEC", fromId: foreignEvent.id, role: "PAYLOAD", toKind: "ENTITY_VERSION", toId: foreign.version.id, isDraft: true },
      });
      expect(summary(unwrap(await findUsages({ kind: "entity", entityId: foreign.entity.id }, ctx, foreign.tenant.id)))).toEqual([
        [`Event ${foreignEvent.name} (draft)`, true, "Foreign v1.0"],
      ]);

      // An edge written across the tenant boundary (should be impossible through the services) is dropped, not
      // shown and not rendered as a "(deleted)" ghost either — the foreign id never reaches the caller.
      await prisma.schemaReference.create({
        data: { fromKind: "EVENT_SPEC", fromId: foreignEvent.id, role: "PAYLOAD", toKind: "ENTITY_VERSION", toId: order.version.id, isDraft: true },
      });
      const uses = unwrap(await findUsages({ kind: "entity", entityId: order.entity.id }, ctx, TENANT));
      expect(summary(uses)).toEqual([[`Event ${mine.name} (draft)`, true, "Order v1.0"]]);
      expect(JSON.stringify(uses)).not.toContain(foreignEvent.id);
      expect(JSON.stringify(uses)).not.toContain(foreignEvent.name);
      await prisma.schemaReference.deleteMany({ where: { fromId: foreignEvent.id } });
    } finally {
      await cleanupDomains(prisma, [domainId]);
      await foreign?.cleanup();
    }
  });

  it("tolerates ghost referrers (sources that no longer exist) without crashing", async () => {
    let domainId: string | undefined;
    const ghostIds: string[] = [];
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const address = await seedEntity(sc, "Address");
      // Deleting an entity now removes the edges from its versions (20261017 trigger), so such a ghost can only come
      // from rows that predate the trigger or were written without a source row: insert it directly.
      const fieldEdge = await prisma.schemaReference.create({
        data: { fromKind: "ENTITY_VERSION", fromId: `gone-entity-version-${sc.s}`, role: "FIELD", toKind: "ENTITY_VERSION", toId: address.version.id },
      });
      ghostIds.push(fieldEdge.id);
      // An event-side ghost whose source row was removed behind the triggers' back.
      const eventGhost = await prisma.schemaReference.create({
        data: { fromKind: "EVENT_SPEC_VERSION", fromId: `gone-${sc.s}`, role: "PAYLOAD", toKind: "ENTITY_VERSION", toId: address.version.id },
      });
      ghostIds.push(eventGhost.id);

      const uses = unwrap(await findUsages({ kind: "entity", entityId: address.entity.id }, ctx, TENANT));
      expect(summary(uses).sort()).toEqual(
        [
          [`Entity version gone-entity-version-${sc.s} (deleted)`, false, "Address v1.0"],
          [`Event version gone-${sc.s} (deleted)`, false, "Address v1.0"],
        ].sort(),
      );
      expect(uses.every((u) => u.href === null)).toBe(true);
    } finally {
      await prisma.schemaReference.deleteMany({ where: { id: { in: ghostIds } } });
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("leaves no ghost when a referring entity is deleted: ENTITY_VERSION-sourced edges follow their versions", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const address = await seedEntity(sc, "Address");
      const customer = await seedEntity(sc, "Customer");
      const other = await seedEntity(sc, "Other");
      // Customer v1.0 and Other v1.0 reference Address v1.0 (FIELD edges); only Customer is deleted.
      for (const referrer of [customer, other]) {
        await prisma.schemaReference.create({
          data: { fromKind: "ENTITY_VERSION", fromId: referrer.version.id, role: "FIELD", toKind: "ENTITY_VERSION", toId: address.version.id },
        });
      }
      expect(summary(unwrap(await findUsages({ kind: "entity", entityId: address.entity.id }, ctx, TENANT))).sort()).toEqual(
        [
          ["Entity Customer v1.0", false, "Address v1.0"],
          ["Entity Other v1.0", false, "Address v1.0"],
        ].sort(),
      );

      await prisma.entity.delete({ where: { id: customer.entity.id } });

      // The edge is gone from the table, so "Who uses Address?" lists only the surviving referrer: no "(deleted)" ghost.
      expect(await prisma.schemaReference.count({ where: { fromKind: "ENTITY_VERSION", fromId: customer.version.id } })).toBe(0);
      expect(summary(unwrap(await findUsages({ kind: "entity", entityId: address.entity.id }, ctx, TENANT)))).toEqual([
        ["Entity Other v1.0", false, "Address v1.0"],
      ]);
      expect(await prisma.schemaReference.count({ where: { fromKind: "ENTITY_VERSION", fromId: other.version.id } })).toBe(1);

      // Removing the whole domain cascades the remaining entities and takes their edges along (no helper clean-up here:
      // cleanupDomains would delete the edges itself and prove nothing).
      await prisma.domain.delete({ where: { id: domainId } });
      domainId = undefined;
      expect(await prisma.schemaReference.count({ where: { fromKind: "ENTITY_VERSION", fromId: { in: [address.version.id, other.version.id] } } })).toBe(0);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("rejects malformed subjects (the retired message subject too) without touching the database", async () => {
    for (const bad of [null, {}, { kind: "entity" }, { kind: "message", messageId: "m1" }, { kind: "entity", entityId: "" }]) {
      const r = await findUsages(bad as never, ctx, TENANT);
      expect(!r.success && r.error.code).toBe("VALIDATION_ERROR");
    }
    const noTenant = await findUsages({ kind: "entity", entityId: "e1" }, ctx, "");
    expect(!noTenant.success && noTenant.error.code).toBe("VALIDATION_ERROR");
  });

  it("maps an unexpected database failure to a DB_ERROR Result instead of throwing", async () => {
    const broken = { ...ctx, prisma: { entity: { findFirst: () => Promise.reject(new Error("connection lost")) } } as unknown as PrismaClient };
    const r = await findUsages({ kind: "entity", entityId: "e1" }, broken, TENANT);
    expect(!r.success && r.error.code).toBe("DB_ERROR");
  });
});
