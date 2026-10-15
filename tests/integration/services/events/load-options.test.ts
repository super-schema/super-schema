import "dotenv/config"; // first: @/lib/db (pulled in by load-options) reads DB_PROVIDER at import time
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import {
  loadChannelOptions,
  loadEntityOptions,
  loadMessageOptions,
  loadMessageRefOptions,
  loadTraitOptions,
} from "@/features/events/load-options";
import { cleanupDomains, cleanupTenantTraits, connectTestDb, createProductScope, TENANT, testContext } from "./helpers";
import { createForeignTenant } from "./foreign-tenant";

let prisma: PrismaClient;
let ctx: ServiceContext;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
});
afterAll(async () => prisma.$disconnect());

const ids = <T extends { id: string }>(rows: T[]) => rows.map((r) => r.id);

/** Option loaders feed the Wave 5 pickers: every one is tenant-scoped, whatever product / scope id the caller passes. */
describe("event option loaders (tenant scoping)", () => {
  it("returns only the tenant's records, labelled by owner, and never a foreign tenant's — even for a forged product id", async () => {
    const domainIds: string[] = [];
    const tenantTraits: string[] = [];
    let foreign: Awaited<ReturnType<typeof createForeignTenant>> | undefined;
    try {
      const own = await createProductScope(prisma, ctx, "lo");
      const other = await createProductScope(prisma, ctx, "lp"); // second product line in the same tenant
      domainIds.push(own.domain.id, other.domain.id);
      foreign = await createForeignTenant(prisma, ctx);

      // --- entities -----------------------------------------------------------------------------
      const published = await own.publishedEntity(`Order${own.s}`);
      const draft = await own.entity(`Draft${own.s}`);
      const entities = await loadEntityOptions(TENANT);
      const mine = (id: string) => entities.find((e) => e.id === id);
      expect(mine(published.entity.id)).toMatchObject({
        name: `Order${own.s}`, ownerLabel: `${own.domain.name} / ${own.product.name}`,
        latestVersionId: published.version.id, latestVersionLabel: "1.0",
      });
      expect(mine(draft.id)).toMatchObject({ latestVersionId: null, latestVersionLabel: null });
      expect(ids(entities)).not.toContain(foreign.entity.id);
      expect(ids(await loadEntityOptions(foreign.tenant.id))).toEqual([foreign.entity.id]);

      // --- traits: Enterprise + domain + product line, filtered by kind --------------------------
      const tenantTrait = await prisma.trait.create({ data: { name: `TT-${own.s}`, kind: "MESSAGE", tenantId: TENANT } });
      tenantTraits.push(tenantTrait.id);
      const domainTrait = await prisma.trait.create({ data: { name: `DT-${own.s}`, kind: "MESSAGE", tenantId: TENANT, domainId: own.domain.id } });
      const productTrait = await prisma.trait.create({
        data: { name: `PT-${own.s}`, kind: "MESSAGE", tenantId: TENANT, domainId: own.domain.id, productId: own.product.id },
      });
      const otherProductTrait = await prisma.trait.create({
        data: { name: `OT-${own.s}`, kind: "MESSAGE", tenantId: TENANT, domainId: other.domain.id, productId: other.product.id },
      });
      const operationTrait = await prisma.trait.create({ data: { name: `OP-${own.s}`, kind: "OPERATION", tenantId: TENANT, domainId: own.domain.id } });
      const foreignTrait = await prisma.trait.create({
        data: { name: `FT-${foreign.tenant.id}`, kind: "MESSAGE", tenantId: foreign.tenant.id, domainId: foreign.domain.id, productId: foreign.product.id },
      });
      const productScope = { tenantId: TENANT, domainId: own.domain.id, productId: own.product.id };
      const visible = await loadTraitOptions(productScope, "MESSAGE");
      expect(ids(visible)).toEqual(expect.arrayContaining([tenantTrait.id, domainTrait.id, productTrait.id]));
      expect(ids(visible)).not.toContain(otherProductTrait.id);
      expect(ids(visible)).not.toContain(operationTrait.id);
      expect(ids(visible)).not.toContain(foreignTrait.id);
      expect(visible.find((t) => t.id === tenantTrait.id)?.ownerLabel).toBe("Enterprise");
      expect(visible.find((t) => t.id === domainTrait.id)?.ownerLabel).toBe(own.domain.name);
      expect(visible.find((t) => t.id === productTrait.id)?.ownerLabel).toBe(`${own.domain.name} / ${own.product.name}`);
      expect(ids(await loadTraitOptions(productScope, "OPERATION"))).toContain(operationTrait.id);
      // A forged scope carrying a foreign domain / product id under our tenant sees none of the foreign records.
      const forged = await loadTraitOptions({ tenantId: TENANT, domainId: foreign.domain.id, productId: foreign.product.id }, "MESSAGE");
      expect(ids(forged)).not.toContain(foreignTrait.id);
      expect(ids(forged)).toContain(tenantTrait.id);

      // --- channels: own product first, allowed message ids, no foreign tenant -------------------
      const message = await prisma.message.create({
        data: { name: `Msg-${own.s}`, payloadEntityId: published.entity.id, tenantId: TENANT, domainId: own.domain.id, productId: own.product.id },
      });
      const ownChannel = await prisma.channel.create({
        data: {
          name: `zz-own-${own.s}`, address: "orders", protocol: "kafka", format: "avro", tenantId: TENANT, domainId: own.domain.id, productId: own.product.id,
          messages: { create: [{ messageId: message.id }] },
        },
      });
      const peerChannel = await prisma.channel.create({
        data: { name: `aa-peer-${own.s}`, protocol: "amqp", format: "json-schema", tenantId: TENANT, domainId: other.domain.id, productId: other.product.id },
      });
      const foreignChannel = await prisma.channel.create({
        data: { name: `ff-${foreign.tenant.id}`, protocol: "kafka", format: "avro", tenantId: foreign.tenant.id, domainId: foreign.domain.id, productId: foreign.product.id },
      });
      const channels = await loadChannelOptions(TENANT, own.product.id);
      expect(ids(channels)).not.toContain(foreignChannel.id);
      expect(channels.find((c) => c.id === ownChannel.id)).toMatchObject({
        own: true, address: "orders", protocol: "kafka", format: "avro", allowedMessageIds: [message.id],
        ownerLabel: `${own.domain.name} / ${own.product.name}`,
      });
      expect(channels.find((c) => c.id === peerChannel.id)).toMatchObject({ own: false, address: null, allowedMessageIds: [] });
      // Own-product channels sort ahead of peers even though "aa-peer" sorts first by name.
      expect(channels.findIndex((c) => c.id === ownChannel.id)).toBeLessThan(channels.findIndex((c) => c.id === peerChannel.id));
      expect(ids(await loadChannelOptions(TENANT, foreign.product.id))).not.toContain(foreignChannel.id);

      // --- message refs: published versions (read-only across products) + own-product drafts ----
      const version = await prisma.messageVersion.create({
        data: {
          messageId: message.id, major: 1, minor: 0, sequence: 1, resolvedSpec: {}, payloadEntityVersionId: published.version.id,
          changeKind: "INITIAL", publishedById: ctx.userId,
        },
      });
      const foreignVersion = await prisma.messageVersion.create({
        data: {
          messageId: foreign.message.id, major: 1, minor: 0, sequence: 1, resolvedSpec: {}, payloadEntityVersionId: (
            await prisma.entityVersion.create({
              data: {
                entityId: foreign.entity.id, major: 1, minor: 0, sequence: 1, changeKind: "INITIAL", publishedById: ctx.userId,
                resolvedSource: "model Foreign {}", fieldSnapshot: [],
              },
            })
          ).id,
          changeKind: "INITIAL", publishedById: ctx.userId,
        },
      });
      const peerMessage = await prisma.message.create({
        data: { name: `Peer-${own.s}`, payloadEntityId: published.entity.id, tenantId: TENANT, domainId: other.domain.id, productId: other.product.id },
      });
      const refs = await loadMessageRefOptions(TENANT, own.product.id);
      expect(refs.find((r) => r.id === version.id)).toMatchObject({
        messageId: message.id, label: `Msg-${own.s} v1.0`, own: true, draft: false,
      });
      expect(refs.find((r) => r.id === message.id)).toMatchObject({ draft: true, own: true, label: `Msg-${own.s} (draft — preview only)` });
      expect(ids(refs)).not.toContain(peerMessage.id); // another product's draft is not referenceable
      expect(ids(refs)).not.toContain(foreignVersion.id);
      expect(ids(refs)).not.toContain(foreign.message.id);
      // A forged product id (a foreign product, under our tenant) surfaces neither its draft nor its versions.
      const forgedRefs = await loadMessageRefOptions(TENANT, foreign.product.id);
      expect(ids(forgedRefs)).not.toContain(foreign.message.id);
      expect(ids(forgedRefs)).not.toContain(foreignVersion.id);
      expect(forgedRefs.some((r) => r.draft)).toBe(false);

      // --- messages ------------------------------------------------------------------------------
      const messages = await loadMessageOptions(TENANT);
      expect(ids(messages)).toEqual(expect.arrayContaining([message.id, peerMessage.id]));
      expect(ids(messages)).not.toContain(foreign.message.id);
      expect(ids(await loadMessageOptions(foreign.tenant.id))).toEqual([foreign.message.id]);

      await prisma.trait.deleteMany({ where: { id: foreignTrait.id } });
    } finally {
      await cleanupTenantTraits(prisma, tenantTraits);
      await cleanupDomains(prisma, domainIds);
      await foreign?.cleanup();
    }
  }, 60_000);
});
