import "dotenv/config"; // first: @/lib/db (pulled in by the services) reads DB_PROVIDER at import time
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { createEventSpec, updateEventSpecDocument } from "@/services/events/event-spec.service";
import { createMessage } from "@/services/events/message.service";
import { createForeignTenant } from "./foreign-tenant";
import { cleanupDomains, connectTestDb, createProductScope, TENANT, testContext, unwrap } from "./helpers";

let prisma: PrismaClient;
let ctx: ServiceContext;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
});
afterAll(async () => prisma.$disconnect());

type Scope = Awaited<ReturnType<typeof createProductScope>>;

async function seedChannel(sc: Scope, name: string) {
  return prisma.channel.create({
    data: { name: `${name}-${sc.s}`, address: `${name}.v1`, protocol: "kafka", format: "avro", tenantId: TENANT, domainId: sc.domain.id, productId: sc.product.id },
  });
}

/** A message with two published versions (1.0 and 1.1) pinning the same entity version. */
async function seedMessageWithVersions(sc: Scope) {
  const entity = await sc.publishedEntity("Order");
  const message = unwrap(await createMessage(sc.product.id, { name: `OrderCreated-${sc.s}`, payload: { entityId: entity.entity.id } }, ctx));
  const version = (major: number, minor: number, sequence: number) =>
    prisma.messageVersion.create({
      data: { messageId: message.id, major, minor, sequence, resolvedSpec: {}, payloadEntityVersionId: entity.version.id, changeKind: "INITIAL", publishedById: ctx.userId },
    });
  return { message, mv1: await version(1, 0, 1), mv2: await version(1, 1, 2) };
}

const specDoc = (operations: unknown[]) => ({ info: { title: "spec" }, servers: [], operations });
const problemsOf = (r: { success: boolean; error?: { details?: object } }) => (r.error?.details as { problems?: Array<{ pointer: string; message: string }> } | undefined)?.problems ?? [];
const edgeIds = (specId: string) =>
  prisma.schemaReference.findMany({ where: { fromKind: "EVENT_SPEC", fromId: specId } }).then((rows) => rows.map((r) => r.toId).sort());

