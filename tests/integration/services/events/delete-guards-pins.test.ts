import "dotenv/config"; // first: @/lib/db (pulled in by the services) reads DB_PROVIDER at import time
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";

const { access } = vi.hoisted(() => ({ access: { userId: "" } }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { id: access.userId } })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { deleteEntityAction } from "@/app/(dashboard)/schemas/[domainSlug]/actions";
import { deleteEntity } from "@/services/entity.service";
import { deleteChannel } from "@/services/events/channel.service";
import { deleteMessage } from "@/services/events/message.service";
import { deleteTrait } from "@/services/events/trait.service";
import { createForeignTenantFixture } from "./foreign-tenant-fixture";
import { cleanupDomains, connectTestDb, createProductScope, TENANT, testContext } from "./helpers";

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
const ownerOf = (sc: Scope) => ({ level: "PRODUCT" as const, productId: sc.product.id });

function failure<T>(r: { success: boolean; data?: T; error?: { code: string; message: string; details?: object; suggestedFix?: string } }) {
  if (r.success || !r.error) throw new Error("expected a failure");
  return r.error;
}

// ── entity -> entity FIELD pins (A-I1 / B-I3) ────────────────────────────────────────────────────

/** An entity with directly inserted published versions (no publish audit rows). */
async function entityWithVersions(sc: Scope, name: string, labels: Array<[number, number]> = [[1, 0]]) {
  const entity = await sc.entity(name);
  const versions = [];
  let sequence = 1;
  for (const [major, minor] of labels) {
    versions.push(
      await prisma.entityVersion.create({
        data: {
          entityId: entity.id, major, minor, sequence: sequence++, resolvedSource: entity.typespecSource ?? "", fieldSnapshot: [],
          changeKind: "INITIAL", publishedById: ctx.userId,
        },
      })
    );
  }
  return { entity, versions };
}

/** The edge a publish writes for a reference field: ENTITY_VERSION (referrer) -> ENTITY_VERSION (referenced), role FIELD. */
const fieldEdge = (fromId: string, toId: string) =>
  prisma.schemaReference.create({ data: { fromKind: "ENTITY_VERSION", fromId, role: "FIELD", toKind: "ENTITY_VERSION", toId, isDraft: false } });

const entityExists = async (id: string) => (await prisma.entity.count({ where: { id } })) === 1;

