import "dotenv/config"; // first: @/lib/db (pulled in by load-options) reads DB_PROVIDER at import time
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import {
  loadChannelOptions,
  loadEntityOptions,
  loadMessageOptions,
  loadMessageRefOptions,
  loadPinnableVersions,
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

type Own = Awaited<ReturnType<typeof createProductScope>>;
type Foreign = Awaited<ReturnType<typeof createForeignTenant>>;

interface Fixture {
  own: Own;
  /** A second product line in the same tenant. */
  other: Own;
  /** A whole other tenant with its own domain / product / entity / message. */
  foreign: Foreign;
  /** Tenant-level traits created by the test; deleted in `finally`. */
  tenantTraits: string[];
}

/** Builds the scopes, runs one test body, and always removes everything (edges, domain cascades, foreign tenant). */
async function withFixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const domainIds: string[] = [];
  const tenantTraits: string[] = [];
  let foreign: Foreign | undefined;
  try {
    const own = await createProductScope(prisma, ctx, "lo");
    const other = await createProductScope(prisma, ctx, "lp");
    domainIds.push(own.domain.id, other.domain.id);
    foreign = await createForeignTenant(prisma, ctx);
    await run({ own, other, foreign, tenantTraits });
  } finally {
    await cleanupTenantTraits(prisma, tenantTraits);
    await cleanupDomains(prisma, domainIds);
    await foreign?.cleanup();
  }
}

const ownerOf = (s: Own) => `${s.domain.name} / ${s.product.name}`;

