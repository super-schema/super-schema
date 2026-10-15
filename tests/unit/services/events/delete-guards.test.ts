import { describe, it, expect, vi } from "vitest";
import {
  assetInUseError,
  findChannelReferrers,
  findCrossProductPins,
  findTraitReferrers,
  type AssetReferrers,
  type DeleteGuardScope,
} from "@/services/events/delete-guards";

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


// ── trait / channel in-use guards ─────────────────────────────────────────────────────────────────

interface ReferrerFixture {
  messageVersions?: Row[];
  specVersions?: Row[];
  messages?: Row[];
  specs?: Row[];
}

function referrerDb(f: ReferrerFixture = {}) {
  const read = (rows: Row[] | undefined) => vi.fn<(args: Row) => Promise<Row[]>>(async () => rows ?? []);
  return {
    messageVersion: { findMany: read(f.messageVersions) },
    eventSpecVersion: { findMany: read(f.specVersions) },
    message: { findMany: read(f.messages) },
    eventSpec: { findMany: read(f.specs) },
  };
}

const TRAIT = { id: "tr1", tenantId: "t1" };
const mver = (id: string, name: string, major: number, minor: number) => ({ major, minor, message: { id, name } });
const sver = (id: string, name: string, major: number, minor: number) => ({ major, minor, eventSpec: { id, name } });

describe("findTraitReferrers", () => {
  it("reads the four sources by jsonb containment, all inside the trait's tenant", async () => {
    const db = referrerDb();
    expect(await findTraitReferrers(db as never, TRAIT)).toEqual({ referrers: [], truncated: false });

    expect(db.messageVersion.findMany.mock.calls[0][0]).toMatchObject({
      where: { message: { tenantId: "t1" }, resolvedSpec: { path: ["spec", "traitIds"], array_contains: ["tr1"] } },
    });
    expect(db.eventSpecVersion.findMany.mock.calls[0][0]).toMatchObject({
      where: { eventSpec: { tenantId: "t1" }, frozenTraits: { array_contains: [{ id: "tr1" }] } },
    });
    expect(db.message.findMany.mock.calls[0][0]).toMatchObject({ where: { tenantId: "t1", spec: { path: ["traitIds"], array_contains: ["tr1"] } } });
    expect(db.eventSpec.findMany.mock.calls[0][0]).toMatchObject({
      where: { tenantId: "t1", document: { path: ["operations"], array_contains: [{ traitIds: ["tr1"] }] } },
    });
  });

  it("groups versions and drafts per owner: messages first, then event specs, each by name", async () => {
    const db = referrerDb({
      messageVersions: [mver("m2", "Zeta", 1, 0), mver("m1", "Alpha", 1, 0), mver("m1", "Alpha", 1, 1)],
      messages: [{ id: "m1", name: "Alpha" }, { id: "m3", name: "Beta" }],
      specVersions: [sver("s1", "feed", 2, 0)],
      specs: [{ id: "s2", name: "another" }],
    });
    expect((await findTraitReferrers(db as never, TRAIT)).referrers).toEqual([
      { kind: "Message", id: "m1", name: "Alpha", versions: ["1.0", "1.1"], draft: true },
      { kind: "Message", id: "m3", name: "Beta", versions: [], draft: true },
      { kind: "Message", id: "m2", name: "Zeta", versions: ["1.0"], draft: false },
      { kind: "Event spec", id: "s2", name: "another", versions: [], draft: true },
      { kind: "Event spec", id: "s1", name: "feed", versions: ["2.0"], draft: false },
    ]);
  });

  it("reads at most the scan limit per source and reports a truncated list", async () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ id: `m${i}`, name: `M${String(i).padStart(3, "0")}` }));
    const db = referrerDb({ messages: many });
    const found = await findTraitReferrers(db as never, TRAIT);
    expect(db.message.findMany.mock.calls[0][0]).toMatchObject({ take: 201 });
    expect(found.truncated).toBe(true);
    expect(found.referrers).toHaveLength(200);
  });
});