describe("entity delete guard: published versions of other entities that reference it", () => {
  it("blocks the service delete, names the referrer + versions, keeps everything, and frees it once the referrer is gone", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx, "epin");
      domainId = sc.domain.id;
      const money = await entityWithVersions(sc, "Money", [[1, 0], [2, 0]]);
      const order = await entityWithVersions(sc, "Order", [[1, 0], [1, 1]]);
      await fieldEdge(order.versions[0].id, money.versions[1].id); // Order 1.0 pins Money 2.0
      await fieldEdge(order.versions[1].id, money.versions[1].id); // Order 1.1 too

      const blocked = failure(await deleteEntity(money.entity.id, ctx));
      expect(blocked.code).toBe("IN_USE");
      expect(blocked.message).toBe('Entity "Money" cannot be deleted: it is referenced by published versions of Entity "Order" (v1.0, v1.1).');
      expect(blocked.suggestedFix).toContain('delete the referencing entities first ("Order"');
      expect(blocked.details).toEqual({ messages: [], traits: [], entities: [{ id: order.entity.id, name: "Order", versions: ["1.0", "1.1"] }] });
      // Nothing was deleted: not the entity, not its versions, not the dangling-edge candidates.
      expect(await entityExists(money.entity.id)).toBe(true);
      expect(await prisma.entityVersion.count({ where: { entityId: money.entity.id } })).toBe(2);
      expect(await prisma.schemaReference.count({ where: { toKind: "ENTITY_VERSION", toId: money.versions[1].id } })).toBe(2);
      expect(await prisma.auditLog.count({ where: { entityType: "Entity", action: "DELETE", entityId: money.entity.id } })).toBe(0);

      // The referrer itself is not referenced, so it can go; its edges go with its versions (H1 trigger) ...
      expect((await deleteEntity(order.entity.id, ctx)).success).toBe(true);
      expect(await prisma.schemaReference.count({ where: { toKind: "ENTITY_VERSION", toId: money.versions[1].id } })).toBe(0);
      // ... and now the referenced entity can be deleted too.
      expect((await deleteEntity(money.entity.id, ctx)).success).toBe(true);
      expect(await entityExists(money.entity.id)).toBe(false);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 60_000);

  it("blocks deleteEntityAction the same way (before the delete, with the remedy in the text) and deletes after the referrer is removed", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx, "epin");
      domainId = sc.domain.id;
      const money = await entityWithVersions(sc, "Money");
      const order = await entityWithVersions(sc, "Order");
      await fieldEdge(order.versions[0].id, money.versions[0].id);

      const blocked = await deleteEntityAction(money.entity.id);
      expect(blocked).toEqual({ error: expect.stringContaining('Entity "Money" cannot be deleted: it is referenced by published versions of Entity "Order" (v1.0).') });
      expect((blocked as { error: string }).error).toContain("Published versions cannot be changed");
      expect(await entityExists(money.entity.id)).toBe(true);
      expect(await prisma.auditLog.count({ where: { entityType: "Entity", action: "DELETE", entityId: money.entity.id } })).toBe(0);

      expect(await deleteEntityAction(order.entity.id)).toEqual({ success: true });
      expect(await deleteEntityAction(money.entity.id)).toEqual({ success: true });
      expect(await entityExists(money.entity.id)).toBe(false);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 60_000);

  it("does not block on a recursive entity: its own versions referencing each other go away with it", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx, "epin");
      domainId = sc.domain.id;
      const tree = await entityWithVersions(sc, "Tree", [[1, 0], [2, 0]]);
      await fieldEdge(tree.versions[1].id, tree.versions[0].id); // Tree 2.0 -> Tree 1.0
      await fieldEdge(tree.versions[1].id, tree.versions[1].id); // and itself

      expect((await deleteEntity(tree.entity.id, ctx)).success).toBe(true);
      expect(await entityExists(tree.entity.id)).toBe(false);

      const again = await entityWithVersions(sc, "Tree2", [[1, 0], [2, 0]]);
      await fieldEdge(again.versions[1].id, again.versions[0].id);
      expect(await deleteEntityAction(again.entity.id)).toEqual({ success: true });
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 60_000);

  it("a referrer in another product or domain of the same tenant blocks too", async () => {
    const domains: string[] = [];
    try {
      const owner = await createProductScope(prisma, ctx, "epin");
      const consumer = await createProductScope(prisma, ctx, "epin");
      domains.push(owner.domain.id, consumer.domain.id);
      const money = await entityWithVersions(owner, "Money");
      const cart = await entityWithVersions(consumer, "Cart");
      await fieldEdge(cart.versions[0].id, money.versions[0].id);

      const blocked = failure(await deleteEntity(money.entity.id, ctx));
      expect(blocked.code).toBe("IN_USE");
      expect(blocked.message).toContain('Entity "Cart" (v1.0)');
    } finally {
      await cleanupDomains(prisma, domains);
    }
  }, 60_000);

  it("never names another tenant's entity: a corrupt cross-tenant edge neither blocks nor leaks, a same-tenant one is named alone", async () => {
    const domains: string[] = [];
    let foreign: Awaited<ReturnType<typeof createForeignTenantFixture>> | undefined;
    try {
      const sc = await createProductScope(prisma, ctx, "epin");
      domains.push(sc.domain.id);
      foreign = await createForeignTenantFixture(prisma, ctx);
      const money = await entityWithVersions(sc, "Money");
      const order = await entityWithVersions(sc, "Order");
      await fieldEdge(foreign.version.id, money.versions[0].id); // the foreign tenant's "Foreign" entity pins Money
      await fieldEdge(order.versions[0].id, money.versions[0].id);

      const blocked = failure(await deleteEntity(money.entity.id, ctx));
      expect(blocked.message).toContain('Entity "Order" (v1.0)');
      expect(blocked.message).not.toContain("Foreign");
      expect(JSON.stringify(blocked.details)).not.toContain(foreign.entity.id);
      const viaAction = (await deleteEntityAction(money.entity.id)) as { error: string };
      expect(viaAction.error).not.toContain("Foreign");

      // Only the foreign edge left: nothing of this tenant references it, so it is not blocked (and nothing is named).
      expect((await deleteEntity(order.entity.id, ctx)).success).toBe(true);
      expect((await deleteEntity(money.entity.id, ctx)).success).toBe(true);
    } finally {
      await foreign?.cleanup();
      await cleanupDomains(prisma, domains);
    }
  }, 60_000);

  it("deletes an entity nothing references (the guard does not over-block), including one that only references others", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx, "epin");
      domainId = sc.domain.id;
      const money = await entityWithVersions(sc, "Money");
      const order = await entityWithVersions(sc, "Order");
      await fieldEdge(order.versions[0].id, money.versions[0].id);
      const lonely = await entityWithVersions(sc, "Lonely");
      const unversioned = await sc.entity("Draft");

      expect((await deleteEntity(order.entity.id, ctx)).success).toBe(true); // references Money, nothing references Order
      expect((await deleteEntity(lonely.entity.id, ctx)).success).toBe(true);
      expect(await deleteEntityAction(unversioned.id)).toEqual({ success: true });
      expect((await deleteEntity(money.entity.id, ctx)).success).toBe(true);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 60_000);
});

