import "dotenv/config"; // first: @/lib/db (pulled in by entity.service) reads DB_PROVIDER at import time
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { deleteEntity } from "@/services/entity.service";
import { cleanupDomains, connectTestDb, createProductScope, TENANT, testContext } from "./helpers";

let prisma: PrismaClient;
let ctx: ServiceContext;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
});
afterAll(async () => prisma.$disconnect());

describe("deleting an entity that a library trait or an event pins (DB)", () => {
  it("returns IN_USE naming the trait and the event that pin it, and deletes nothing", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const level = { tenantId: TENANT, domainId: sc.domain.id, productId: sc.product.id };
      const order = await sc.publishedEntity("Order");
      const other = await sc.publishedEntity("Other");

      // A library trait whose headers pin holds Order (a NO ACTION foreign key).
      const trait = await prisma.trait.create({
        data: { tenantId: TENANT, domainId: sc.domain.id, kind: "MESSAGE", name: `CloudEvents-${sc.s}`, headersEntityId: order.entity.id, headersEntityVersionId: order.version.id },
      });
      // An event whose message payload is pinned to Order@1.0 (no foreign key: the event guard is what stops the delete).
      const event = await prisma.eventSpec.create({
        data: {
          ...level, name: `checkout-${sc.s}`,
          document: {
            documentVersion: 2, info: { title: "checkout" }, servers: [], channels: [], externalRefs: [], operations: [], traits: [],
            messages: [{ key: "order-created", payload: { entityId: order.entity.id, entityVersionId: order.version.id }, traitKeys: [] }],
          },
        },
      });
      await prisma.schemaReference.create({
        data: { fromKind: "EVENT_SPEC", fromId: event.id, role: "PAYLOAD", toKind: "ENTITY_VERSION", toId: order.version.id, isDraft: true },
      });

      const blocked = await deleteEntity(order.entity.id, ctx);
      expect(blocked.success).toBe(false);
      if (blocked.success) throw new Error("unreachable");
      expect(blocked.error.code).toBe("IN_USE");
      expect(blocked.error.message).toBe(
        `Entity "Order" cannot be deleted: it is used by Trait "${trait.name}", and it is pinned by event ${event.name} (${sc.domain.name}/${sc.product.name}).`
      );
      expect(blocked.error.details).toMatchObject({
        traits: [{ id: trait.id, name: trait.name }],
        entities: [], // no other entity's published version references Order
        events: { referrers: [{ eventId: event.id, name: event.name, draft: true, published: false, referencedVersions: ["1.0"] }], truncated: false },
      });
      expect(await prisma.entity.count({ where: { id: order.entity.id } })).toBe(1);
      expect(await prisma.entityVersion.count({ where: { entityId: order.entity.id } })).toBe(1);

      // An entity nothing pins is not reported as in use.
      const free = await deleteEntity(other.entity.id, ctx);
      expect(free.success).toBe(true);
      expect(await prisma.entity.count({ where: { id: other.entity.id } })).toBe(0);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 60_000);
});
