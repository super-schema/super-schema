import { describe, it, expect, vi, beforeEach } from "vitest";
import { emptyRegistryDelegates } from "../../../helpers/registry-mocks";

const h = vi.hoisted(() => ({ withAudit: vi.fn() }));
vi.mock("@/lib/audit", () => {
  class AuditUserMissingError extends Error {}
  return { withAudit: h.withAudit, AuditUserMissingError };
});

import { publishMessage } from "@/services/events/message-publish.service";
import type { ServiceContext } from "@/types/service-context";

const MESSAGE_ROW = {
  id: "m1", name: "OrderCreated", spec: { traitIds: [] }, hasUnpublishedChanges: true, tenantId: "t1", domainId: "d1", productId: "p1",
  payloadEntityId: "e1", payloadEntityVersionId: "ev1", headersEntityId: null, headersEntityVersionId: null, keyEntityId: null, keyEntityVersionId: null,
  latestVersion: null,
};
const ENTITY_ROW = { id: "e1", name: "Order", latestVersion: { major: 1, minor: 0 } };
const VERSION_ROW = { id: "ev1", entityId: "e1", major: 1, minor: 0 };
const CREATED = { id: "mv1", major: 1, minor: 0, sequence: 1, changeKind: "INITIAL", changeSummary: null, publishedAt: new Date(0), publishedBy: { name: "Ada" } };

function makeDb() {
  const registry = emptyRegistryDelegates();
  const db = {
    ...registry,
    // The name registry also calls findMany on message / entity / trait (the pin ENTITY_ROW is named "Order", never the message's name).
    message: { ...registry.message, findUnique: vi.fn().mockResolvedValue(MESSAGE_ROW), update: vi.fn().mockResolvedValue({ id: "m1" }) },
    entity: { ...registry.entity, findMany: vi.fn().mockResolvedValue([ENTITY_ROW]) },
    entityVersion: { findMany: vi.fn().mockResolvedValue([VERSION_ROW]) },
    trait: { ...registry.trait, findMany: vi.fn().mockResolvedValue([]) },
    messageVersion: { create: vi.fn().mockResolvedValue(CREATED) },
    schemaReference: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    $queryRaw: vi.fn().mockResolvedValue([{ id: "m1" }]),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db));
  return db;
}
const ctxOf = (db: ReturnType<typeof makeDb>) => ({ userId: "u1", userRole: "AUTHOR", prisma: db }) as unknown as ServiceContext;

beforeEach(() => {
  h.withAudit.mockReset();
  h.withAudit.mockImplementation(async ({ fn }: { fn: () => Promise<unknown> }) => fn());
});

describe("publishMessage (unit)", () => {
  it("locks the message row FOR UPDATE (no FOR SHARE), writes the version, its frozen edges and the message pointers", async () => {
    const db = makeDb();
    const r = await publishMessage("m1", { changeSummary: "  first  " }, ctxOf(db));
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

  it("fails fast on blockers before opening a transaction or auditing, and passes a missing message through", async () => {
    const db = makeDb();
    db.message.findUnique.mockResolvedValueOnce({ ...MESSAGE_ROW, payloadEntityVersionId: null });
    const blocked = await publishMessage("m1", {}, ctxOf(db));
    expect(blocked).toMatchObject({ success: false, error: { code: "PUBLISH_BLOCKED", details: { blockers: [{ kind: "UNPUBLISHED_PIN" }] } } });
    db.message.findUnique.mockResolvedValueOnce(null);
    expect(await publishMessage("m1", {}, ctxOf(db))).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(h.withAudit).not.toHaveBeenCalled();
  });

  it("maps FK / unique / write-conflict failures from a concurrent writer to a retryable CONFLICT, never IN_USE", async () => {
    for (const code of ["P2003", "P2002", "P2034"]) {
      const db = makeDb();
      db.messageVersion.create.mockRejectedValueOnce(Object.assign(new Error(`prisma ${code}`), { code }));
      const r = await publishMessage("m1", {}, ctxOf(db));
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
    expect(await publishMessage("m1", {}, ctxOf(gone))).toMatchObject({ success: false, error: { code: "CONFLICT", message: "Message changed during publish, try again" } });
    expect(gone.messageVersion.create).not.toHaveBeenCalled();

    const deleted = makeDb();
    deleted.$queryRaw.mockResolvedValueOnce([]);
    expect(await publishMessage("m1", {}, ctxOf(deleted))).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
    expect(deleted.messageVersion.create).not.toHaveBeenCalled();
  });

  it("still reports unexpected database failures as DB_ERROR (sanitised by the action layer)", async () => {
    const db = makeDb();
    db.messageVersion.create.mockRejectedValueOnce(new Error("connection reset"));
    expect(await publishMessage("m1", {}, ctxOf(db))).toEqual({ success: false, error: { code: "DB_ERROR", message: "connection reset" } });
    const failing = makeDb();
    failing.message.findUnique.mockRejectedValueOnce(new Error("pool exhausted"));
    expect(await publishMessage("m1", {}, ctxOf(failing))).toEqual({ success: false, error: { code: "DB_ERROR", message: "pool exhausted" } });
  });
});
