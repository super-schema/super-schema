import "dotenv/config"; // first: @/lib/db (pulled in by the services) reads DB_PROVIDER at import time
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { createMessage, updateMessage } from "@/services/events/message.service";
import { createTrait } from "@/services/events/trait.service";
import { getMessageVersion, listMessageVersions, previewMessagePublish, publishMessage } from "@/services/events/message-publish.service";
import { cleanupDomains, connectTestDb, createProductScope, testContext, unwrap } from "./helpers";

let prisma: PrismaClient;
let ctx: ServiceContext;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
});
afterAll(async () => prisma.$disconnect());

/**
 * `publishEntity` (and every `publishMessage`) writes an immutable PUBLISH_VERSION audit row into the shared dev DB, so the
 * prerequisite entity versions are inserted directly (the message publish reads only the version row and the entity's
 * latest pointer); `publishMessage` is called only where the test is about publishing a Message.
 */
async function insertEntityVersion(entityId: string, major: number, minor: number, sequence: number) {
  const entity = await prisma.entity.findUniqueOrThrow({ where: { id: entityId }, select: { typespecSource: true } });
  const version = await prisma.entityVersion.create({
    data: {
      entityId, major, minor, sequence, resolvedSource: entity.typespecSource ?? "", fieldSnapshot: [],
      changeKind: sequence === 1 ? "INITIAL" : "MAJOR", publishedById: ctx.userId,
    },
  });
  await prisma.entity.update({ where: { id: entityId }, data: { latestVersionId: version.id, hasUnpublishedChanges: false, version: sequence } });
  return version;
}

