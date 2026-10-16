import "dotenv/config"; // first: @/lib/db (pulled in by the services) reads DB_PROVIDER at import time
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";

const { access } = vi.hoisted(() => ({ access: { userId: "", isAdmin: true } }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "session-user", email: "admin@example.test" } })) }));
vi.mock("@/lib/access-control", () => ({ resolveGlobalAdminAccess: vi.fn(async () => ({ ...access })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// The actions scope every by-id row to the active tenant, which comes from a request cookie: pin it to the default tenant the fixtures use.
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: async () => "tenant_default" }));

import { deleteDomainAction } from "@/app/(dashboard)/schemas/actions";
import { deleteProduct } from "@/services/product.service";
import { createForeignTenantFixture } from "./foreign-tenant-fixture";
import { cleanupDomains, connectTestDb, createEventSpecVersion, createProductScope, TENANT, testContext } from "./helpers";

let prisma: PrismaClient;
let ctx: ServiceContext;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
  access.userId = ctx.userId;
});
afterAll(async () => prisma.$disconnect());

type Scope = Awaited<ReturnType<typeof createProductScope>>;
const placed = (sc: Scope) => ({ tenantId: TENANT, domainId: sc.domain.id, productId: sc.product.id });
const eventDocument = (title: string) => ({ documentVersion: 2, info: { title } });

const productExists = async (id: string) => (await prisma.product.count({ where: { id } })) === 1;
const domainExists = async (id: string) => (await prisma.domain.count({ where: { id } })) === 1;
const errorOf = async (id: string) => {
  const r = await deleteProduct(id, ctx);
  if (r.success) throw new Error("expected the delete to be blocked");
  return r.error;
};

/** An entity with a directly inserted published version, and an event of `sc` that pins it (draft edge + published version edge). */
async function seedPublishedEvent(sc: Scope, label: string, pinned?: { versionId: string }) {
  const entity = pinned ? undefined : await sc.entity(`Payload${label}`);
  const entityVersion = pinned
    ? undefined
    : await prisma.entityVersion.create({
        data: {
          entityId: entity!.id, major: 1, minor: 0, sequence: 1, resolvedSource: entity!.typespecSource ?? "", fieldSnapshot: [],
          changeKind: "INITIAL", publishedById: ctx.userId,
        },
      });
  const toId = pinned?.versionId ?? entityVersion!.id;
  const event = await prisma.eventSpec.create({ data: { name: `${label}-${sc.s}`, document: eventDocument(label), ...placed(sc) } });
  const version = await createEventSpecVersion(prisma, {
    eventSpecId: event.id, major: 1, minor: 0, sequence: 1, document: {}, sourceDocument: eventDocument(label), frozenTraits: [],
    resolvedSpec: eventDocument(label), changeKind: "INITIAL", publishedById: ctx.userId,
  });
  return { event, version, entity, entityVersionId: toId };
}

/** The edge a draft of `fromEvent` holds on a published version of another event (an external reference). */
const externalRef = (fromEventId: string, toVersionId: string, draft = true) =>
  prisma.schemaReference.create({
    data: { fromKind: draft ? "EVENT_SPEC" : "EVENT_SPEC_VERSION", fromId: fromEventId, role: "MESSAGE", toKind: "EVENT_SPEC_VERSION", toId: toVersionId, isDraft: draft },
  });

describe("product / domain delete guards: events and traits", () => {
  it("blocks the product delete on the events it owns, and the DB is untouched", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx, "evg");
      domainId = sc.domain.id;
      // The product's entity blocks too (long-standing rule); it is removed again below to isolate the events.
      const entity = await sc.entity("Order");
      await prisma.eventSpec.create({ data: { name: `s-${sc.s}`, document: eventDocument("one"), ...placed(sc) } });
      expect((await errorOf(sc.product.id)).message).toBe("Delete the product's 1 entity and 1 event before removing it");

      await prisma.entity.delete({ where: { id: entity.id } });
      await prisma.eventSpec.create({ data: { name: `s2-${sc.s}`, document: eventDocument("two"), ...placed(sc) } });
      const blocked = await errorOf(sc.product.id);
      expect(blocked.code).toBe("VALIDATION_ERROR");
      expect(blocked.message).toBe("Delete the product's 2 events before removing it");
      expect(blocked.message).not.toMatch(/foreign key|constraint|prisma/i);

      expect(await productExists(sc.product.id)).toBe(true);
      expect(await prisma.eventSpec.count({ where: { productId: sc.product.id } })).toBe(2);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 60_000);

  it("blocks the domain delete on a domain-level trait and on product-level events", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx, "evg");
      domainId = sc.domain.id;

      // Domain-level trait only: blocks the DOMAIN delete, and never counts for the product's own delete.
      await prisma.trait.create({ data: { name: `dt-${sc.s}`, kind: "OPERATION", tenantId: TENANT, domainId: sc.domain.id } });
      expect(await deleteDomainAction(sc.domain.id)).toEqual({
        error: "Cannot delete - 1 trait exists in this domain or its products. Move or delete it first.",
      });

      // Product-level events count at the domain too (they carry the domainId).
      await prisma.eventSpec.create({ data: { name: `s-${sc.s}`, document: eventDocument("one"), ...placed(sc) } });
      expect(await deleteDomainAction(sc.domain.id)).toEqual({
        error: "Cannot delete - 1 trait and 1 event exist in this domain or its products. Move or delete them first.",
      });
      expect(await domainExists(sc.domain.id)).toBe(true);
      expect(await productExists(sc.product.id)).toBe(true);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 60_000);

  it("deletes a product that owns nothing (the guard does not over-block)", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx, "evg");
      domainId = sc.domain.id;
      // A sibling product's event and a domain-level trait are not this product's.
      const sibling = await prisma.product.create({ data: { domainId: sc.domain.id, name: `sib ${sc.s}`, slug: `sib-${sc.s}` } });
      await prisma.trait.create({ data: { name: `dt-${sc.s}`, kind: "OPERATION", tenantId: TENANT, domainId: sc.domain.id } });
      await prisma.eventSpec.create({
        data: { name: `se-${sc.s}`, document: eventDocument("sibling"), tenantId: TENANT, domainId: sc.domain.id, productId: sibling.id },
      });

      const result = await deleteProduct(sc.product.id, ctx);
      expect(result).toEqual({ success: true, data: { id: sc.product.id } });
      expect(await productExists(sc.product.id)).toBe(false);
      expect(await productExists(sibling.id)).toBe(true);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 60_000);
});

