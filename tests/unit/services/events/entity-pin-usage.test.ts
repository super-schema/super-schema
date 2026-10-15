import { describe, it, expect, vi, afterEach } from "vitest";
import {
  entityDeleteFailure,
  entityInUseError,
  explainEntityDeleteFailure,
  findEntityPinUsage,
  isForeignKeyViolation,
  type EntityPinUsage,
} from "@/services/events/entity-pin-usage";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

type Row = Record<string, unknown>;
type Where = { where: Record<string, unknown> & { OR?: Array<Record<string, unknown>> } } & Row;

interface Fixture {
  messages?: Array<{ id: string; name: string }>;
  traits?: Array<{ id: string; name: string }>;
  /** This entity's own versions. */
  versions?: Row[];
  /** Edges from entity versions to those versions. */
  edges?: Row[];
  /** The edge sources (version rows with their entity). */
  sources?: Row[];
}

function fakeDb(f: Fixture = {}) {
  const sourceRows = f.sources ?? [];
  return {
    message: { findMany: vi.fn(async (_args: Where) => f.messages ?? []) },
    trait: { findMany: vi.fn(async (_args: Where) => f.traits ?? []) },
    // The first read lists the entity's own versions, the second one the edge sources.
    entityVersion: {
      findMany: vi.fn(async (args: Where) => (args.where.entityId !== undefined ? (f.versions ?? []) : sourceRows)),
    },
    schemaReference: { findMany: vi.fn(async (_args: Where) => f.edges ?? []) },
  };
}

const source = (entityId: string, name: string, major: number, minor: number) => ({ major, minor, entity: { id: entityId, name } });
const E1 = { id: "e1", tenantId: "t1" };
const NO_USAGE: EntityPinUsage = { messages: [], traits: [], entities: [] };

describe("isForeignKeyViolation", () => {
  it("recognises the Prisma foreign-key code only", () => {
    expect(isForeignKeyViolation(Object.assign(new Error("fk"), { code: "P2003" }))).toBe(true);
    expect(isForeignKeyViolation(Object.assign(new Error("dup"), { code: "P2002" }))).toBe(false);
    expect(isForeignKeyViolation(new Error("boom"))).toBe(false);
    expect(isForeignKeyViolation(null)).toBe(false);
    expect(isForeignKeyViolation("P2003")).toBe(false);
  });
});

