import { describe, it, expect, vi } from "vitest";
import { entityInUseError, explainEntityDeleteFailure, findEntityPinUsage, isForeignKeyViolation } from "@/services/events/entity-pin-usage";

function fakeDb(messages: Array<{ id: string; name: string }>, traits: Array<{ id: string; name: string }>) {
  type FindArgs = { where: { OR: Array<Record<string, unknown>> } };
  return {
    message: { findMany: vi.fn(async (_args: FindArgs) => messages) },
    trait: { findMany: vi.fn(async (_args: FindArgs) => traits) },
  };
}

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
  it("queries messages and traits through current pins, pinned versions and published message versions", async () => {
    const db = fakeDb([{ id: "m1", name: "OrderCreated" }], [{ id: "t1", name: "CloudEvents" }]);
    expect(await findEntityPinUsage(db as never, "e1")).toEqual({
      messages: [{ id: "m1", name: "OrderCreated" }],
      traits: [{ id: "t1", name: "CloudEvents" }],
    });
    const messageWhere = db.message.findMany.mock.calls[0][0].where;
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
    expect(traitWhere.OR).toEqual([{ headersEntityId: "e1" }, { headersEntityVersion: { entityId: "e1" } }]);
  });
});

describe("entityInUseError", () => {
  it("is null when nothing pins the entity", () => {
    expect(entityInUseError("Order", { messages: [], traits: [] })).toBeNull();
  });

  it("names the referencing messages and traits and keeps the structured usage", () => {
    const usage = { messages: [{ id: "m1", name: "OrderCreated" }], traits: [{ id: "t1", name: "CloudEvents" }] };
    const error = entityInUseError("Order", usage);
    expect(error).toEqual({
      code: "IN_USE",
      message: 'Entity "Order" cannot be deleted: it is used by Message "OrderCreated" and Trait "CloudEvents".',
      details: usage,
      suggestedFix: "Re-pin or delete those messages and traits first, then delete the entity.",
    });
  });

  it("pluralises and truncates long lists", () => {
    const messages = ["A", "B", "C", "D", "E", "F", "G"].map((name) => ({ id: name, name }));
    const error = entityInUseError("Order", { messages, traits: [] });
    expect(error?.message).toBe('Entity "Order" cannot be deleted: it is used by Messages "A", "B", "C", "D", "E" and 2 more.');
    expect((error?.details as { messages: unknown[] }).messages).toHaveLength(7);
  });
});

describe("explainEntityDeleteFailure", () => {
  it("returns the IN_USE error when pins exist and null when the failure has another cause", async () => {
    const used = await explainEntityDeleteFailure(fakeDb([{ id: "m1", name: "OrderCreated" }], []) as never, { id: "e1", name: "Order" });
    expect(used?.code).toBe("IN_USE");
    expect(await explainEntityDeleteFailure(fakeDb([], []) as never, { id: "e1", name: "Order" })).toBeNull();
  });
});
