import { describe, it, expect, vi, beforeEach } from "vitest";
import { emptyRegistryDelegates } from "../../../helpers/registry-mocks";

const h = vi.hoisted(() => ({ withAudit: vi.fn() }));
vi.mock("@/lib/audit", () => {
  class AuditUserMissingError extends Error {}
  return { withAudit: h.withAudit, AuditUserMissingError };
});
// Real planner and real input builder, except that a test can override what the input builder returns once.
vi.mock("@/lib/events/publish-plan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/events/publish-plan")>();
  return { ...actual, messagePublishInput: vi.fn(actual.messagePublishInput) };
});

import { messagePublishInput } from "@/lib/events/publish-plan";
import { listMessageVersions, previewMessagePublish, publishMessage } from "@/services/events/message-publish.service";
import type { ServiceContext } from "@/types/service-context";

type MessageRow = Record<string, unknown>;

const OWNING_PRODUCT = "p1";
const SAME_TENANT_OTHER_PRODUCT = "p2";
const FOREIGN_TENANT_PRODUCT = "p3";
const PRODUCTS: Record<string, { id: string; domainId: string; domain: { tenantId: string } }> = {
  p1: { id: "p1", domainId: "d1", domain: { tenantId: "t1" } },
  p2: { id: "p2", domainId: "d2", domain: { tenantId: "t1" } },
  p3: { id: "p3", domainId: "d3", domain: { tenantId: "t2" } },
};

const MESSAGE_ROW: MessageRow = {
  id: "m1", name: "OrderCreated", spec: { traitIds: [] }, hasUnpublishedChanges: true, tenantId: "t1", domainId: "d1", productId: "p1",
  payloadEntityId: "e1", payloadEntityVersionId: "ev1", headersEntityId: null, headersEntityVersionId: null, keyEntityId: null, keyEntityVersionId: null,
  latestVersion: null,
};
const ENTITY_ROW = { id: "e1", name: "Order", latestVersion: { major: 1, minor: 0 } };
const VERSION_ROW = { id: "ev1", entityId: "e1", major: 1, minor: 0 };
const CREATED = { id: "mv1", major: 1, minor: 0, sequence: 1, changeKind: "INITIAL", changeSummary: null, publishedAt: new Date(0), publishedBy: { name: "Ada" } };
const RESOLVED_V1 = {
  name: "OrderCreated", spec: { traitIds: [] },
  payload: { entityId: "e1", entityName: "Order", entityVersionId: "ev1", label: "1.0", major: 1 }, headers: null, key: null,
};
/** A message with a published 1.0 (pinning ev1) and an unpublished edit: the next publish is MINOR. */
const withLatest = (over: MessageRow = {}): MessageRow => ({
  ...MESSAGE_ROW, spec: { traitIds: [], description: "docs" }, latestVersion: { major: 1, minor: 0, sequence: 1, resolvedSpec: RESOLVED_V1 }, ...over,
});

/**
 * `stateReads` are the successive full reads of the message (select has `latestVersion`): the unlocked plan first, then the one
 * under the lock (the last entry repeats). The ownership read selects only the level columns and is answered separately.
 */
function makeDb(stateReads: MessageRow[] = [MESSAGE_ROW]) {
  const registry = emptyRegistryDelegates();
  let reads = 0;
  const db = {
    ...registry,
    // The name registry also calls findMany on message / entity / trait (the pin ENTITY_ROW is named "Order", never the message's name).
    message: {
      ...registry.message,
      findUnique: vi.fn(async (args: { select: Record<string, unknown> }): Promise<MessageRow | null> =>
        args.select.latestVersion ? stateReads[Math.min(reads++, stateReads.length - 1)] : MESSAGE_ROW
      ),
      update: vi.fn().mockResolvedValue({ id: "m1" }),
    },
    product: { findUnique: vi.fn(async (args: { where: { id: string } }) => PRODUCTS[args.where.id] ?? null) },
    entity: { ...registry.entity, findMany: vi.fn().mockResolvedValue([ENTITY_ROW]) },
    entityVersion: { findMany: vi.fn().mockResolvedValue([VERSION_ROW]) },
    trait: { ...registry.trait, findMany: vi.fn().mockResolvedValue([]) },
    messageVersion: { create: vi.fn().mockResolvedValue(CREATED), findMany: vi.fn().mockResolvedValue([CREATED]) },
    schemaReference: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    $queryRaw: vi.fn().mockResolvedValue([{ id: "m1" }]),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db));
  return db;
}
type Db = ReturnType<typeof makeDb>;
const ctxOf = (db: Db) => ({ userId: "u1", userRole: "AUTHOR", prisma: db }) as unknown as ServiceContext;
const publish = (db: Db, input: unknown = {}, productId: string = OWNING_PRODUCT) => publishMessage("m1", productId, input as never, ctxOf(db));

