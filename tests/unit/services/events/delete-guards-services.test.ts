import { describe, it, expect, vi, beforeEach } from "vitest";

// withAudit only runs the callback here; the real one needs the app's Prisma singleton.
vi.mock("@/lib/audit", () => {
  class AuditUserMissingError extends Error {}
  return { withAudit: async ({ fn }: { fn: () => Promise<unknown> }) => fn(), AuditUserMissingError };
});

import type { PrismaClient } from "@/generated/prisma/client";
import { deleteChannel } from "@/services/events/channel.service";
import { deleteMessage } from "@/services/events/message.service";
import { deleteTrait } from "@/services/events/trait.service";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

type Fn = ReturnType<typeof vi.fn>;
const failure = <T>(r: Result<T>) => {
  if (r.success) throw new Error("expected a failure");
  return r.error;
};

/**
 * The delete transaction's client. Everything a guard reads is an empty list unless a test fills it in, and every write is a
 * spy: a blocked delete must never reach `delete` / `deleteMany`.
 */
function makeTx() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "m1" }]),
    messageVersion: { findMany: vi.fn().mockResolvedValue([]) },
    eventSpecVersion: { findMany: vi.fn().mockResolvedValue([]) },
    message: { findMany: vi.fn().mockResolvedValue([]), delete: vi.fn().mockResolvedValue({}) },
    eventSpec: { findMany: vi.fn().mockResolvedValue([]) },
    trait: { delete: vi.fn().mockResolvedValue({}) },
    channel: { delete: vi.fn().mockResolvedValue({}) },
    schemaReference: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  };
}

let tx: ReturnType<typeof makeTx>;
let ctx: ServiceContext;
const transaction: Fn = vi.fn();

const OWN = { tenantId: "t1", domainId: "d1", productId: "p1" };

beforeEach(() => {
  tx = makeTx();
  transaction.mockReset();
  transaction.mockImplementation(async (fn: (client: unknown) => unknown) => fn(tx));
  const prisma = {
    product: { findUnique: vi.fn().mockResolvedValue({ id: "p1", domainId: "d1", domain: { tenantId: "t1" } }) },
    trait: { findUnique: vi.fn().mockResolvedValue({ id: "tr1", name: "CloudEvents", kind: "MESSAGE", spec: {}, headersEntityId: null, headersEntityVersionId: null, ...OWN }) },
    channel: { findUnique: vi.fn().mockResolvedValue({ id: "c1", name: "orders", address: null, protocol: "kafka", format: "avro", formatDialect: null, spec: {}, messages: [], ...OWN }) },
    message: {
      findUnique: vi.fn().mockResolvedValue({ id: "m1", name: "OrderCreated", spec: {}, hasUnpublishedChanges: true, ...OWN, payloadEntityId: "e1", payloadEntityVersionId: null, headersEntityId: null, headersEntityVersionId: null, keyEntityId: null, keyEntityVersionId: null }),
    },
    $transaction: transaction,
  };
  ctx = { userId: "u1", userRole: "AUTHOR", prisma: prisma as unknown as PrismaClient };
});

const OWNER = { level: "PRODUCT", productId: "p1" } as const;

describe("deleteTrait: in-use guard inside the delete transaction", () => {
  it("is IN_USE (and writes nothing) while a published message version carries the trait", async () => {
    tx.messageVersion.findMany.mockResolvedValue([{ major: 1, minor: 0, message: { id: "m1", name: "OrderCreated" } }]);
    const error = failure(await deleteTrait("tr1", OWNER, ctx));
    expect(error).toMatchObject({
      code: "IN_USE",
      message: 'Trait "CloudEvents" cannot be deleted: it is used by Message "OrderCreated" (v1.0).',
    });
    expect(tx.trait.delete).not.toHaveBeenCalled();
    expect(tx.schemaReference.deleteMany).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledTimes(1);
    // read through the trait's own tenant
    expect(tx.messageVersion.findMany.mock.calls[0][0]).toMatchObject({ where: { message: { tenantId: "t1" } } });
  });

  it.each([
    ["a published event spec version that froze it", "eventSpecVersion", [{ major: 2, minor: 0, eventSpec: { id: "s1", name: "feed" } }], 'Event spec "feed" (v2.0)'],
    ["a live message draft", "message", [{ id: "m9", name: "Draft" }], 'Message "Draft" (draft)'],
    ["a live event spec draft", "eventSpec", [{ id: "s9", name: "wip" }], 'Event spec "wip" (draft)'],
  ] as const)("is IN_USE for %s", async (_label, source, rows, named) => {
    tx[source].findMany.mockResolvedValue(rows as never);
    const error = failure(await deleteTrait("tr1", OWNER, ctx));
    expect(error.code).toBe("IN_USE");
    expect(error.message).toContain(named);
    expect(tx.trait.delete).not.toHaveBeenCalled();
  });

  it("deletes the trait and its edges when nothing uses it", async () => {
    expect(await deleteTrait("tr1", OWNER, ctx)).toEqual({ success: true, data: { id: "tr1" } });
    expect(tx.schemaReference.deleteMany).toHaveBeenCalledWith({ where: { fromKind: "TRAIT", fromId: { in: ["tr1"] } } });
    expect(tx.trait.delete).toHaveBeenCalledWith({ where: { id: "tr1" } });
  });
});