// ── seeded Events assets (rows inserted directly: publishing would leave undeletable audit rows) ──

async function seedMessage(sc: Scope, label: string, spec: object = {}) {
  const { entity, versions } = await entityWithVersions(sc, `Payload${label}`);
  const message = await prisma.message.create({
    data: { name: `Msg${label}-${sc.s}`, spec, payloadEntityId: entity.id, payloadEntityVersionId: versions[0].id, ...placed(sc) },
  });
  return { message, entity, version: versions[0] };
}

/** A published message version whose frozen `resolvedSpec.spec.traitIds` is `traitIds` (the real MessageResolvedSpec shape). */
async function publishMessageVersion(m: Awaited<ReturnType<typeof seedMessage>>, traitIds: string[], label: [number, number] = [1, 0], sequence = 1) {
  const resolvedSpec = {
    name: m.message.name,
    spec: { traitIds },
    payload: { entityId: m.entity.id, entityName: m.entity.name, entityVersionId: m.version.id, label: "1.0", major: 1 },
    headers: null,
    key: null,
  };
  return prisma.messageVersion.create({
    data: {
      messageId: m.message.id, major: label[0], minor: label[1], sequence, resolvedSpec, payloadEntityVersionId: m.version.id,
      changeKind: "INITIAL", publishedById: ctx.userId,
    },
  });
}

const draftDocument = (op: { channelId: string; traitIds?: string[]; reply?: { channelId?: string } }) => ({
  info: { title: "Spec" },
  servers: [],
  operations: [{ key: "send-op", action: "send", messageVersionIds: [], traitIds: [], ...op }],
});

async function seedSpec(sc: Scope, name: string, document: object = {}, tenantId: string = TENANT) {
  return prisma.eventSpec.create({ data: { name: `${name}-${sc.s}`, document, ...placed(sc), tenantId } });
}

async function publishSpecVersion(
  specId: string,
  pins: { frozenChannels?: string[]; frozenTraits?: string[]; messageVersionIds?: string[]; edgeTo?: string[] } = {},
  label: [number, number] = [1, 0],
  sequence = 1
) {
  const version = await prisma.eventSpecVersion.create({
    data: {
      eventSpecId: specId, major: label[0], minor: label[1], sequence, document: {}, sourceDocument: {},
      frozenChannels: (pins.frozenChannels ?? []).map((id) => ({ id, name: "frozen" })),
      frozenTraits: (pins.frozenTraits ?? []).map((id) => ({ id, name: "frozen" })),
      messageVersionIds: pins.messageVersionIds ?? [],
      changeKind: "INITIAL", publishedById: ctx.userId,
    },
  });
  if (pins.edgeTo?.length) {
    await prisma.schemaReference.createMany({
      data: pins.edgeTo.map((toId) => ({ fromKind: "EVENT_SPEC_VERSION" as const, fromId: version.id, role: "MESSAGE" as const, toKind: "MESSAGE_VERSION" as const, toId, isDraft: false })),
    });
  }
  return version;
}