describe("findChannelReferrers", () => {
  it("reads frozen channels (any product) and draft documents (operation + reply channel) inside the tenant", async () => {
    const db = referrerDb();
    await findChannelReferrers(db as never, { id: "c1", tenantId: "t1" });
    const versionQuery = db.eventSpecVersion.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
    // no "other product" restriction: only the tenant is in the filter
    expect(versionQuery.where).toEqual({ eventSpec: { tenantId: "t1" }, frozenChannels: { array_contains: [{ id: "c1" }] } });
    expect(db.eventSpec.findMany.mock.calls[0][0]).toMatchObject({
      where: {
        tenantId: "t1",
        OR: [
          { document: { path: ["operations"], array_contains: [{ channelId: "c1" }] } },
          { document: { path: ["operations"], array_contains: [{ reply: { channelId: "c1" } }] } },
        ],
      },
    });
    expect(db.messageVersion.findMany).not.toHaveBeenCalled();
    expect(db.message.findMany).not.toHaveBeenCalled();
  });

  it("groups the published versions and the draft of one spec", async () => {
    const db = referrerDb({ specVersions: [sver("s1", "feed", 1, 0), sver("s1", "feed", 1, 1)], specs: [{ id: "s1", name: "feed" }] });
    expect((await findChannelReferrers(db as never, { id: "c1", tenantId: "t1" })).referrers).toEqual([
      { kind: "Event spec", id: "s1", name: "feed", versions: ["1.0", "1.1"], draft: true },
    ]);
  });
});

describe("assetInUseError", () => {
  const found = (referrers: AssetReferrers["referrers"], truncated = false): AssetReferrers => ({ referrers, truncated });
  const msg = (id: string, name: string, versions: string[] = [], draft = false) => ({ kind: "Message" as const, id, name, versions, draft });
  const spec = (id: string, name: string, versions: string[] = [], draft = false) => ({ kind: "Event spec" as const, id, name, versions, draft });

  it("is null when nothing uses the asset", () => {
    expect(assetInUseError("Trait", "CloudEvents", found([]))).toBeNull();
  });

  it("names a published user with its versions and tells to delete the owner (published versions are immutable)", () => {
    const error = assetInUseError("Trait", "CloudEvents", found([msg("m1", "OrderCreated", ["1.0", "1.1"])]));
    expect(error).toEqual({
      code: "IN_USE",
      message: 'Trait "CloudEvents" cannot be deleted: it is used by Message "OrderCreated" (v1.0, v1.1).',
      details: { referrers: [msg("m1", "OrderCreated", ["1.0", "1.1"])], truncated: false },
      suggestedFix: 'Published versions cannot be changed, so delete message "OrderCreated" (which removes its published versions) first, or keep the trait.',
    });
  });

  it("marks drafts, combines kinds and caps versions per owner", () => {
    const error = assetInUseError(
      "Channel",
      "orders",
      found([msg("m1", "A", ["1.0", "1.1", "2.0", "2.1", "3.0"], true), spec("s1", "feed", [], true), spec("s2", "other", ["1.0"])])
    );
    expect(error?.message).toBe(
      'Channel "orders" cannot be deleted: it is used by Message "A" (v1.0, v1.1, v2.0, 2 more, draft) and Event specs "feed" (draft), "other" (v1.0).'
    );
    expect(error?.suggestedFix).toBe(
      'Published versions cannot be changed, so delete message "A" (which removes its published versions) and the other users listed first, or keep the channel.'
    );
  });

  it("a draft-only user is fixed by editing the draft", () => {
    expect(assetInUseError("Channel", "orders", found([spec("s1", "feed", [], true)]))?.suggestedFix).toBe(
      'Remove the channel from "feed" first, or keep the channel.'
    );
    expect(assetInUseError("Trait", "t", found([msg("m1", "A", [], true), msg("m2", "B", [], true)]))?.suggestedFix).toBe(
      "Remove the trait from the drafts listed first, or keep the trait."
    );
  });

  it("caps the named users and reports the rest (and a truncated scan)", () => {
    const many = ["A", "B", "C", "D", "E", "F", "G"].map((n, i) => msg(`m${i}`, n, [], true));
    expect(assetInUseError("Trait", "t", found(many))?.message).toBe(
      'Trait "t" cannot be deleted: it is used by Messages "A" (draft), "B" (draft), "C" (draft), "D" (draft), "E" (draft), and 2 more.'
    );
    expect(assetInUseError("Trait", "t", found(many, true))?.message).toContain(", and 2+ more.");
    expect(assetInUseError("Trait", "t", found([msg("m1", "A", [], true)], true))?.message).toBe(
      'Trait "t" cannot be deleted: it is used by Message "A" (draft), and more.'
    );
    expect((assetInUseError("Trait", "t", found(many))?.details as { referrers: unknown[] }).referrers).toHaveLength(7);
  });
});