describe("deleteChannel: in-use guard inside the delete transaction", () => {
  it("is IN_USE (and writes nothing) while a published spec version froze the channel", async () => {
    tx.eventSpecVersion.findMany.mockResolvedValue([{ major: 1, minor: 0, eventSpec: { id: "s1", name: "orders-feed" } }]);
    const error = failure(await deleteChannel("c1", OWNER, ctx));
    expect(error).toMatchObject({
      code: "IN_USE",
      message: 'Channel "orders" cannot be deleted: it is used by Event spec "orders-feed" (v1.0).',
    });
    expect(tx.channel.delete).not.toHaveBeenCalled();
    expect(tx.eventSpecVersion.findMany.mock.calls[0][0]).toMatchObject({
      where: { eventSpec: { tenantId: "t1" }, frozenChannels: { array_contains: [{ id: "c1" }] } },
    });
  });

  it("is IN_USE while a live spec draft uses the channel", async () => {
    tx.eventSpec.findMany.mockResolvedValue([{ id: "s9", name: "wip" }]);
    const error = failure(await deleteChannel("c1", OWNER, ctx));
    expect(error.message).toBe('Channel "orders" cannot be deleted: it is used by Event spec "wip" (draft).');
    expect(tx.channel.delete).not.toHaveBeenCalled();
  });

  it("deletes the channel when nothing uses it", async () => {
    expect(await deleteChannel("c1", OWNER, ctx)).toEqual({ success: true, data: { id: "c1" } });
    expect(tx.channel.delete).toHaveBeenCalledWith({ where: { id: "c1" } });
  });
});

describe("deleteMessage: published pins are read from BOTH places, whatever the other says", () => {
  beforeEach(() => {
    tx.messageVersion.findMany.mockResolvedValue([{ id: "mv1" }]);
  });

  it("the messageVersionIds array alone blocks even with no schema_references edge (the authoritative record)", async () => {
    tx.eventSpecVersion.findMany.mockResolvedValue([{ major: 1, minor: 0, eventSpec: { id: "s1", name: "pinner" } }]);
    const error = failure(await deleteMessage("m1", OWNER, ctx));
    expect(error.code).toBe("IN_USE");
    expect(error.message).toContain('"pinner" (1.0)');
    expect(tx.schemaReference.findMany).toHaveBeenCalledTimes(1);
    expect(tx.eventSpecVersion.findMany).toHaveBeenCalledTimes(1); // ran although there were no edges
    expect(tx.eventSpecVersion.findMany.mock.calls[0][0]).toMatchObject({
      where: { OR: [{ id: { in: [] } }, { messageVersionIds: { hasSome: ["mv1"] } }] },
    });
    expect(tx.message.delete).not.toHaveBeenCalled();
  });

  it("an edge alone blocks (array empty), naming the spec version the edge comes from", async () => {
    tx.schemaReference.findMany.mockResolvedValue([{ fromKind: "EVENT_SPEC_VERSION", fromId: "sv1" }]);
    tx.eventSpecVersion.findMany.mockResolvedValue([{ major: 2, minor: 1, eventSpec: { id: "s1", name: "pinner" } }]);
    const error = failure(await deleteMessage("m1", OWNER, ctx));
    expect(error.code).toBe("IN_USE");
    expect(error.message).toContain('"pinner" (2.1)');
    expect(tx.eventSpecVersion.findMany.mock.calls[0][0]).toMatchObject({ where: { OR: [{ id: { in: ["sv1"] } }, { messageVersionIds: { hasSome: ["mv1"] } }] } });
  });

  it("an edge that names no spec version still blocks, as before", async () => {
    tx.schemaReference.findMany.mockResolvedValue([{ fromKind: "MESSAGE", fromId: "x" }]);
    const error = failure(await deleteMessage("m1", OWNER, ctx));
    expect(error.code).toBe("IN_USE");
    expect(error.message).toContain("a published event spec version");
    expect(tx.message.delete).not.toHaveBeenCalled();
  });

  it("deletes when neither place pins a version", async () => {
    expect(await deleteMessage("m1", OWNER, ctx)).toEqual({ success: true, data: { id: "m1" } });
    expect(tx.message.delete).toHaveBeenCalledWith({ where: { id: "m1" } });
  });
});