describe("product / domain delete guards: references from other products' events", () => {
  async function twoProducts() {
    const owner = await createProductScope(prisma, ctx, "own");
    const consumer = await createProductScope(prisma, ctx, "con");
    return { owner, consumer, published: await seedPublishedEvent(owner, "payments") };
  }

  it("names the other product's event that references a published version of the owner's event, on the product delete", async () => {
    const domainIds: string[] = [];
    try {
      const { owner, consumer, published } = await twoProducts();
      domainIds.push(owner.domain.id, consumer.domain.id);
      const consuming = await seedPublishedEvent(consumer, "fraud", { versionId: published.entityVersionId });
      await externalRef(consuming.event.id, published.version.id);

      const blocked = await errorOf(owner.product.id);
      expect(blocked.code).toBe("VALIDATION_ERROR");
      expect(blocked.message).toBe(
        "Delete the product's 1 entity and 1 event before removing it. " +
          `Product "${owner.product.name}" cannot be deleted: other products' events reference its events: ${consuming.event.name} (${consumer.domain.name}/${consumer.product.name}).`
      );
      expect(blocked.details).toMatchObject({
        events: { truncated: false, referrers: [{ eventId: consuming.event.id, name: consuming.event.name, referencedVersions: ["1.0"], draft: true, published: false }] },
      });
      expect(await productExists(owner.product.id)).toBe(true);
    } finally {
      await cleanupDomains(prisma, domainIds);
    }
  }, 60_000);

  it("ignores the owner's own events and a reference that points at someone else's version", async () => {
    const domainIds: string[] = [];
    try {
      const { owner, consumer, published } = await twoProducts();
      domainIds.push(owner.domain.id, consumer.domain.id);
      // The owner's own second event references its first one (an event in the same product never blocks the product delete).
      const sibling = await seedPublishedEvent(owner, "ledger", { versionId: published.entityVersionId });
      await externalRef(sibling.event.id, published.version.id);
      // The consumer references only its own version.
      const own = await seedPublishedEvent(consumer, "fraud", { versionId: published.entityVersionId });
      await externalRef(own.event.id, own.version.id);

      const blocked = await errorOf(owner.product.id);
      expect(blocked.message).toBe("Delete the product's 1 entity and 2 events before removing it");
      expect(blocked.details).toBeUndefined();
    } finally {
      await cleanupDomains(prisma, domainIds);
    }
  }, 60_000);

  it("a sibling product in the same domain counts as another product; for the domain delete it does not", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx, "sib");
      domainId = sc.domain.id;
      const sibling = await prisma.product.create({ data: { domainId: sc.domain.id, name: `peer ${sc.s}`, slug: `peer-${sc.s}` } });
      const siblingScope = { ...sc, product: sibling } as Scope;
      const published = await seedPublishedEvent(sc, "payments");
      const consuming = await seedPublishedEvent(siblingScope, "fraud", { versionId: published.entityVersionId });
      await externalRef(consuming.version.id, published.version.id, false);

      expect((await errorOf(sc.product.id)).message).toContain(`other products' events reference its events: ${consuming.event.name}`);
      // Both events are inside the domain being deleted, so nothing outside it dangles: only the content counts block.
      const domainBlocked = await deleteDomainAction(sc.domain.id);
      expect(domainBlocked).toEqual({ error: "Cannot delete - 1 entity and 2 events exist in this domain or its products. Move or delete them first." });
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 60_000);

  it("never reads, counts or names another tenant's events", async () => {
    let foreign: Awaited<ReturnType<typeof createForeignTenantFixture>> | undefined;
    const domainIds: string[] = [];
    try {
      const { owner, published } = await twoProducts();
      domainIds.push(owner.domain.id);
      foreign = await createForeignTenantFixture(prisma, ctx);
      const foreignEvent = await prisma.eventSpec.create({
        data: { name: `foreign-${foreign.s}`, document: eventDocument("f"), tenantId: foreign.tenant.id, domainId: foreign.domain.id, productId: foreign.product.id },
      });
      // An edge written across the tenant boundary (impossible through the services) neither blocks nor leaks.
      await externalRef(foreignEvent.id, published.version.id);

      const blocked = await errorOf(owner.product.id);
      expect(blocked.message).toBe("Delete the product's 1 entity and 1 event before removing it");
      expect(JSON.stringify(blocked)).not.toContain(foreignEvent.name);
      await prisma.schemaReference.deleteMany({ where: { fromId: foreignEvent.id } });
    } finally {
      await cleanupDomains(prisma, domainIds);
      await foreign?.cleanup();
    }
  }, 60_000);
});
