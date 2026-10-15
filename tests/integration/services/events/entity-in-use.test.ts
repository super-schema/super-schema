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

describe("deleting an entity that events pin (DB)", () => {
  it("returns IN_USE naming the message, trait and message version that pin it, and deletes nothing", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const level = { tenantId: TENANT, domainId: sc.domain.id, productId: sc.product.id };
      const order = await sc.publishedEntity("Order");
      const audit = await sc.publishedEntity("Audit");
      const other = await sc.publishedEntity("Other");

      // Current pin: payload of a message.
      const direct = await prisma.message.create({
        data: { ...level, name: `OrderCreated-${sc.s}`, payloadEntityId: order.entity.id, payloadEntityVersionId: order.version.id },
      });
      // Historic pin only: the message now points at Audit, but a published version still pins Order@1.0.
      const historic = await prisma.message.create({
        data: { ...level, name: `OrderArchived-${sc.s}`, payloadEntityId: audit.entity.id, payloadEntityVersionId: audit.version.id },
      });
      await prisma.messageVersion.create({
        data: {
          messageId: historic.id, major: 1, minor: 0, sequence: 1, resolvedSpec: {},
          payloadEntityVersionId: order.version.id, changeKind: "INITIAL", publishedById: ctx.userId,
        },
      });
      const trait = await prisma.trait.create({
        data: { ...level, kind: "MESSAGE", name: `CloudEvents-${sc.s}`, headersEntityId: order.entity.id, headersEntityVersionId: order.version.id },
      });

      const blocked = await deleteEntity(order.entity.id, ctx);
      expect(blocked.success).toBe(false);
      if (blocked.success) throw new Error("unreachable");
      expect(blocked.error.code).toBe("IN_USE");
      expect(blocked.error.message).toBe(
        `Entity "Order" cannot be deleted: it is used by Messages "${historic.name}", "${direct.name}" and Trait "${trait.name}".`
      );
      expect(blocked.error.details).toEqual({
        // ordered by name: OrderArchived-… before OrderCreated-…
        messages: [historic, direct].map((m) => ({ id: m.id, name: m.name })),
        traits: [{ id: trait.id, name: trait.name }],
      });
      expect(await prisma.entity.count({ where: { id: order.entity.id } })).toBe(1);
      expect(await prisma.entityVersion.count({ where: { entityId: order.entity.id } })).toBe(1);

      // An entity nothing pins is not reported as in use (its delete is covered by entity.service unit tests).
      const free = await prisma.message.count({ where: { OR: [{ payloadEntityId: other.entity.id }, { headersEntityId: other.entity.id }, { keyEntityId: other.entity.id }] } });
      expect(free).toBe(0);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 60_000);
});
