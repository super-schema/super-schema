import { describe, it, expect, vi } from "vitest";
import { findCrossProductPins, type DeleteGuardScope } from "@/services/events/delete-guards";

type Row = Record<string, unknown>;

interface Fixture {
  messageVersions?: Row[];
  channels?: Row[];
  traits?: Row[];
  edges?: Row[];
  specVersions?: Row[];
}

function fakeDb(f: Fixture = {}) {
  const read = (rows: Row[] | undefined) => vi.fn<(args: Row) => Promise<Row[]>>(async () => rows ?? []);
  return {
    messageVersion: { findMany: read(f.messageVersions) },
    channel: { findMany: read(f.channels) },
    trait: { findMany: read(f.traits) },
    schemaReference: { findMany: read(f.edges) },
    eventSpecVersion: { findMany: read(f.specVersions) },
  };
}

const PRODUCT: DeleteGuardScope = { kind: "product", productId: "p1", tenantId: "t1" };
const DOMAIN: DeleteGuardScope = { kind: "domain", domainId: "d1", tenantId: "t1" };

const mv = (id: string, messageId: string, name: string) => ({ id, message: { id: messageId, name } });
const spec = (id: string, name: string, productId = "p2", productName = "Fraud") => ({ id, name, productId, product: { id: productId, name: productName } });
const specVersion = (over: Row) => ({
  id: "sv1", major: 1, minor: 0, messageVersionIds: [], frozenChannels: [], frozenTraits: [], eventSpec: spec("s1", "fraud-consumer"), ...over,
});