const traitExists = async (id: string) => (await prisma.trait.count({ where: { id } })) === 1;
const channelExists = async (id: string) => (await prisma.channel.count({ where: { id } })) === 1;
const newTrait = (sc: Scope, name: string) => prisma.trait.create({ data: { name: `${name}-${sc.s}`, kind: "MESSAGE", ...placed(sc) } });
const newChannel = (sc: Scope, name: string) =>
  prisma.channel.create({ data: { name: `${name}-${sc.s}`, address: "orders.v1", protocol: "kafka", format: "avro", ...placed(sc) } });

describe("trait delete guard (B-I2)", () => {
  it("blocks while a PUBLISHED message version carries it (even with no draft reference), names message + version, then frees it with the message", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx, "tin");
      domainId = sc.domain.id;
      const trait = await newTrait(sc, "CloudEvents");
      const m = await seedMessage(sc, "A"); // draft spec {} carries no trait: only the published version does
      await publishMessageVersion(m, [trait.id]);
      await publishMessageVersion(m, [trait.id], [1, 1], 2);

      const blocked = failure(await deleteTrait(trait.id, ownerOf(sc), ctx));
      expect(blocked.code).toBe("IN_USE");
      expect(blocked.message).toBe(`Trait "${trait.name}" cannot be deleted: it is used by Message "${m.message.name}" (v1.0, v1.1).`);
      expect(blocked.suggestedFix).toContain(`delete message "${m.message.name}"`);
      expect(blocked.details).toMatchObject({ referrers: [{ kind: "Message", id: m.message.id, versions: ["1.0", "1.1"], draft: false }], truncated: false });
      expect(await traitExists(trait.id)).toBe(true);
      expect(await prisma.auditLog.count({ where: { entityType: "Trait", action: "DELETE", entityId: trait.id } })).toBe(0);

      // Deleting the message removes its immutable versions; the trait is no longer carried by anything.
      expect((await deleteMessage(m.message.id, ownerOf(sc), ctx)).success).toBe(true);
      expect((await deleteTrait(trait.id, ownerOf(sc), ctx)).success).toBe(true);
      expect(await traitExists(trait.id)).toBe(false);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 60_000);

  it("blocks while a published event spec version froze it, in another product too", async () => {
    const domains: string[] = [];
    try {
      const owner = await createProductScope(prisma, ctx, "tin");
      const consumer = await createProductScope(prisma, ctx, "tin");
      domains.push(owner.domain.id, consumer.domain.id);
      const trait = await newTrait(owner, "Retry");
      const spec = await seedSpec(consumer, "feed");
      await publishSpecVersion(spec.id, { frozenTraits: [trait.id] });
      await publishSpecVersion(spec.id, { frozenTraits: [trait.id] }, [2, 0], 2);

      const blocked = failure(await deleteTrait(trait.id, ownerOf(owner), ctx));
      expect(blocked.code).toBe("IN_USE");
      expect(blocked.message).toBe(`Trait "${trait.name}" cannot be deleted: it is used by Event spec "${spec.name}" (v1.0, v2.0).`);
      expect(await traitExists(trait.id)).toBe(true);

      await prisma.eventSpec.delete({ where: { id: spec.id } }); // its versions cascade
      expect((await deleteTrait(trait.id, ownerOf(owner), ctx)).success).toBe(true);
    } finally {
      await cleanupDomains(prisma, domains);
    }
  }, 60_000);

  it("blocks while a live message draft or an event spec draft references it, naming them as drafts", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx, "tin");
      domainId = sc.domain.id;
      const trait = await newTrait(sc, "Auditable");
      const channel = await newChannel(sc, "orders");
      const draftMessage = await seedMessage(sc, "D", { traitIds: ["other-trait", trait.id] });
      const draftSpec = await seedSpec(sc, "draft-spec", draftDocument({ channelId: channel.id, traitIds: [trait.id, "other"] }));
      // Unrelated drafts that must not match (a different trait id, the trait id used as a CHANNEL id).
      await seedMessage(sc, "E", { traitIds: ["not-it"] });
      await seedSpec(sc, "other-spec", draftDocument({ channelId: trait.id, traitIds: ["not-it"] }));

      const blocked = failure(await deleteTrait(trait.id, ownerOf(sc), ctx));
      expect(blocked.code).toBe("IN_USE");
      expect(blocked.message).toBe(
        `Trait "${trait.name}" cannot be deleted: it is used by Message "${draftMessage.message.name}" (draft) and Event spec "${draftSpec.name}" (draft).`
      );
      expect(blocked.suggestedFix).toContain("Remove the trait from the drafts listed first");
      expect(await traitExists(trait.id)).toBe(true);

      // Repair the drafts: the delete goes through.
      await prisma.message.update({ where: { id: draftMessage.message.id }, data: { spec: { traitIds: [] } } });
      await prisma.eventSpec.update({ where: { id: draftSpec.id }, data: { document: draftDocument({ channelId: channel.id }) } });
      expect((await deleteTrait(trait.id, ownerOf(sc), ctx)).success).toBe(true);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 60_000);

  it("caps the named referrers", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx, "tin");
      domainId = sc.domain.id;
      const trait = await newTrait(sc, "Popular");
      for (const label of ["A", "B", "C", "D", "E", "F", "G"]) await seedMessage(sc, label, { traitIds: [trait.id] });

      const blocked = failure(await deleteTrait(trait.id, ownerOf(sc), ctx));
      expect(blocked.message).toMatch(/^Trait ".+" cannot be deleted: it is used by Messages (".+" \(draft\), ){4}".+" \(draft\), and 2 more\.$/);
      expect((blocked.details as { referrers: unknown[] }).referrers).toHaveLength(7);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 60_000);

  it("never names another tenant's messages / specs; deletes an unreferenced trait; tenant-wide scan sees other products", async () => {
    const domains: string[] = [];
    let foreign: Awaited<ReturnType<typeof createForeignTenantFixture>> | undefined;
    try {
      const sc = await createProductScope(prisma, ctx, "tin");
      domains.push(sc.domain.id);
      foreign = await createForeignTenantFixture(prisma, ctx);
      const trait = await newTrait(sc, "Shared");

      // Corrupt cross-tenant data: the foreign tenant's published message version, spec version and drafts carry the trait id.
      const foreignMessage = await prisma.message.findFirstOrThrow({ where: { id: foreign.message.id } });
      await prisma.messageVersion.create({
        data: {
          messageId: foreignMessage.id, major: 1, minor: 1, sequence: 2, resolvedSpec: { name: "x", spec: { traitIds: [trait.id] } },
          payloadEntityVersionId: foreign.version.id, changeKind: "MINOR", publishedById: ctx.userId,
        },
      });
      await prisma.message.update({ where: { id: foreignMessage.id }, data: { spec: { traitIds: [trait.id] } } });
      const foreignSpec = await prisma.eventSpec.create({
        data: {
          name: `foreign-spec-${foreign.s}`, document: draftDocument({ channelId: foreign.channel.id, traitIds: [trait.id] }),
          tenantId: foreign.tenant.id, domainId: foreign.domain.id, productId: foreign.product.id,
        },
      });
      await publishSpecVersion(foreignSpec.id, { frozenTraits: [trait.id] });

      // Nothing of this tenant uses the trait: the foreign rows neither block nor appear anywhere.
      expect((await deleteTrait(trait.id, ownerOf(sc), ctx)).success).toBe(true);

      // With a same-tenant user present, only that one is named.
      const second = await newTrait(sc, "Shared2");
      await prisma.message.update({ where: { id: foreignMessage.id }, data: { spec: { traitIds: [second.id] } } });
      const local = await seedMessage(sc, "L", { traitIds: [second.id] });
      const blocked = failure(await deleteTrait(second.id, ownerOf(sc), ctx));
      expect(blocked.message).toBe(`Trait "${second.name}" cannot be deleted: it is used by Message "${local.message.name}" (draft).`);
      expect(blocked.message).not.toContain(foreignMessage.name);
      expect(JSON.stringify(blocked.details)).not.toContain(foreignMessage.id);
    } finally {
      await foreign?.cleanup();
      await cleanupDomains(prisma, domains);
    }
  }, 90_000);
});

