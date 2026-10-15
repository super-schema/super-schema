import "dotenv/config"; // first: @/lib/db (pulled in by the services) reads DB_PROVIDER at import time
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { createMessage, deleteMessage, updateMessage, type MessageInput } from "@/services/events/message.service";
import { createForeignTenant } from "./foreign-tenant";
import { cleanupDomains, connectTestDb, createProductScope, TENANT, testContext, unwrap } from "./helpers";

let prisma: PrismaClient;
let ctx: ServiceContext;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
});
afterAll(async () => prisma.$disconnect());

const asInput = (value: unknown) => value as MessageInput;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const draftRefs = (fromId: string) =>
  prisma.schemaReference.findMany({ where: { fromKind: "MESSAGE", fromId }, orderBy: { role: "asc" } }).then((rows) => rows.map((r) => [r.role, r.toId, r.isDraft]));

/** Holds `SELECT ... FOR UPDATE` on a message row from a SECOND connection until `release()` (what a publish would do). */
async function holdMessageRowLock(messageId: string, whileLocked?: (tx: PrismaClient) => Promise<void>) {
  const other = connectTestDb();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markLocked!: () => void;
  const locked = new Promise<void>((resolve) => { markLocked = resolve; });
  const finished = other
    .$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "messages" WHERE "id" = ${messageId} FOR UPDATE`;
        markLocked();
        await gate;
        await whileLocked?.(tx as unknown as PrismaClient);
      },
      { timeout: 30_000 }
    )
    .finally(() => other.$disconnect());
  await Promise.race([locked, finished]);
  return { release, finished };
}

describe("message service: input shape, names, tenants", () => {
  it("rejects malformed input with VALIDATION_ERROR instead of throwing, on create and update", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const owner = { level: "PRODUCT" as const, productId: sc.product.id };
      const order = await sc.publishedEntity("Order");
      const good = { name: `Shape-${sc.s}`, payload: { entityId: order.entity.id } };
      const cases: Array<[string, unknown]> = [
        ["null input", null],
        ["string input", "OrderCreated"],
        ["array input", []],
        ["numeric name", { ...good, name: 42 }],
        ["missing name", { payload: good.payload }],
        ["object name", { ...good, name: {} }],
        ["missing payload", { name: good.name }],
        ["null payload", { name: good.name, payload: null }],
        ["string payload", { ...good, payload: order.entity.id }],
        ["numeric entityId", { ...good, payload: { entityId: 5 } }],
        ["empty entityId", { ...good, payload: { entityId: "" } }],
        ["numeric entityVersionId", { ...good, payload: { entityId: order.entity.id, entityVersionId: 5 } }],
        ["empty entityVersionId", { ...good, payload: { entityId: order.entity.id, entityVersionId: "" } }],
        ["array headers", { ...good, headers: [] }],
        ["object entityId in key", { ...good, key: { entityId: {} } }],
        ["string spec", { ...good, spec: "text" }],
        ["non-array traitIds", { ...good, spec: { traitIds: "t1" } }],
        ["non-string traitIds entries", { ...good, spec: { traitIds: [1] } }],
      ];
      const existing = unwrap(await createMessage(sc.product.id, asInput(good), ctx));
      for (const [label, input] of cases) {
        const created = await createMessage(sc.product.id, asInput(input), ctx);
        expect([label, !created.success && created.error.code]).toEqual([label, "VALIDATION_ERROR"]);
        const updated = await updateMessage(existing.id, asInput(input), owner, ctx);
        expect([label, !updated.success && updated.error.code]).toEqual([label, "VALIDATION_ERROR"]);
      }
      expect(await prisma.message.count({ where: { productId: sc.product.id } })).toBe(1);
      expect((await prisma.message.findUniqueOrThrow({ where: { id: existing.id } })).name).toBe(good.name);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("reports NAME_CONFLICT on create and update, across kinds, case-insensitively, and allows keeping its own name", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const owner = { level: "PRODUCT" as const, productId: sc.product.id };
      const order = await sc.publishedEntity("Order");
      const a = unwrap(await createMessage(sc.product.id, { name: `Alpha-${sc.s}`, payload: { entityId: order.entity.id } }, ctx));
      const b = unwrap(await createMessage(sc.product.id, { name: `Beta-${sc.s}`, payload: { entityId: order.entity.id } }, ctx));

      const clashWithEntity = await createMessage(sc.product.id, { name: "Order", payload: { entityId: order.entity.id } }, ctx);
      expect(!clashWithEntity.success && clashWithEntity.error.code).toBe("NAME_CONFLICT");
      const clashCase = await createMessage(sc.product.id, { name: `ALPHA-${sc.s}`, payload: { entityId: order.entity.id } }, ctx);
      expect(!clashCase.success && clashCase.error.code).toBe("NAME_CONFLICT");

      const renameToMessage = await updateMessage(a.id, { name: b.name, payload: { entityId: order.entity.id } }, owner, ctx);
      expect(!renameToMessage.success && renameToMessage.error.code).toBe("NAME_CONFLICT");
      const renameToEntity = await updateMessage(a.id, { name: "Order", payload: { entityId: order.entity.id } }, owner, ctx);
      expect(!renameToEntity.success && renameToEntity.error.code).toBe("NAME_CONFLICT");
      expect((await prisma.message.findUniqueOrThrow({ where: { id: a.id } })).name).toBe(a.name);

      const keepName = await updateMessage(a.id, { name: a.name, payload: { entityId: order.entity.id } }, owner, ctx);
      expect(keepName.success).toBe(true);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("treats other tenants' entities, entity versions and traits as not found, without leaking names or kinds", async () => {
    const domainIds: Array<string | undefined> = [];
    const foreign = await createForeignTenant(prisma, ctx);
    try {
      const sc = await createProductScope(prisma, ctx);
      domainIds.push(sc.domain.id);
      const order = await sc.publishedEntity("Order");
      const base = { name: `Tenant-${sc.s}` };

      const foreignPayload = await createMessage(sc.product.id, { ...base, payload: { entityId: foreign.entity.id } }, ctx);
      expect(!foreignPayload.success && foreignPayload.error.message).toMatch(/not found in this tenant/);

      const foreignVersion = await createMessage(sc.product.id, { ...base, payload: { entityId: order.entity.id, entityVersionId: foreign.version.id } }, ctx);
      expect(!foreignVersion.success && foreignVersion.error.message).toMatch(/not a published version/);

      for (const slot of ["headers", "key"] as const) {
        const r = await createMessage(sc.product.id, { ...base, payload: { entityId: order.entity.id }, [slot]: { entityId: foreign.entity.id } }, ctx);
        expect(!r.success && r.error.message).toMatch(/not found in this tenant/);
      }

      const foreignTrait = await createMessage(sc.product.id, { ...base, payload: { entityId: order.entity.id }, spec: { traitIds: [foreign.trait.id] } }, ctx);
      expect(!foreignTrait.success && foreignTrait.error.code).toBe("VALIDATION_ERROR");
      const message = !foreignTrait.success ? foreignTrait.error.message : "";
      expect(message).toBe(`Trait "${foreign.trait.id}" not found`);
      expect(message).not.toContain(foreign.trait.name);
      expect(JSON.stringify(!foreignTrait.success && foreignTrait.error.details)).not.toMatch(/MESSAGE|OPERATION|ftrait/);

      // Same tenant but outside this product's line: "not visible", and the kind is not revealed either.
      const sibling = await createProductScope(prisma, ctx, "sib");
      domainIds.push(sibling.domain.id);
      const outOfLine = await prisma.trait.create({ data: { name: `OpTrait-${sibling.s}`, kind: "OPERATION", tenantId: TENANT, domainId: sibling.domain.id } });
      const hidden = await createMessage(sc.product.id, { ...base, payload: { entityId: order.entity.id }, spec: { traitIds: [outOfLine.id] } }, ctx);
      expect(!hidden.success && hidden.error.message).toMatch(/not visible/);
      expect(!hidden.success && hidden.error.message).not.toMatch(/OPERATION/);
      expect(await prisma.message.count({ where: { productId: sc.product.id } })).toBe(0);
    } finally {
      await cleanupDomains(prisma, domainIds);
      await foreign.cleanup();
    }
  });
});

describe("message delete: owner, IN_USE details and the row lock", () => {
  it("refuses a foreign owner with FORBIDDEN and leaves the message alone", async () => {
    const domainIds: Array<string | undefined> = [];
    try {
      const sc = await createProductScope(prisma, ctx);
      const other = await createProductScope(prisma, ctx, "oth");
      domainIds.push(sc.domain.id, other.domain.id);
      const order = await sc.publishedEntity("Order");
      const m = unwrap(await createMessage(sc.product.id, { name: `Keep-${sc.s}`, payload: { entityId: order.entity.id } }, ctx));
      const foreign = await deleteMessage(m.id, { level: "PRODUCT", productId: other.product.id }, ctx);
      expect(!foreign.success && foreign.error.code).toBe("FORBIDDEN");
      expect(await prisma.message.count({ where: { id: m.id } })).toBe(1);
      const missing = await deleteMessage("no-such-message", { level: "PRODUCT", productId: sc.product.id }, ctx);
      expect(!missing.success && missing.error.code).toBe("NOT_FOUND");
    } finally {
      await cleanupDomains(prisma, domainIds);
    }
  });

  it("names the pinning event spec and version in IN_USE and keeps the message, its versions and its edges", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const owner = { level: "PRODUCT" as const, productId: sc.product.id };
      const order = await sc.publishedEntity("Order");
      const m = unwrap(await createMessage(sc.product.id, { name: `Pinned-${sc.s}`, payload: { entityId: order.entity.id } }, ctx));
      const mv = await prisma.messageVersion.create({
        data: { messageId: m.id, major: 1, minor: 0, sequence: 1, resolvedSpec: {}, payloadEntityVersionId: order.version.id, changeKind: "INITIAL", publishedById: ctx.userId },
      });
      const spec = await prisma.eventSpec.create({
        data: { name: `pinning-spec-${sc.s}`, document: {}, tenantId: TENANT, domainId: sc.domain.id, productId: sc.product.id },
      });
      const specVersion = await prisma.eventSpecVersion.create({
        data: {
          eventSpecId: spec.id, major: 2, minor: 1, sequence: 3, document: {}, sourceDocument: {}, frozenChannels: [], frozenTraits: [],
          messageVersionIds: [mv.id], changeKind: "MINOR", publishedById: ctx.userId,
        },
      });
      await prisma.schemaReference.create({
        data: { fromKind: "EVENT_SPEC_VERSION", fromId: specVersion.id, role: "MESSAGE", toKind: "MESSAGE_VERSION", toId: mv.id },
      });

      const blocked = await deleteMessage(m.id, owner, ctx);
      expect(!blocked.success && blocked.error.code).toBe("IN_USE");
      const error = !blocked.success ? blocked.error : undefined;
      expect(error?.message).toContain(`"pinning-spec-${sc.s}" (2.1)`);
      expect(error?.suggestedFix).toContain(`event spec "pinning-spec-${sc.s}"`);
      expect(error?.details).toEqual({ eventSpecs: [{ id: spec.id, name: `pinning-spec-${sc.s}`, versions: ["2.1"] }] });

      expect(await prisma.message.count({ where: { id: m.id } })).toBe(1);
      expect(await prisma.messageVersion.count({ where: { id: mv.id } })).toBe(1);
      expect(await draftRefs(m.id)).toEqual([["PAYLOAD", order.version.id, true]]);
      expect(await prisma.schemaReference.count({ where: { fromKind: "EVENT_SPEC_VERSION", fromId: specVersion.id } })).toBe(1);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("serializes behind the message row lock and then returns IN_USE for a publish that committed meanwhile", async () => {
    let domainId: string | undefined;
    let stampOfRun = "none";
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      stampOfRun = sc.s;
      const owner = { level: "PRODUCT" as const, productId: sc.product.id };
      const order = await sc.publishedEntity("Order");
      const m = unwrap(await createMessage(sc.product.id, { name: `Raced-${sc.s}`, payload: { entityId: order.entity.id } }, ctx));
      const mv = await prisma.messageVersion.create({
        data: { messageId: m.id, major: 1, minor: 0, sequence: 1, resolvedSpec: {}, payloadEntityVersionId: order.version.id, changeKind: "INITIAL", publishedById: ctx.userId },
      });

      // The "publish" holds the row lock and commits a non-draft pin edge while the delete is already waiting.
      const holder = await holdMessageRowLock(m.id, (tx) =>
        tx.schemaReference
          .create({ data: { fromKind: "EVENT_SPEC_VERSION", fromId: `esv-${sc.s}`, role: "MESSAGE", toKind: "MESSAGE_VERSION", toId: mv.id } })
          .then(() => undefined)
      );
      const deletion = deleteMessage(m.id, owner, ctx);
      const early = await Promise.race([deletion.then(() => "settled"), sleep(600).then(() => "blocked")]);
      expect(early).toBe("blocked");
      expect(await prisma.message.count({ where: { id: m.id } })).toBe(1);

      holder.release();
      await holder.finished;
      const result = await deletion;
      expect(!result.success && result.error.code).toBe("IN_USE");
      expect(await prisma.message.count({ where: { id: m.id } })).toBe(1);
      expect(await prisma.messageVersion.count({ where: { id: mv.id } })).toBe(1);
    } finally {
      await prisma.schemaReference.deleteMany({ where: { fromKind: "EVENT_SPEC_VERSION", fromId: `esv-${stampOfRun}` } });
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("deletes once the lock holder lets go when nothing pinned the message", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const owner = { level: "PRODUCT" as const, productId: sc.product.id };
      const order = await sc.publishedEntity("Order");
      const m = unwrap(await createMessage(sc.product.id, { name: `Free-${sc.s}`, payload: { entityId: order.entity.id } }, ctx));

      const holder = await holdMessageRowLock(m.id);
      const deletion = deleteMessage(m.id, owner, ctx);
      const early = await Promise.race([deletion.then(() => "settled"), sleep(600).then(() => "blocked")]);
      expect(early).toBe("blocked");

      holder.release();
      await holder.finished;
      expect(unwrap(await deletion)).toEqual({ id: m.id });
      expect(await prisma.message.count({ where: { id: m.id } })).toBe(0);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });
});