describe("findCrossProductPins", () => {
  it("returns early without querying specs when the target owns no messages, channels or traits", async () => {
    const db = fakeDb();
    expect(await findCrossProductPins(db as never, PRODUCT)).toEqual([]);
    expect(db.schemaReference.findMany).not.toHaveBeenCalled();
    expect(db.eventSpecVersion.findMany).not.toHaveBeenCalled();
  });

  it("scopes owned assets to the product, or to the domain (product-level rows carry the domainId)", async () => {
    const product = fakeDb();
    await findCrossProductPins(product as never, PRODUCT);
    expect(product.messageVersion.findMany.mock.calls[0][0]).toMatchObject({ where: { message: { productId: "p1" } } });
    expect(product.channel.findMany.mock.calls[0][0]).toMatchObject({ where: { productId: "p1" } });
    expect(product.trait.findMany.mock.calls[0][0]).toMatchObject({ where: { productId: "p1" } });

    const domain = fakeDb();
    await findCrossProductPins(domain as never, DOMAIN);
    expect(domain.messageVersion.findMany.mock.calls[0][0]).toMatchObject({ where: { message: { domainId: "d1" } } });
    expect(domain.channel.findMany.mock.calls[0][0]).toMatchObject({ where: { domainId: "d1" } });
    expect(domain.trait.findMany.mock.calls[0][0]).toMatchObject({ where: { domainId: "d1" } });
  });

  it("matches published versions by tenant, other product, message pins, non-draft edges and frozen channel / trait ids", async () => {
    const db = fakeDb({
      messageVersions: [mv("mv1", "m1", "OrderCreated"), mv("mv2", "m1", "OrderCreated")],
      channels: [{ id: "c1", name: "orders" }],
      traits: [{ id: "t1", name: "CloudEvents" }],
      edges: [{ fromId: "sv-edge", toId: "mv2" }],
    });
    await findCrossProductPins(db as never, PRODUCT);

    const edgeQuery = db.schemaReference.findMany.mock.calls[0][0];
    expect(edgeQuery).toMatchObject({
      where: { fromKind: "EVENT_SPEC_VERSION", toKind: "MESSAGE_VERSION", toId: { in: ["mv1", "mv2"] }, isDraft: false },
    });

    const query = db.eventSpecVersion.findMany.mock.calls[0][0] as { where: { eventSpec: unknown; OR: unknown[] } };
    expect(query.where.eventSpec).toEqual({ tenantId: "t1", productId: { not: "p1" } });
    expect(query.where.OR).toEqual([
      { messageVersionIds: { hasSome: ["mv1", "mv2"] } },
      { id: { in: ["sv-edge"] } },
      { frozenChannels: { array_contains: [{ id: "c1" }] } },
      { frozenTraits: { array_contains: [{ id: "t1" }] } },
    ]);

    const domainDb = fakeDb({ traits: [{ id: "t1", name: "CloudEvents" }] });
    await findCrossProductPins(domainDb as never, DOMAIN);
    const domainQuery = domainDb.eventSpecVersion.findMany.mock.calls[0][0] as { where: { eventSpec: unknown; OR: unknown[] } };
    expect(domainQuery.where.eventSpec).toEqual({ tenantId: "t1", domainId: { not: "d1" } });
    expect(domainQuery.where.OR).toEqual([{ frozenTraits: { array_contains: [{ id: "t1" }] } }]);
  });

  it("only adds the match conditions for kinds the target owns", async () => {
    const db = fakeDb({ channels: [{ id: "c1", name: "orders" }] });
    await findCrossProductPins(db as never, PRODUCT);
    expect(db.schemaReference.findMany).not.toHaveBeenCalled();
    const query = db.eventSpecVersion.findMany.mock.calls[0][0] as { where: { OR: unknown[] } };
    expect(query.where.OR).toEqual([{ frozenChannels: { array_contains: [{ id: "c1" }] } }]);
  });

  it("groups versions per spec and names the referenced assets (deduplicated, sorted by kind then name)", async () => {
    const db = fakeDb({
      messageVersions: [mv("mv1", "m1", "OrderCreated"), mv("mv2", "m2", "Alpha")],
      channels: [{ id: "c1", name: "orders" }],
      traits: [{ id: "t1", name: "CloudEvents" }],
      edges: [{ fromId: "sv2", toId: "mv1" }],
      specVersions: [
        specVersion({ id: "sv1", major: 1, minor: 0, messageVersionIds: ["mv1"], frozenChannels: [{ id: "c1" }, { id: "elsewhere" }] }),
        specVersion({ id: "sv2", major: 1, minor: 1, messageVersionIds: [], frozenTraits: [{ id: "t1" }], frozenChannels: [{ id: "c1" }] }),
        specVersion({ id: "sv3", major: 2, minor: 0, messageVersionIds: ["mv2"], eventSpec: spec("s2", "audit-log", "p3", "Audit") }),
      ],
    });

    expect(await findCrossProductPins(db as never, PRODUCT)).toEqual([
      {
        specId: "s1", specName: "fraud-consumer", productId: "p2", productName: "Fraud",
        versions: ["1.0", "1.1"],
        assets: [
          { kind: "Message", name: "OrderCreated" },
          { kind: "Channel", name: "orders" },
          { kind: "Trait", name: "CloudEvents" },
        ],
      },
      {
        specId: "s2", specName: "audit-log", productId: "p3", productName: "Audit",
        versions: ["2.0"],
        assets: [{ kind: "Message", name: "Alpha" }],
      },
    ]);
    const query = db.eventSpecVersion.findMany.mock.calls[0][0] as { orderBy: unknown };
    expect(query.orderBy).toEqual([{ eventSpec: { name: "asc" } }, { eventSpec: { id: "asc" } }, { sequence: "asc" }]);
  });

  it("attributes the edge-recorded pin to the spec version the edge comes from", async () => {
    const db = fakeDb({
      messageVersions: [mv("mv1", "m1", "OrderCreated")],
      edges: [{ fromId: "sv-edge", toId: "mv1" }],
      specVersions: [specVersion({ id: "sv-edge", messageVersionIds: [] })],
    });
    const [pin] = await findCrossProductPins(db as never, PRODUCT);
    expect(pin.assets).toEqual([{ kind: "Message", name: "OrderCreated" }]);
  });

  it("ignores spec versions whose JSON merely matched nothing owned, and tolerates malformed frozen JSON", async () => {
    const db = fakeDb({
      channels: [{ id: "c1", name: "orders" }],
      specVersions: [
        specVersion({ id: "sv1", frozenChannels: [{ id: "other" }] }),
        specVersion({ id: "sv2", frozenChannels: null, frozenTraits: "nope" }),
        specVersion({ id: "sv3", frozenChannels: [null, 5, ["c1"], { id: 7 }, {}] }),
      ],
    });
    expect(await findCrossProductPins(db as never, PRODUCT)).toEqual([]);
  });

  it("falls back to a placeholder when a spec has no product row", async () => {
    const db = fakeDb({
      channels: [{ id: "c1", name: "orders" }],
      specVersions: [specVersion({ frozenChannels: [{ id: "c1" }], eventSpec: { id: "s1", name: "orphan", productId: null, product: null } })],
    });
    const [pin] = await findCrossProductPins(db as never, PRODUCT);
    expect(pin).toMatchObject({ specName: "orphan", productId: "", productName: "unknown product" });
  });
});