describe("channel delete guard (B-I2)", () => {
  it("blocks while a published spec version froze it, in the SAME product too (no other-product restriction), then frees it with the spec", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx, "cin");
      domainId = sc.domain.id;
      const channel = await newChannel(sc, "orders");
      const spec = await seedSpec(sc, "orders-feed");
      await publishSpecVersion(spec.id, { frozenChannels: [channel.id] });

      const blocked = failure(await deleteChannel(channel.id, ownerOf(sc), ctx));
      expect(blocked.code).toBe("IN_USE");
      expect(blocked.message).toBe(`Channel "${channel.name}" cannot be deleted: it is used by Event spec "${spec.name}" (v1.0).`);
      expect(blocked.suggestedFix).toContain(`delete event spec "${spec.name}"`);
      expect(await channelExists(channel.id)).toBe(true);
      expect(await prisma.auditLog.count({ where: { entityType: "Channel", action: "DELETE", entityId: channel.id } })).toBe(0);

      await prisma.eventSpec.delete({ where: { id: spec.id } });
      expect((await deleteChannel(channel.id, ownerOf(sc), ctx)).success).toBe(true);
      expect(await channelExists(channel.id)).toBe(false);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 60_000);

  it("blocks for a frozen channel of another product's spec in the tenant, naming the versions", async () => {
    const domains: string[] = [];
    try {
      const owner = await createProductScope(prisma, ctx, "cin");
      const consumer = await createProductScope(prisma, ctx, "cin");
      domains.push(owner.domain.id, consumer.domain.id);
      const channel = await newChannel(owner, "orders");
      const spec = await seedSpec(consumer, "consumer");
      await publishSpecVersion(spec.id, { frozenChannels: [channel.id] });
      await publishSpecVersion(spec.id, { frozenChannels: [channel.id] }, [1, 1], 2);

      const blocked = failure(await deleteChannel(channel.id, ownerOf(owner), ctx));
      expect(blocked.message).toBe(`Channel "${channel.name}" cannot be deleted: it is used by Event spec "${spec.name}" (v1.0, v1.1).`);
    } finally {
      await cleanupDomains(prisma, domains);
    }
  }, 60_000);

  it("blocks while a live spec draft uses it as an operation channel or a reply channel, and ignores an unrelated id", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx, "cin");
      domainId = sc.domain.id;
      const channel = await newChannel(sc, "orders");
      const replies = await newChannel(sc, "replies");
      const other = await newChannel(sc, "other");
      const direct = await seedSpec(sc, "direct", draftDocument({ channelId: channel.id }));
      const viaReply = await seedSpec(sc, "via-reply", draftDocument({ channelId: other.id, reply: { channelId: replies.id } }));

      const blocked = failure(await deleteChannel(channel.id, ownerOf(sc), ctx));
      expect(blocked.message).toBe(`Channel "${channel.name}" cannot be deleted: it is used by Event spec "${direct.name}" (draft).`);
      expect(blocked.suggestedFix).toContain('Remove the channel from "');

      const replyBlocked = failure(await deleteChannel(replies.id, ownerOf(sc), ctx));
      expect(replyBlocked.message).toBe(`Channel "${replies.name}" cannot be deleted: it is used by Event spec "${viaReply.name}" (draft).`);
      expect(await channelExists(channel.id)).toBe(true);
      expect(await channelExists(replies.id)).toBe(true);

      await prisma.eventSpec.update({ where: { id: direct.id }, data: { document: draftDocument({ channelId: other.id }) } });
      expect((await deleteChannel(channel.id, ownerOf(sc), ctx)).success).toBe(true);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 60_000);

  it("deletes an unreferenced channel together with its allowed-message rows (cascade is not a reference)", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx, "cin");
      domainId = sc.domain.id;
      const channel = await newChannel(sc, "orders");
      const m = await seedMessage(sc, "M");
      await prisma.channelMessage.create({ data: { channelId: channel.id, messageId: m.message.id } });
      // A spec that uses a different channel does not hold this one.
      const other = await newChannel(sc, "other");
      await seedSpec(sc, "spec", draftDocument({ channelId: other.id }));

      expect((await deleteChannel(channel.id, ownerOf(sc), ctx)).success).toBe(true);
      expect(await prisma.channelMessage.count({ where: { channelId: channel.id } })).toBe(0);
      expect(await prisma.message.count({ where: { id: m.message.id } })).toBe(1);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 60_000);

  it("never names another tenant's spec: a corrupt cross-tenant frozen channel / draft neither blocks nor leaks", async () => {
    const domains: string[] = [];
    let foreign: Awaited<ReturnType<typeof createForeignTenantFixture>> | undefined;
    try {
      const sc = await createProductScope(prisma, ctx, "cin");
      domains.push(sc.domain.id);
      foreign = await createForeignTenantFixture(prisma, ctx);
      const channel = await newChannel(sc, "orders");
      const foreignSpec = await prisma.eventSpec.create({
        data: {
          name: `foreign-spec-${foreign.s}`, document: draftDocument({ channelId: channel.id }),
          tenantId: foreign.tenant.id, domainId: foreign.domain.id, productId: foreign.product.id,
        },
      });
      await publishSpecVersion(foreignSpec.id, { frozenChannels: [channel.id] });

      const second = await newChannel(sc, "second");
      const local = await seedSpec(sc, "local", draftDocument({ channelId: second.id }));
      await prisma.eventSpec.update({ where: { id: foreignSpec.id }, data: { document: draftDocument({ channelId: second.id }) } });
      await publishSpecVersion(foreignSpec.id, { frozenChannels: [second.id] }, [1, 1], 2);
      const blocked = failure(await deleteChannel(second.id, ownerOf(sc), ctx));
      expect(blocked.message).toBe(`Channel "${second.name}" cannot be deleted: it is used by Event spec "${local.name}" (draft).`);
      expect(blocked.message).not.toContain(foreignSpec.name);
      expect(JSON.stringify(blocked.details)).not.toContain(foreignSpec.id);

      // The first channel is referenced only by the foreign tenant's rows: not blocked.
      expect((await deleteChannel(channel.id, ownerOf(sc), ctx)).success).toBe(true);
    } finally {
      await foreign?.cleanup();
      await cleanupDomains(prisma, domains);
    }
  }, 90_000);
});