beforeEach(() => {
  h.withAudit.mockReset();
  h.withAudit.mockImplementation(async ({ fn }: { fn: () => Promise<unknown> }) => fn());
});

describe("publishMessage (unit)", () => {
  it("locks the message row FOR UPDATE (no FOR SHARE), writes the version, its frozen edges and the message pointers", async () => {
    const db = makeDb();
    const r = await publish(db, { changeSummary: "  first  " });
    expect(r).toMatchObject({ success: true, data: { id: "mv1", label: "1.0", changeKind: "INITIAL", publishedByName: "Ada" } });
    const sql = (db.$queryRaw.mock.calls[0][0] as string[]).join("?");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).not.toContain("FOR SHARE");
    expect(db.messageVersion.create.mock.calls[0][0].data).toMatchObject({
      messageId: "m1", major: 1, minor: 0, sequence: 1, payloadEntityVersionId: "ev1", headersEntityVersionId: null, keyEntityVersionId: null,
      changeKind: "INITIAL", compatReport: { reasons: [] }, changeSummary: "first", publishedById: "u1",
    });
    expect(db.schemaReference.createMany.mock.calls[0][0].data).toEqual([
      { fromKind: "MESSAGE_VERSION", fromId: "mv1", role: "PAYLOAD", toKind: "ENTITY_VERSION", toId: "ev1", isDraft: false },
    ]);
    expect(db.message.update.mock.calls[0][0]).toMatchObject({ where: { id: "m1" }, data: { latestVersionId: "mv1", hasUnpublishedChanges: false } });
    expect(h.withAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "PUBLISH_VERSION", entityType: "Message", entityId: "m1", userId: "u1" }));
  });

  describe("ownership (spec §10) — publish, preview and list share one check, made once in phase 1", () => {
    it.each([
      ["another product in the same tenant", SAME_TENANT_OTHER_PRODUCT],
      ["a product of a foreign tenant", FOREIGN_TENANT_PRODUCT],
    ])("returns FORBIDDEN without details for %s, and reads / writes / audits nothing else", async (_label, productId) => {
      const db = makeDb();
      const results = [
        await publish(db, {}, productId),
        await previewMessagePublish("m1", productId, ctxOf(db)),
        await listMessageVersions("m1", productId, ctxOf(db)),
      ];
      for (const r of results) {
        expect(r).toMatchObject({ success: false, error: { code: "FORBIDDEN", suggestedFix: expect.any(String) } });
        expect(!r.success && "details" in r.error).toBe(false);
        // Nothing of the foreign message (name, pins, traits, publishers) is echoed back.
        expect(JSON.stringify(r)).not.toMatch(/OrderCreated|Order\b|ev1|e1\b|Ada/);
      }
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(db.messageVersion.create).not.toHaveBeenCalled();
      expect(db.messageVersion.findMany).not.toHaveBeenCalled();
      expect(db.entity.findMany).not.toHaveBeenCalled();
      expect(db.entityVersion.findMany).not.toHaveBeenCalled();
      expect(db.trait.findMany).not.toHaveBeenCalled();
      expect(h.withAudit).not.toHaveBeenCalled();
    });

    it("returns NOT_FOUND for an unknown message or product and VALIDATION_ERROR for a malformed product id", async () => {
      const unknownMessage = makeDb();
      unknownMessage.message.findUnique.mockResolvedValue(null);
      for (const r of [await publish(unknownMessage), await previewMessagePublish("m1", OWNING_PRODUCT, ctxOf(unknownMessage)), await listMessageVersions("m1", OWNING_PRODUCT, ctxOf(unknownMessage))]) {
        expect(r).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
      }
      const db = makeDb();
      for (const r of [await publish(db, {}, "no-such-product"), await previewMessagePublish("m1", "no-such-product", ctxOf(db)), await listMessageVersions("m1", "no-such-product", ctxOf(db))]) {
        expect(r).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
      }
      for (const bad of [null, undefined, "", 7]) {
        expect(await publishMessage("m1", bad as never, {}, ctxOf(db))).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
        expect(await listMessageVersions("m1", bad as never, ctxOf(db))).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
      }
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(h.withAudit).not.toHaveBeenCalled();
    });

    it("lets the owning product preview and list", async () => {
      const db = makeDb();
      expect(await previewMessagePublish("m1", OWNING_PRODUCT, ctxOf(db))).toMatchObject({ success: true, data: { isFirstPublish: true, blockers: [] } });
      expect(await listMessageVersions("m1", OWNING_PRODUCT, ctxOf(db))).toMatchObject({ success: true, data: [{ id: "mv1", label: "1.0", publishedByName: "Ada" }] });
      expect(db.messageVersion.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { messageId: "m1" } }));
    });
  });

  it("fails fast on blockers before opening a transaction or auditing, and passes a missing message through", async () => {
    const blockedDb = makeDb([{ ...MESSAGE_ROW, payloadEntityVersionId: null }]);
    expect(await publish(blockedDb)).toMatchObject({ success: false, error: { code: "PUBLISH_BLOCKED", details: { blockers: [{ kind: "UNPUBLISHED_PIN" }] } } });
    const missing = makeDb();
    missing.message.findUnique.mockResolvedValue(null);
    expect(await publish(missing)).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
    expect(blockedDb.$transaction).not.toHaveBeenCalled();
    expect(missing.$transaction).not.toHaveBeenCalled();
    expect(h.withAudit).not.toHaveBeenCalled();
  });

  it("tolerates a null / non-object input as 'no options' and rejects a malformed bump or summary before any read", async () => {
    for (const input of [null, undefined, "MAJOR", 7, []]) {
      const db = makeDb();
      expect(await publish(db, input)).toMatchObject({ success: true, data: { label: "1.0" } });
    }
    const db = makeDb();
    expect(await publish(db, { bump: "PATCH" })).toEqual({ success: false, error: { code: "VALIDATION_ERROR", message: "bump must be MAJOR or MINOR" } });
    expect(await publish(db, { changeSummary: 5 })).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
    expect(db.product.findUnique).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("passes real planner errors straight through: BUMP_TOO_LOW (MAJOR pin move, MINOR requested) and INVALID_PLAN_INPUT", async () => {
    const major = makeDb([withLatest({ payloadEntityVersionId: "ev2" })]);
    major.entityVersion.findMany.mockResolvedValue([{ id: "ev2", entityId: "e1", major: 2, minor: 0 }]);
    expect(await publish(major, { bump: "MINOR" })).toMatchObject({
      success: false, error: { code: "BUMP_TOO_LOW", suggestedFix: "Publish as MAJOR." },
    });
    expect(major.$transaction).not.toHaveBeenCalled();
    // Raising instead is accepted.
    const raised = makeDb([withLatest({ payloadEntityVersionId: "ev2" })]);
    raised.entityVersion.findMany.mockResolvedValue([{ id: "ev2", entityId: "e1", major: 2, minor: 0 }]);
    raised.messageVersion.create.mockResolvedValue({ ...CREATED, id: "mv2", major: 2, minor: 0, sequence: 2, changeKind: "MAJOR" });
    expect(await publish(raised, { bump: "MAJOR" })).toMatchObject({ success: true, data: { label: "2.0", changeKind: "MAJOR" } });

    // latest set + no blockers + an unclassifiable bump: the real planner fails closed; the service must not default to MINOR.
    const db = makeDb([withLatest()]);
    vi.mocked(messagePublishInput).mockReturnValueOnce({
      input: { latest: { major: 1, minor: 0, sequence: 1 }, hasChanges: true, blockers: [], bump: null },
      resolved: RESOLVED_V1 as never,
    });
    expect(await publish(db)).toMatchObject({ success: false, error: { code: "INVALID_PLAN_INPUT" } });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.messageVersion.create).not.toHaveBeenCalled();
  });

  it("aborts with CONFLICT when the latest version advanced between the plan and the lock (independent of the unique-index backstop)", async () => {
    // Plan: latest 1.0 + unpublished edit → MINOR (1.1). Under the lock: someone already published 1.1, so the draft is clean.
    const advanced = withLatest({
      hasUnpublishedChanges: false,
      latestVersion: { major: 1, minor: 1, sequence: 2, resolvedSpec: { ...RESOLVED_V1, spec: { traitIds: [], description: "docs" } } },
    });
    const db = makeDb([withLatest(), advanced]);
    const r = await publish(db);
    expect(r).toEqual({
      success: false,
      error: { code: "CONFLICT", message: "Message changed during publish, try again", suggestedFix: "Reload the message and publish again." },
    });
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(db.messageVersion.create).not.toHaveBeenCalled();
    expect(db.schemaReference.createMany).not.toHaveBeenCalled();
    expect(db.message.update).not.toHaveBeenCalled();
    expect(h.withAudit).toHaveBeenCalledTimes(1); // the failed Result is thrown inside withAudit, which therefore writes no audit row

    // Same planning inputs under the lock: the publish proceeds as 1.1.
    const same = makeDb([withLatest()]);
    same.messageVersion.create.mockResolvedValue({ ...CREATED, id: "mv2", minor: 1, sequence: 2, changeKind: "MINOR" });
    expect(await publish(same)).toMatchObject({ success: true, data: { label: "1.1", changeKind: "MINOR" } });
  });

  it("maps FK / unique / write-conflict failures from a concurrent writer to a retryable CONFLICT, never IN_USE", async () => {
    for (const code of ["P2003", "P2002", "P2034"]) {
      const db = makeDb();
      db.messageVersion.create.mockRejectedValueOnce(Object.assign(new Error(`prisma ${code}`), { code }));
      const r = await publish(db);
      expect(r).toEqual({
        success: false,
        error: { code: "CONFLICT", message: "Message changed during publish, try again", suggestedFix: "Reload the message and publish again." },
      });
      expect(db.message.update).not.toHaveBeenCalled();
    }
  });

  it("aborts with CONFLICT when a pinned entity version vanished between the plan and the lock, and NOT_FOUND when the message did", async () => {
    const gone = makeDb();
    gone.entityVersion.findMany.mockResolvedValueOnce([VERSION_ROW]).mockResolvedValueOnce([]);
    expect(await publish(gone)).toMatchObject({ success: false, error: { code: "CONFLICT", message: "Message changed during publish, try again" } });
    expect(gone.messageVersion.create).not.toHaveBeenCalled();

    const deleted = makeDb();
    deleted.$queryRaw.mockResolvedValueOnce([]);
    expect(await publish(deleted)).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
    expect(deleted.messageVersion.create).not.toHaveBeenCalled();
  });

  it("still reports unexpected database failures as DB_ERROR (sanitised by the action layer)", async () => {
    const db = makeDb();
    db.messageVersion.create.mockRejectedValueOnce(new Error("connection reset"));
    expect(await publish(db)).toEqual({ success: false, error: { code: "DB_ERROR", message: "connection reset" } });
    const failing = makeDb();
    failing.message.findUnique.mockRejectedValueOnce(new Error("pool exhausted"));
    expect(await publish(failing)).toEqual({ success: false, error: { code: "DB_ERROR", message: "pool exhausted" } });
    const preview = makeDb();
    preview.message.findUnique.mockRejectedValueOnce(new Error("pool exhausted"));
    expect(await previewMessagePublish("m1", OWNING_PRODUCT, ctxOf(preview))).toEqual({ success: false, error: { code: "DB_ERROR", message: "pool exhausted" } });
  });
});