describe("findEntityPinUsage", () => {
  it("queries messages and traits through current pins, pinned versions and published message versions, inside the tenant", async () => {
    const db = fakeDb({ messages: [{ id: "m1", name: "OrderCreated" }], traits: [{ id: "t1", name: "CloudEvents" }] });
    expect(await findEntityPinUsage(db as never, E1)).toEqual({
      messages: [{ id: "m1", name: "OrderCreated" }],
      traits: [{ id: "t1", name: "CloudEvents" }],
      entities: [],
    });
    const messageWhere = db.message.findMany.mock.calls[0][0].where;
    expect(messageWhere.tenantId).toBe("t1");
    expect(messageWhere.OR).toEqual(
      expect.arrayContaining([
        { payloadEntityId: "e1" },
        { headersEntityId: "e1" },
        { keyEntityId: "e1" },
        { payloadEntityVersion: { entityId: "e1" } },
        { headersEntityVersion: { entityId: "e1" } },
        { keyEntityVersion: { entityId: "e1" } },
        {
          versions: {
            some: {
              OR: [
                { payloadEntityVersion: { entityId: "e1" } },
                { headersEntityVersion: { entityId: "e1" } },
                { keyEntityVersion: { entityId: "e1" } },
              ],
            },
          },
        },
      ])
    );
    const traitWhere = db.trait.findMany.mock.calls[0][0].where;
    expect(traitWhere.tenantId).toBe("t1");
    expect(traitWhere.OR).toEqual([{ headersEntityId: "e1" }, { headersEntityVersion: { entityId: "e1" } }]);
  });

  it("finds the entities whose published versions reference one of its versions: edge kind, target ids, other entity, same tenant", async () => {
    const db = fakeDb({
      versions: [{ id: "v1" }, { id: "v2" }],
      edges: [{ fromId: "o1" }, { fromId: "o2" }, { fromId: "c1" }],
      sources: [source("order", "Order", 1, 0), source("order", "Order", 1, 1), source("cart", "Cart", 2, 0)],
    });
    expect((await findEntityPinUsage(db as never, E1)).entities).toEqual([
      { id: "order", name: "Order", versions: ["1.0", "1.1"] },
      { id: "cart", name: "Cart", versions: ["2.0"] },
    ]);

    expect(db.entityVersion.findMany.mock.calls[0][0]).toMatchObject({ where: { entityId: "e1" } });
    expect(db.schemaReference.findMany.mock.calls[0][0]).toMatchObject({
      where: { fromKind: "ENTITY_VERSION", toKind: "ENTITY_VERSION", toId: { in: ["v1", "v2"] }, isDraft: false },
      distinct: ["fromId"],
    });
    expect(db.entityVersion.findMany.mock.calls[1][0]).toMatchObject({
      // the SOURCE must belong to a DIFFERENT entity (a recursive entity never blocks itself) of the SAME tenant
      where: { id: { in: ["o1", "o2", "c1"] }, entity: { tenantId: "t1", id: { not: "e1" } } },
    });
  });

  it("reads no edges when the entity has no versions, and no sources when nothing references them", async () => {
    const none = fakeDb();
    expect((await findEntityPinUsage(none as never, E1)).entities).toEqual([]);
    expect(none.schemaReference.findMany).not.toHaveBeenCalled();

    const noEdges = fakeDb({ versions: [{ id: "v1" }] });
    expect((await findEntityPinUsage(noEdges as never, E1)).entities).toEqual([]);
    expect(noEdges.entityVersion.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("entityInUseError", () => {
  it("is null when nothing pins or references the entity", () => {
    expect(entityInUseError("Order", NO_USAGE)).toBeNull();
  });

  it("names the referencing messages and traits and keeps the structured usage", () => {
    const usage: EntityPinUsage = { messages: [{ id: "m1", name: "OrderCreated" }], traits: [{ id: "t1", name: "CloudEvents" }], entities: [] };
    expect(entityInUseError("Order", usage)).toEqual({
      code: "IN_USE",
      message: 'Entity "Order" cannot be deleted: it is used by Message "OrderCreated" and Trait "CloudEvents".',
      details: usage,
      suggestedFix: "Re-pin or delete those messages and traits first, then delete the entity.",
    });
  });

  it("pluralises and truncates long lists", () => {
    const messages = ["A", "B", "C", "D", "E", "F", "G"].map((name) => ({ id: name, name }));
    const error = entityInUseError("Order", { ...NO_USAGE, messages });
    expect(error?.message).toBe('Entity "Order" cannot be deleted: it is used by Messages "A", "B", "C", "D", "E" and 2 more.');
    expect((error?.details as { messages: unknown[] }).messages).toHaveLength(7);
  });

  it("names the referencing entities with their versions (capped) and tells how to get unblocked", () => {
    const usage: EntityPinUsage = { ...NO_USAGE, entities: [{ id: "o", name: "Order", versions: ["1.0", "1.1", "2.0", "2.1", "3.0"] }] };
    const error = entityInUseError("Money", usage);
    expect(error).toMatchObject({
      code: "IN_USE",
      message: 'Entity "Money" cannot be deleted: it is referenced by published versions of Entity "Order" (v1.0, v1.1, v2.0 and 2 more).',
      details: usage,
    });
    expect(error?.suggestedFix).toBe(
      'Published versions cannot be changed: delete the referencing entities first ("Order"; deleting an entity removes its versions) then delete this entity. Or keep it.'
    );
  });

  it("pluralises, caps and combines referencing entities with message / trait pins", () => {
    const entities = ["A", "B", "C", "D", "E", "F", "G"].map((name) => ({ id: name, name, versions: ["1.0"] }));
    const error = entityInUseError("Money", { messages: [{ id: "m", name: "M" }], traits: [], entities });
    expect(error?.message).toBe(
      'Entity "Money" cannot be deleted: it is used by Message "M" and referenced by published versions of Entities "A" (v1.0), "B" (v1.0), "C" (v1.0), "D" (v1.0), "E" (v1.0) and 2 more.'
    );
    expect(error?.suggestedFix).toBe(
      'Published versions cannot be changed: delete the referencing entities first ("A", "B", "C" and 4 more; deleting an entity removes its versions), re-pin or delete the messages and traits that use it, then delete this entity. Or keep it.'
    );
  });
});

describe("explainEntityDeleteFailure", () => {
  it("returns the IN_USE error when pins exist and null when the failure has another cause", async () => {
    const entity = { id: "e1", name: "Order", tenantId: "t1" };
    const used = await explainEntityDeleteFailure(fakeDb({ messages: [{ id: "m1", name: "OrderCreated" }] }) as never, entity);
    expect(used?.code).toBe("IN_USE");
    expect(await explainEntityDeleteFailure(fakeDb() as never, entity)).toBeNull();
  });

  it("explains a referenced entity too (no FK: this is the only guard)", async () => {
    const db = fakeDb({ versions: [{ id: "v1" }], edges: [{ fromId: "o1" }], sources: [source("order", "Order", 1, 0)] });
    const error = await explainEntityDeleteFailure(db as never, { id: "e1", name: "Money", tenantId: "t1" });
    expect(error?.message).toContain('Entity "Order" (v1.0)');
  });
});

describe("entityDeleteFailure", () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  afterEach(() => consoleError.mockClear());
  const entity = { id: "e1", name: "Order", tenantId: "t1" };
  const prismaError = (code: string, meta?: object) => Object.assign(new Error("raw prisma text with table \"entities\""), { code, ...(meta && { meta }) });
  const rawQuery = (state: string) => prismaError("P2010", { driverAdapterError: { cause: { originalCode: state } } });

  it("P2003 -> IN_USE naming what holds the entity", async () => {
    const error = await entityDeleteFailure(fakeDb({ messages: [{ id: "m1", name: "OrderCreated" }] }) as never, entity, prismaError("P2003"));
    expect(error.code).toBe("IN_USE");
    expect(error.message).toContain('Message "OrderCreated"');
  });

  it("P2003 nothing explains (or with only an id at hand) -> generic IN_USE, never the driver text", async () => {
    const unexplained = await entityDeleteFailure(fakeDb() as never, entity, prismaError("P2003"));
    expect(unexplained).toEqual({
      code: "IN_USE",
      message: "This entity is referenced by another record and cannot be deleted.",
      suggestedFix: "Remove the references first.",
    });
    const idOnly = fakeDb({ messages: [{ id: "m1", name: "X" }] });
    expect((await entityDeleteFailure(idOnly as never, { id: "e1" }, prismaError("P2003"))).code).toBe("IN_USE");
    expect(idOnly.message.findMany).not.toHaveBeenCalled();
  });

  it("a failing explanation read -> DB_ERROR (generic, logged)", async () => {
    const db = fakeDb();
    db.message.findMany.mockRejectedValueOnce(new Error("connection reset"));
    expect(await entityDeleteFailure(db as never, entity, prismaError("P2003"))).toEqual({ code: "DB_ERROR", message: GENERIC_ACTION_ERROR });
    expect(consoleError).toHaveBeenCalled();
  });

  it.each([
    ["P2028 (transaction expired / lock wait outlived it)", prismaError("P2028")],
    ["P2034 (write conflict)", prismaError("P2034")],
    ["P2010 deadlock_detected 40P01", rawQuery("40P01")],
    ["P2010 lock_not_available 55P03", rawQuery("55P03")],
    ["P2010 serialization_failure 40001", rawQuery("40001")],
  ])("%s -> a retryable CONFLICT, no driver text and no pin lookup", async (_label, error) => {
    const db = fakeDb();
    const failure = await entityDeleteFailure(db as never, entity, error);
    expect(failure).toEqual({ code: "CONFLICT", message: "Entity changed concurrently, try again", suggestedFix: "Reload and try deleting again." });
    expect(db.message.findMany).not.toHaveBeenCalled();
  });

  it("anything else -> DB_ERROR with only the generic message; the original is logged", async () => {
    const raw = new Error("connect ECONNREFUSED 10.0.0.5:5432");
    expect(await entityDeleteFailure(fakeDb() as never, entity, raw)).toEqual({ code: "DB_ERROR", message: GENERIC_ACTION_ERROR });
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("deleteEntity e1"), raw);
    // a P2010 that is not lock contention stays a database error
    expect((await entityDeleteFailure(fakeDb() as never, entity, rawQuery("42P01"))).code).toBe("DB_ERROR");
  });
});