describe("deleteMessage: a pin recorded in only ONE place still blocks (findPublishedPins unconditional)", () => {
  it.each([
    ["the messageVersionIds array alone (no schema_references edge)", "array"],
    ["a non-draft EVENT_SPEC_VERSION edge alone (array empty)", "edge"],
    ["both places", "both"],
  ] as const)("is IN_USE naming the spec and version for %s", async (_label, where) => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx, "mpin");
      domainId = sc.domain.id;
      const m = await seedMessage(sc, "P");
      const mv = await publishMessageVersion(m, []);
      const spec = await seedSpec(sc, "pinner");
      await publishSpecVersion(spec.id, {
        messageVersionIds: where === "edge" ? [] : [mv.id],
        edgeTo: where === "array" ? [] : [mv.id],
      });

      const blocked = failure(await deleteMessage(m.message.id, ownerOf(sc), ctx));
      expect(blocked.code).toBe("IN_USE");
      expect(blocked.message).toContain(`"${spec.name}" (1.0)`);
      expect(await prisma.message.count({ where: { id: m.message.id } })).toBe(1);
      expect(await prisma.messageVersion.count({ where: { messageId: m.message.id } })).toBe(1);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 60_000);

  it("still deletes a message nothing pins", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx, "mpin");
      domainId = sc.domain.id;
      const m = await seedMessage(sc, "Free");
      await publishMessageVersion(m, []);
      const spec = await seedSpec(sc, "other");
      await publishSpecVersion(spec.id, { messageVersionIds: ["some-other-version"] });
      expect((await deleteMessage(m.message.id, ownerOf(sc), ctx)).success).toBe(true);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 60_000);
});