/** Option loaders feed the Wave 5 pickers: every one is tenant-scoped, whatever product / scope id the caller passes. */
describe("event option loaders (tenant scoping)", () => {
  it("loadEntityOptions: owner labels and latest version, own tenant only", () =>
    withFixture(async ({ own, foreign }) => {
      const published = await own.publishedEntity(`Order${own.s}`);
      const draft = await own.entity(`Draft${own.s}`);
      const entities = await loadEntityOptions(TENANT);
      const mine = (id: string) => entities.find((e) => e.id === id);
      expect(mine(published.entity.id)).toMatchObject({
        name: `Order${own.s}`, ownerLabel: ownerOf(own), latestVersionId: published.version.id, latestVersionLabel: "1.0",
      });
      expect(mine(draft.id)).toMatchObject({ latestVersionId: null, latestVersionLabel: null });
      expect(ids(entities)).not.toContain(foreign.entity.id);
      expect(ids(await loadEntityOptions(foreign.tenant.id))).toEqual([foreign.entity.id]);
    }), 60_000);

  it("loadEntityOptions: carries the format an entity was imported in (Avro / JSON Schema / Protobuf only)", () =>
    withFixture(async ({ own, foreign }) => {
      const avro = await own.entity(`Avro${own.s}`);
      const proto = await own.entity(`Proto${own.s}`);
      const json = await own.entity(`Json${own.s}`);
      const typespec = await own.entity(`Spec${own.s}`);
      const plain = await own.entity(`Plain${own.s}`);
      for (const [entity, sourceFormat] of [[avro, "avro"], [proto, "protobuf"], [json, "json-schema"], [typespec, "typespec"]] as const) {
        await prisma.entity.update({ where: { id: entity.id }, data: { metadata: { sourceFormat, tags: ["core"] } } });
      }
      await prisma.entity.update({ where: { id: foreign.entity.id }, data: { metadata: { sourceFormat: "avro" } } });

      const entities = await loadEntityOptions(TENANT);
      const mine = (id: string) => entities.find((e) => e.id === id);

      expect(mine(avro.id)?.sourceFormat).toBe("avro");
      expect(mine(proto.id)?.sourceFormat).toBe("protobuf");
      expect(mine(json.id)?.sourceFormat).toBe("json-schema");
      // an import format that is not a schema representation, or no record at all: the key is absent, not undefined
      expect(mine(typespec.id)).not.toHaveProperty("sourceFormat");
      expect(mine(plain.id)).not.toHaveProperty("sourceFormat");
      // the foreign tenant's entity is not in this tenant's list, whatever it records
      expect(ids(entities)).not.toContain(foreign.entity.id);
      expect((await loadEntityOptions(foreign.tenant.id)).find((e) => e.id === foreign.entity.id)?.sourceFormat).toBe("avro");
    }), 60_000);

  it("loadTraitOptions: Enterprise + domain + product line, filtered by kind, never another product's or tenant's", () =>
    withFixture(async ({ own, other, foreign, tenantTraits }) => {
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
      try {
        const scope = { tenantId: TENANT, domainId: own.domain.id, productId: own.product.id };
        const visible = await loadTraitOptions(scope, "MESSAGE");
        expect(ids(visible)).toEqual(expect.arrayContaining([tenantTrait.id, domainTrait.id, productTrait.id]));
        expect(ids(visible)).not.toContain(otherProductTrait.id);
        expect(ids(visible)).not.toContain(operationTrait.id);
        expect(ids(visible)).not.toContain(foreignTrait.id);
        expect(visible.find((t) => t.id === tenantTrait.id)?.ownerLabel).toBe("Enterprise");
        expect(visible.find((t) => t.id === domainTrait.id)?.ownerLabel).toBe(own.domain.name);
        expect(visible.find((t) => t.id === productTrait.id)?.ownerLabel).toBe(ownerOf(own));
        expect(ids(await loadTraitOptions(scope, "OPERATION"))).toContain(operationTrait.id);
        // Domain level sees Enterprise + the domain's own traits, not its products'.
        const domainOnly = await loadTraitOptions({ tenantId: TENANT, domainId: own.domain.id, productId: null }, "MESSAGE");
        expect(ids(domainOnly)).toEqual(expect.arrayContaining([tenantTrait.id, domainTrait.id]));
        expect(ids(domainOnly)).not.toContain(productTrait.id);
      } finally {
        await prisma.trait.deleteMany({ where: { id: foreignTrait.id } });
      }
    }), 60_000);

  it("loadTraitOptions: a forged scope with a foreign domain / product id sees none of the foreign records", () =>
    withFixture(async ({ own, foreign, tenantTraits }) => {
      const tenantTrait = await prisma.trait.create({ data: { name: `TT-${own.s}`, kind: "MESSAGE", tenantId: TENANT } });
      tenantTraits.push(tenantTrait.id);
      const foreignTrait = await prisma.trait.create({
        data: { name: `FT-${foreign.tenant.id}`, kind: "MESSAGE", tenantId: foreign.tenant.id, domainId: foreign.domain.id, productId: foreign.product.id },
      });
      try {
        const forged = await loadTraitOptions({ tenantId: TENANT, domainId: foreign.domain.id, productId: foreign.product.id }, "MESSAGE");
        expect(ids(forged)).not.toContain(foreignTrait.id);
        expect(ids(forged)).toContain(tenantTrait.id);
      } finally {
        await prisma.trait.deleteMany({ where: { id: foreignTrait.id } });
      }
    }), 60_000);

  it("loadChannelOptions: own product first, allowed message ids, owner labels", () =>
    withFixture(async ({ own, other }) => {
      const published = await own.publishedEntity(`Order${own.s}`);
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
      const channels = await loadChannelOptions(TENANT, own.product.id);
      expect(channels.find((c) => c.id === ownChannel.id)).toMatchObject({
        own: true, address: "orders", protocol: "kafka", format: "avro", allowedMessageIds: [message.id], ownerLabel: ownerOf(own),
      });
      expect(channels.find((c) => c.id === peerChannel.id)).toMatchObject({ own: false, address: null, allowedMessageIds: [] });
      // Own-product channels sort ahead of peers even though "aa-peer" sorts first by name.
      expect(channels.findIndex((c) => c.id === ownChannel.id)).toBeLessThan(channels.findIndex((c) => c.id === peerChannel.id));
    }), 60_000);

  it("loadChannelOptions: never returns another tenant's channels, even for a forged product id", () =>
    withFixture(async ({ own, foreign }) => {
      const foreignChannel = await prisma.channel.create({
        data: { name: `ff-${foreign.tenant.id}`, protocol: "kafka", format: "avro", tenantId: foreign.tenant.id, domainId: foreign.domain.id, productId: foreign.product.id },
      });
      expect(ids(await loadChannelOptions(TENANT, own.product.id))).not.toContain(foreignChannel.id);
      const forged = await loadChannelOptions(TENANT, foreign.product.id);
      expect(ids(forged)).not.toContain(foreignChannel.id);
      expect(forged.some((c) => c.own)).toBe(false);
    }), 60_000);

  it("loadMessageRefOptions: published versions (read-only across products) + own-product drafts only", () =>
    withFixture(async ({ own, other }) => {
      const published = await own.publishedEntity(`Order${own.s}`);
      const message = await prisma.message.create({
        data: { name: `Msg-${own.s}`, payloadEntityId: published.entity.id, tenantId: TENANT, domainId: own.domain.id, productId: own.product.id },
      });
      const version = await prisma.messageVersion.create({
        data: {
          messageId: message.id, major: 1, minor: 0, sequence: 1, resolvedSpec: {}, payloadEntityVersionId: published.version.id,
          changeKind: "INITIAL", publishedById: ctx.userId,
        },
      });
      const peerMessage = await prisma.message.create({
        data: { name: `Peer-${own.s}`, payloadEntityId: published.entity.id, tenantId: TENANT, domainId: other.domain.id, productId: other.product.id },
      });
      const refs = await loadMessageRefOptions(TENANT, own.product.id);
      expect(refs.find((r) => r.id === version.id)).toMatchObject({
        messageId: message.id, label: `Msg-${own.s} v1.0`, own: true, draft: false, ownerLabel: ownerOf(own),
      });
      expect(refs.find((r) => r.id === message.id)).toMatchObject({ draft: true, own: true, label: `Msg-${own.s} (draft — preview only)` });
      expect(ids(refs)).not.toContain(peerMessage.id); // another product's draft is not referenceable
      // From the peer product's point of view the first product's published version is referenceable, read-only.
      const fromPeer = await loadMessageRefOptions(TENANT, other.product.id);
      expect(fromPeer.find((r) => r.id === version.id)).toMatchObject({ own: false, draft: false });
      expect(ids(fromPeer)).not.toContain(message.id);
    }), 60_000);

  it("loadMessageRefOptions: nothing from another tenant, even for a forged product id", () =>
    withFixture(async ({ own, foreign }) => {
      const foreignEntityVersion = await prisma.entityVersion.create({
        data: {
          entityId: foreign.entity.id, major: 1, minor: 0, sequence: 1, changeKind: "INITIAL", publishedById: ctx.userId,
          resolvedSource: "model Foreign {}", fieldSnapshot: [],
        },
      });
      const foreignVersion = await prisma.messageVersion.create({
        data: {
          messageId: foreign.message.id, major: 1, minor: 0, sequence: 1, resolvedSpec: {}, payloadEntityVersionId: foreignEntityVersion.id,
          changeKind: "INITIAL", publishedById: ctx.userId,
        },
      });
      const refs = await loadMessageRefOptions(TENANT, own.product.id);
      expect(ids(refs)).not.toContain(foreignVersion.id);
      expect(ids(refs)).not.toContain(foreign.message.id);
      // A forged product id (a foreign product, under our tenant) surfaces neither its draft nor its versions.
      const forged = await loadMessageRefOptions(TENANT, foreign.product.id);
      expect(ids(forged)).not.toContain(foreign.message.id);
      expect(ids(forged)).not.toContain(foreignVersion.id);
      expect(forged.some((r) => r.draft)).toBe(false);
    }), 60_000);

  it("loadMessageOptions: own tenant's messages only", () =>
    withFixture(async ({ own, other, foreign }) => {
      const published = await own.publishedEntity(`Order${own.s}`);
      const mine = await prisma.message.create({
        data: { name: `Msg-${own.s}`, payloadEntityId: published.entity.id, tenantId: TENANT, domainId: own.domain.id, productId: own.product.id },
      });
      const peer = await prisma.message.create({
        data: { name: `Peer-${own.s}`, payloadEntityId: published.entity.id, tenantId: TENANT, domainId: other.domain.id, productId: other.product.id },
      });
      const messages = await loadMessageOptions(TENANT);
      expect(ids(messages)).toEqual(expect.arrayContaining([mine.id, peer.id]));
      expect(messages.find((m) => m.id === mine.id)?.ownerLabel).toBe(ownerOf(own));
      expect(ids(messages)).not.toContain(foreign.message.id);
      expect(ids(await loadMessageOptions(foreign.tenant.id))).toEqual([foreign.message.id]);
    }), 60_000);

  it("loadPinnableVersions: published versions newest first; another tenant's, unknown and malformed ids give null", () =>
    withFixture(async ({ own, foreign }) => {
      const published = await own.publishedEntity(`Order${own.s}`); // 1.0, sequence 1
      const second = await prisma.entityVersion.create({
        data: {
          entityId: published.entity.id, major: 1, minor: 1, sequence: 2, changeKind: "MINOR", publishedById: ctx.userId,
          resolvedSource: "model Order {}", fieldSnapshot: [],
        },
      });
      const draftOnly = await own.entity(`Draft${own.s}`);

      expect(await loadPinnableVersions(TENANT, published.entity.id)).toEqual([
        { id: second.id, label: "1.1" },
        { id: published.version.id, label: "1.0" },
      ]);
      expect(await loadPinnableVersions(TENANT, draftOnly.id)).toEqual([]);
      // The id is client-supplied: it only resolves inside the tenant the server derived.
      expect(await loadPinnableVersions(foreign.tenant.id, published.entity.id)).toBeNull();
      expect(await loadPinnableVersions(TENANT, foreign.entity.id)).toBeNull();
      expect(await loadPinnableVersions(TENANT, "no-such-entity")).toBeNull();
      expect(await loadPinnableVersions(TENANT, "")).toBeNull();
      expect(await loadPinnableVersions(TENANT, undefined as unknown as string)).toBeNull();
    }), 60_000);
});