describe("message publish (spec §6.1, §10)", () => {
  it("reports all blockers together, then publishes 1.0 → 1.1 → 2.0 with raise-only bumps and frozen pins", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const owner = { level: "PRODUCT" as const, productId: sc.product.id };
      const order = await sc.entity("Order");
      const trait = unwrap(await createTrait({ level: "DOMAIN", domainId: sc.domain.id }, { name: `CE-${sc.s}`, kind: "MESSAGE" }, ctx));
      const message = unwrap(await createMessage(sc.product.id, {
        name: `OrderCreated-${sc.s}`, spec: { correlationId: { location: "header.id" }, traitIds: [trait.id] }, payload: { entityId: order.id },
      }, ctx));
      await prisma.trait.delete({ where: { id: trait.id } });

      // Unpublished pin + deleted trait + invalid correlationId: every blocker is listed, nothing is written.
      const blockedPreview = unwrap(await previewMessagePublish(message.id, ctx));
      expect(blockedPreview.blockers.map((b) => b.kind)).toEqual(["UNPUBLISHED_PIN", "MISSING_TRAIT", "INVALID_SPEC"]);
      const blocked = await publishMessage(message.id, {}, ctx);
      expect(!blocked.success && blocked.error.code).toBe("PUBLISH_BLOCKED");
      const blockedDetails = !blocked.success ? (blocked.error.details as { blockers: Array<{ kind: string }> }) : { blockers: [] };
      expect(blockedDetails.blockers.map((b) => b.kind)).toEqual(["UNPUBLISHED_PIN", "MISSING_TRAIT", "INVALID_SPEC"]);
      expect(await prisma.messageVersion.count({ where: { messageId: message.id } })).toBe(0);
      expect(await prisma.message.findUniqueOrThrow({ where: { id: message.id } })).toMatchObject({ latestVersionId: null, hasUnpublishedChanges: true });

      const orderV1 = await insertEntityVersion(order.id, 1, 0, 1);
      unwrap(await updateMessage(message.id, { name: message.name, spec: { contentType: "avro/binary", traitIds: [] }, payload: { entityId: order.id } }, owner, ctx));
      const v1 = unwrap(await publishMessage(message.id, { changeSummary: "first" }, ctx));
      expect(v1).toMatchObject({ label: "1.0", changeKind: "INITIAL", sequence: 1, changeSummary: "first" });
      expect(await prisma.message.findUniqueOrThrow({ where: { id: message.id } })).toMatchObject({ latestVersionId: v1.id, hasUnpublishedChanges: false });
      const refs = await prisma.schemaReference.findMany({ where: { fromKind: "MESSAGE_VERSION", fromId: v1.id } });
      expect(refs.map((r) => [r.role, r.toId, r.isDraft])).toEqual([["PAYLOAD", orderV1.id, false]]);
      const stored = await prisma.messageVersion.findUniqueOrThrow({ where: { id: v1.id } });
      expect(stored).toMatchObject({ payloadEntityVersionId: orderV1.id, headersEntityVersionId: null, keyEntityVersionId: null, publishedById: ctx.userId });
      expect(stored.compatReport).toEqual({ reasons: [] });
      const frozen = unwrap(await getMessageVersion(message.id, "1.0", ctx));
      expect(frozen.resolvedSpec.payload).toMatchObject({ entityName: "Order", entityVersionId: orderV1.id, label: "1.0" });
      expect(frozen.summary.id).toBe(v1.id);

      const again = await publishMessage(message.id, {}, ctx);
      expect(!again.success && JSON.stringify(again.error.details)).toContain("NO_CHANGES");

      unwrap(await updateMessage(message.id, { name: message.name, spec: { contentType: "avro/binary", description: "docs", traitIds: [] }, payload: { entityId: order.id, entityVersionId: orderV1.id } }, owner, ctx));
      expect(unwrap(await previewMessagePublish(message.id, ctx)).suggestedBump).toBe("MINOR");
      expect(unwrap(await publishMessage(message.id, {}, ctx)).label).toBe("1.1");

      const orderV2 = await insertEntityVersion(order.id, 2, 0, 2);
      unwrap(await updateMessage(message.id, { name: message.name, spec: { contentType: "avro/binary", description: "docs", traitIds: [] }, payload: { entityId: order.id, entityVersionId: orderV2.id } }, owner, ctx));
      const majorPreview = unwrap(await previewMessagePublish(message.id, ctx));
      expect(majorPreview).toMatchObject({ suggestedBump: "MAJOR", candidateLabels: { MAJOR: "2.0", MINOR: "1.2" } });
      expect(majorPreview.reasons[0]).toMatch(/new major/);
      const tooLow = await publishMessage(message.id, { bump: "MINOR" }, ctx);
      expect(!tooLow.success && tooLow.error.code).toBe("BUMP_TOO_LOW");
      expect(await prisma.messageVersion.count({ where: { messageId: message.id } })).toBe(2);
      const v3 = unwrap(await publishMessage(message.id, {}, ctx));
      expect(v3).toMatchObject({ label: "2.0", changeKind: "MAJOR", sequence: 3 });
      expect((await prisma.messageVersion.findUniqueOrThrow({ where: { id: v3.id } })).compatReport).toEqual({ reasons: majorPreview.reasons });
      expect(unwrap(await listMessageVersions(message.id, ctx)).map((v) => v.label)).toEqual(["2.0", "1.1", "1.0"]);

      // Earlier versions keep their frozen pin edges and stay immutable.
      expect((await prisma.schemaReference.findMany({ where: { fromKind: "MESSAGE_VERSION", fromId: v1.id } })).map((r) => r.toId)).toEqual([orderV1.id]);
      expect((await prisma.schemaReference.findMany({ where: { fromKind: "MESSAGE_VERSION", fromId: v3.id } })).map((r) => r.toId)).toEqual([orderV2.id]);
      await expect(prisma.messageVersion.update({ where: { id: v1.id }, data: { changeSummary: "x" } })).rejects.toThrow(/immutable/);

      const missing = await getMessageVersion(message.id, "9.9", ctx);
      expect(!missing.success && missing.error.code).toBe("NOT_FOUND");
      const unknownMessage = await listMessageVersions("no-such-message", ctx);
      expect(!unknownMessage.success && unknownMessage.error.code).toBe("NOT_FOUND");
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("serializes concurrent publishes of one message (exactly one wins) and freezes payload + headers + key pins as edges", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const order = await sc.entity("Order");
      const meta = await sc.entity("Meta");
      const orderKey = await sc.entity("OrderKey");
      const orderV1 = await insertEntityVersion(order.id, 1, 0, 1);
      const metaV1 = await insertEntityVersion(meta.id, 1, 0, 1);
      const keyV1 = await insertEntityVersion(orderKey.id, 1, 0, 1);
      const message = unwrap(await createMessage(sc.product.id, {
        name: `OrderCreated-${sc.s}`, payload: { entityId: order.id }, headers: { entityId: meta.id }, key: { entityId: orderKey.id },
      }, ctx));

      const results = await Promise.all([publishMessage(message.id, {}, ctx), publishMessage(message.id, {}, ctx)]);
      expect(results.filter((r) => r.success)).toHaveLength(1);
      const loser = results.find((r) => !r.success);
      const loserCode = loser && !loser.success ? loser.error.code : "none";
      expect(["PUBLISH_BLOCKED", "CONFLICT"]).toContain(loserCode);
      expect(await prisma.messageVersion.count({ where: { messageId: message.id } })).toBe(1);

      const winner = results.find((r) => r.success);
      const v1 = winner && winner.success ? winner.data : null;
      expect(v1?.label).toBe("1.0");
      const refs = await prisma.schemaReference.findMany({ where: { fromKind: "MESSAGE_VERSION", fromId: v1?.id } });
      expect(refs.map((r) => [r.role, r.toId, r.isDraft]).sort()).toEqual(
        [["HEADERS", metaV1.id, false], ["KEY", keyV1.id, false], ["PAYLOAD", orderV1.id, false]].sort()
      );
      expect(await prisma.messageVersion.findUniqueOrThrow({ where: { id: v1?.id } })).toMatchObject({
        payloadEntityVersionId: orderV1.id, headersEntityVersionId: metaV1.id, keyEntityVersionId: keyV1.id,
      });
      // The draft's own (isDraft = true) edges survive the publish.
      const drafts = await prisma.schemaReference.findMany({ where: { fromKind: "MESSAGE", fromId: message.id } });
      expect(drafts).toHaveLength(3);
      expect(drafts.every((r) => r.isDraft)).toBe(true);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("re-verifies inside the lock: an edit that lands after the plan aborts with a retryable CONFLICT and writes nothing", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const owner = { level: "PRODUCT" as const, productId: sc.product.id };
      const order = await sc.entity("Order");
      const orderV1 = await insertEntityVersion(order.id, 1, 0, 1);
      const message = unwrap(await createMessage(sc.product.id, { name: `OrderCreated-${sc.s}`, payload: { entityId: order.id } }, ctx));

      // The transaction opens after the unlocked planning phase; slip an edit in right before it starts.
      let edited = false;
      const racing: ServiceContext = {
        ...ctx,
        prisma: new Proxy(prisma, {
          get(target, prop) {
            if (prop === "$transaction") {
              return async (...args: unknown[]) => {
                if (!edited) {
                  edited = true;
                  unwrap(await updateMessage(message.id, { name: message.name, spec: { description: "edited mid-publish", traitIds: [] }, payload: { entityId: order.id, entityVersionId: orderV1.id } }, owner, ctx));
                }
                return (target.$transaction as (...a: unknown[]) => Promise<unknown>).apply(target, args);
              };
            }
            const value: unknown = Reflect.get(target, prop, target);
            return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
          },
        }),
      };
      const raced = await publishMessage(message.id, {}, racing);
      expect(edited).toBe(true);
      expect(!raced.success && raced.error).toMatchObject({ code: "CONFLICT", message: "Message changed during publish, try again" });
      expect(await prisma.messageVersion.count({ where: { messageId: message.id } })).toBe(0);

      // The draft keeps the mid-publish edit and is still publishable (a retry would plan against it).
      expect(await prisma.message.findUniqueOrThrow({ where: { id: message.id } })).toMatchObject({ latestVersionId: null, hasUnpublishedChanges: true });
      expect(unwrap(await previewMessagePublish(message.id, ctx))).toMatchObject({ isFirstPublish: true, blockers: [] });
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });
});