describe("event spec service: edges, replies, traits, tenants", () => {
  it("replaces the mirrored EVENT_SPEC edges on every save, including reply message versions", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const owner = { level: "PRODUCT" as const, productId: sc.product.id };
      const channel = await seedChannel(sc, "orders");
      const { mv1, mv2 } = await seedMessageWithVersions(sc);
      const spec = unwrap(await createEventSpec(sc.product.id, { name: `edges-${sc.s}` }, ctx));
      const op = (extra: object = {}) => ({ key: "handle", action: "receive", channelId: channel.id, messageVersionIds: [mv1.id], traitIds: [], ...extra });

      unwrap(await updateEventSpecDocument(spec.id, specDoc([op()]), owner, ctx));
      expect(await edgeIds(spec.id)).toEqual([mv1.id]);

      // Second save swaps mv1 for mv2: the old edge must be gone, not accumulated.
      unwrap(await updateEventSpecDocument(spec.id, specDoc([op({ messageVersionIds: [mv2.id] })]), owner, ctx));
      expect(await edgeIds(spec.id)).toEqual([mv2.id]);

      // Reply message versions are edges too; duplicates collapse.
      unwrap(await updateEventSpecDocument(spec.id, specDoc([op({ messageVersionIds: [mv1.id], reply: { channelId: channel.id, messageVersionIds: [mv2.id, mv1.id] } })]), owner, ctx));
      expect(await edgeIds(spec.id)).toEqual([mv1.id, mv2.id].sort());
      const rows = await prisma.schemaReference.findMany({ where: { fromKind: "EVENT_SPEC", fromId: spec.id } });
      expect(rows.every((r) => r.role === "MESSAGE" && r.toKind === "MESSAGE_VERSION" && r.isDraft)).toBe(true);

      unwrap(await updateEventSpecDocument(spec.id, specDoc([]), owner, ctx));
      expect(await edgeIds(spec.id)).toEqual([]);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("validates reply channel and reply message versions, and keeps the previous draft when validation fails", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const owner = { level: "PRODUCT" as const, productId: sc.product.id };
      const channel = await seedChannel(sc, "orders");
      const { mv1 } = await seedMessageWithVersions(sc);
      const spec = unwrap(await createEventSpec(sc.product.id, { name: `replies-${sc.s}` }, ctx));
      const good = { key: "handle", action: "receive", channelId: channel.id, messageVersionIds: [mv1.id], traitIds: [] };
      unwrap(await updateEventSpecDocument(spec.id, specDoc([good]), owner, ctx));

      const bad = await updateEventSpecDocument(
        spec.id,
        specDoc([{ ...good, reply: { channelId: "no-reply-channel", messageVersionIds: [mv1.id, "no-reply-mv"] } }]),
        owner,
        ctx
      );
      expect(!bad.success && bad.error.code).toBe("VALIDATION_ERROR");
      expect(problemsOf(bad)).toEqual([
        { pointer: "/operations/0/reply/channelId", message: 'Channel "no-reply-channel" not found' },
        { pointer: "/operations/0/reply/messageVersionIds/1", message: '"no-reply-mv" is neither a message version nor a message draft of this product' },
      ]);
      // Nothing was written: the stored draft and its edges are still the good ones.
      expect(await edgeIds(spec.id)).toEqual([mv1.id]);
      const stored = await prisma.eventSpec.findUniqueOrThrow({ where: { id: spec.id } });
      expect(JSON.stringify(stored.document)).not.toContain("no-reply-channel");
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("requires OPERATION traits on operations and reports visibility before kind", async () => {
    const domainIds: Array<string | undefined> = [];
    try {
      const sc = await createProductScope(prisma, ctx);
      const sibling = await createProductScope(prisma, ctx, "sib");
      domainIds.push(sc.domain.id, sibling.domain.id);
      const owner = { level: "PRODUCT" as const, productId: sc.product.id };
      const channel = await seedChannel(sc, "orders");
      const { mv1 } = await seedMessageWithVersions(sc);
      const spec = unwrap(await createEventSpec(sc.product.id, { name: `traits-${sc.s}` }, ctx));
      const trait = (name: string, kind: "MESSAGE" | "OPERATION", domainId: string) =>
        prisma.trait.create({ data: { name: `${name}-${sc.s}`, kind, tenantId: TENANT, domainId } });
      const messageTrait = await trait("MsgTrait", "MESSAGE", sc.domain.id);
      const operationTrait = await trait("OpTrait", "OPERATION", sc.domain.id);
      const siblingTrait = await trait("SibOpTrait", "OPERATION", sibling.domain.id);
      const op = (traitIds: string[]) => specDoc([{ key: "handle", action: "receive", channelId: channel.id, messageVersionIds: [mv1.id], traitIds }]);

      const mismatch = await updateEventSpecDocument(spec.id, op([messageTrait.id]), owner, ctx);
      expect(problemsOf(mismatch)).toEqual([
        { pointer: "/operations/0/traitIds/0", message: `Trait "${messageTrait.name}" is a MESSAGE trait; operations take OPERATION traits` },
      ]);

      const outOfLine = await updateEventSpecDocument(spec.id, op([siblingTrait.id]), owner, ctx);
      expect(problemsOf(outOfLine)).toEqual([
        { pointer: "/operations/0/traitIds/0", message: `Trait "${siblingTrait.name}" is not visible from this product` },
      ]);

      const accepted = unwrap(await updateEventSpecDocument(spec.id, op([operationTrait.id]), owner, ctx));
      expect(accepted.document.operations[0].traitIds).toEqual([operationTrait.id]);
    } finally {
      await cleanupDomains(prisma, domainIds);
    }
  });

  it("treats other tenants' channels, message versions and traits as not found, and other products' drafts as not allowed", async () => {
    const domainIds: Array<string | undefined> = [];
    const foreign = await createForeignTenant(prisma, ctx);
    try {
      const sc = await createProductScope(prisma, ctx);
      const sibling = await createProductScope(prisma, ctx, "sib");
      domainIds.push(sc.domain.id, sibling.domain.id);
      const owner = { level: "PRODUCT" as const, productId: sc.product.id };
      const channel = await seedChannel(sc, "orders");
      const { mv1 } = await seedMessageWithVersions(sc);
      const siblingMessage = (await seedMessageWithVersions(sibling)).message;
      const spec = unwrap(await createEventSpec(sc.product.id, { name: `tenants-${sc.s}` }, ctx));
      const base = { key: "handle", action: "receive", channelId: channel.id, messageVersionIds: [mv1.id], traitIds: [] as string[] };

      const crossTenant = await updateEventSpecDocument(
        spec.id,
        specDoc([{ ...base, channelId: foreign.channel.id, messageVersionIds: [foreign.messageVersion.id], traitIds: [foreign.trait.id], reply: { channelId: foreign.channel.id } }]),
        owner,
        ctx
      );
      expect(problemsOf(crossTenant)).toEqual([
        { pointer: "/operations/0/channelId", message: `Channel "${foreign.channel.id}" not found` },
        { pointer: "/operations/0/messageVersionIds/0", message: `"${foreign.messageVersion.id}" is neither a message version nor a message draft of this product` },
        { pointer: "/operations/0/traitIds/0", message: `Trait "${foreign.trait.id}" not found` },
        { pointer: "/operations/0/reply/channelId", message: `Channel "${foreign.channel.id}" not found` },
      ]);
      expect(JSON.stringify(problemsOf(crossTenant))).not.toContain(foreign.trait.name);

      // A message *draft* id is accepted only from the spec's own product (D4).
      const foreignProductDraft = await updateEventSpecDocument(spec.id, specDoc([{ ...base, messageVersionIds: [siblingMessage.id] }]), owner, ctx);
      expect(problemsOf(foreignProductDraft)).toEqual([
        { pointer: "/operations/0/messageVersionIds/0", message: `"${siblingMessage.id}" is neither a message version nor a message draft of this product` },
      ]);
      expect(await edgeIds(spec.id)).toEqual([]);
    } finally {
      await cleanupDomains(prisma, domainIds);
      await foreign.cleanup();
    }
  });
});
