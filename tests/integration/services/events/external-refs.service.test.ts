import "dotenv/config"; // first: @/lib/db (pulled in by the services) reads DB_PROVIDER at import time
import { afterAll, describe, expect, it } from "vitest";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import { cleanupDomains, connectTestDb, createEventSpecVersion, createProductScope, stamp, TENANT, testContext, unwrap } from "./helpers";
import { createForeignTenantFixture } from "./foreign-tenant-fixture";
import { emptyEventDocument } from "@/lib/events/document/types";
import {
  getExternalRefStatuses, getExternalVersionItems, listExternalEventCandidates, listExternalEventVersions, requireOwnedEvent,
} from "@/services/events/external-refs.service";

const prisma = connectTestDb();
const domainIds: string[] = [];
afterAll(async () => {
  await cleanupDomains(prisma, domainIds);
  await prisma.$disconnect();
});

type Scope = Awaited<ReturnType<typeof createProductScope>>;
type Item = { id: string; title?: string; summary?: string; description?: string };

async function setup() {
  const ctx = await testContext(prisma);
  return { ctx };
}

/** A fresh domain + product in the default tenant (cleaned up after the file). */
async function product(ctx: ServiceContext, label: string): Promise<Scope> {
  const scope = await createProductScope(prisma, ctx, label);
  domainIds.push(scope.domain.id);
  return scope;
}

/** What `resolveDocument` stores at publish, reduced to the fields the loaders read (ids are the document keys, spec 18 §7). */
const resolved = (channels: Item[], messages: Item[]): Prisma.InputJsonValue => ({
  productSlug: "src", info: { title: "src", version: "1.0" }, servers: [], operations: [], traits: [], components: {},
  channels: channels.map((c) => ({ name: c.id, productSlug: "src", address: `${c.id}.v1`, protocol: "kafka", profile: { format: "avro" }, ...c })),
  messages: messages.map((m) => ({ name: m.id, productSlug: "src", traitRefs: [], payloads: [{ format: "avro", schema: { type: "record", name: m.id, fields: [] } }], ...m })),
});

async function createEvent(sc: { domain: { id: string }; product: { id: string } }, tenantId: string, name: string) {
  return prisma.eventSpec.create({
    data: { name, document: emptyEventDocument(name) as unknown as Prisma.InputJsonValue, tenantId, domainId: sc.domain.id, productId: sc.product.id },
  });
}

/** One published version row; `spec: null` is a version published before document v2. It becomes the event's latest unless told not to. */
async function publish(
  ctx: ServiceContext, eventId: string, v: { major: number; minor: number; sequence: number; kind?: "INITIAL" | "MINOR" | "MAJOR"; spec: Prisma.InputJsonValue | null; latest?: boolean }
) {
  const row = await createEventSpecVersion(prisma, {
    eventSpecId: eventId, major: v.major, minor: v.minor, sequence: v.sequence, document: {}, sourceDocument: {}, frozenTraits: [],
    changeKind: v.kind ?? "MINOR", publishedById: ctx.userId, ...(v.spec === null ? {} : { resolvedSpec: v.spec }),
  });
  if (v.latest !== false) await prisma.eventSpec.update({ where: { id: eventId }, data: { latestVersionId: row.id, hasUnpublishedChanges: false } });
  return row;
}

const ORDERS: Item[] = [{ id: "orders", title: "Orders", summary: "All order events" }];
const ORDER_MESSAGES: Item[] = [{ id: "OrderCreated", title: "Order created", summary: "An order was placed" }, { id: "OrderShipped" }];

const failureOf = (r: Result<unknown>) => (r.success ? null : r.error);

/** A Proxy over a Prisma object whose listed members are replaced; everything else is the real thing. */
function replacing<T extends object>(target: T, overrides: Record<string, unknown>): T {
  return new Proxy(target, { get: (t, p) => (typeof p === "string" && p in overrides ? overrides[p] : Reflect.get(t, p)) });
}
const asPrisma = (p: object) => p as unknown as PrismaClient;

describe("listExternalEventCandidates", () => {
  it("offers published events of the tenant, never the event itself, unpublished events or another tenant's", async () => {
    const { ctx } = await setup();
    const a = await product(ctx, "extsrc");
    const b = await product(ctx, "extuse");
    const orders = await createEvent(a, TENANT, `orders-${a.s}`);
    const payments = await createEvent(a, TENANT, `payments-${a.s}`);
    const billing = await createEvent(b, TENANT, `billing-${a.s}`);
    await createEvent(a, TENANT, `draft-only-${a.s}`);
    const preV2 = await createEvent(a, TENANT, `legacy-${a.s}`);
    await publish(ctx, orders.id, { major: 1, minor: 0, sequence: 1, kind: "INITIAL", spec: resolved(ORDERS, ORDER_MESSAGES) });
    await publish(ctx, payments.id, { major: 1, minor: 0, sequence: 1, kind: "INITIAL", spec: resolved([], []) });
    await publish(ctx, billing.id, { major: 1, minor: 0, sequence: 1, kind: "INITIAL", spec: resolved([], []) });
    await publish(ctx, preV2.id, { major: 1, minor: 0, sequence: 1, kind: "INITIAL", spec: null });

    const found = unwrap(await listExternalEventCandidates(ctx, { tenantId: TENANT, excludeEventId: billing.id, query: a.s }));
    expect(found.map((c) => c.eventName)).toEqual([`orders-${a.s}`, `payments-${a.s}`]);
    const latest = await prisma.eventSpec.findUniqueOrThrow({ where: { id: orders.id }, select: { latestVersionId: true } });
    expect(found[0]).toEqual({
      eventId: orders.id, eventName: `orders-${a.s}`, domainName: a.domain.name, productName: a.product.name,
      latestVersionId: latest.latestVersionId, latestLabel: "1.0",
    });

    // the event itself is never offered, whichever product it is in; the other products' events are
    const self = unwrap(await listExternalEventCandidates(ctx, { tenantId: TENANT, excludeEventId: orders.id, query: a.s }));
    expect(self.map((c) => c.eventId)).toEqual([billing.id, payments.id]);

    // another tenant's published event is not visible from the default tenant, and is from its own
    const foreign = await createForeignTenantFixture(prisma, ctx);
    try {
      const theirs = await createEvent(foreign, foreign.tenant.id, `theirs-${a.s}`);
      await publish(ctx, theirs.id, { major: 1, minor: 0, sequence: 1, kind: "INITIAL", spec: resolved([], []) });
      const fromHere = unwrap(await listExternalEventCandidates(ctx, { tenantId: TENANT, excludeEventId: billing.id, query: a.s }));
      expect(fromHere.map((c) => c.eventName)).not.toContain(`theirs-${a.s}`);
      const fromThere = unwrap(await listExternalEventCandidates(ctx, { tenantId: foreign.tenant.id, excludeEventId: "none", query: a.s }));
      expect(fromThere.map((c) => c.eventName)).toEqual([`theirs-${a.s}`]);
    } finally {
      await foreign.cleanup();
    }
  }, 60_000);

  it("offers an event's latest version, not an older one", async () => {
    const { ctx } = await setup();
    const a = await product(ctx, "extsrc");
    const orders = await createEvent(a, TENANT, `orders-${a.s}`);
    await publish(ctx, orders.id, { major: 1, minor: 0, sequence: 1, kind: "INITIAL", spec: resolved(ORDERS, []), latest: false });
    const v2 = await publish(ctx, orders.id, { major: 2, minor: 0, sequence: 2, kind: "MAJOR", spec: resolved(ORDERS, []) });
    const found = unwrap(await listExternalEventCandidates(ctx, { tenantId: TENANT, excludeEventId: "none", query: a.s }));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ latestVersionId: v2.id, latestLabel: "2.0" });
  });

  it("searches the event, domain and product name, case-insensitively, and treats the query as text", async () => {
    const { ctx } = await setup();
    const a = await product(ctx, "extsrc");
    const orders = await createEvent(a, TENANT, `Orders_${a.s}`);
    const payments = await createEvent(a, TENANT, `payments-${a.s}`);
    for (const e of [orders, payments]) await publish(ctx, e.id, { major: 1, minor: 0, sequence: 1, kind: "INITIAL", spec: resolved([], []) });
    const names = async (query?: string) => unwrap(await listExternalEventCandidates(ctx, { tenantId: TENANT, excludeEventId: "none", query })).map((c) => c.eventName);

    expect(await names(`ORDERS_${a.s.toUpperCase()}`)).toEqual([`Orders_${a.s}`]); // event name, case-insensitive
    expect(await names(`extsrc-${a.s}`)).toEqual([`Orders_${a.s}`, `payments-${a.s}`]); // domain name only ("extsrc " + s is the product)
    expect(await names(`EXTSRC ${a.s}`)).toEqual([`Orders_${a.s}`, `payments-${a.s}`]); // product name only
    expect(await names(`  payments-${a.s}  `)).toEqual([`payments-${a.s}`]); // trimmed
    expect(await names(`${a.s}-nothing`)).toEqual([]);
    expect((await names(`Orders_${a.s}`)).length).toBe(1);
    // `_` and `%` are not wildcards: "Orders?<stamp>" does not match "Orders_<stamp>"
    expect(await names(`Orders%${a.s}`)).toEqual([]);
    expect(await names(`Order__${a.s}`)).toEqual([]);
    expect(await names(`Orders\\${a.s}`)).toEqual([]); // nor is a backslash an escape
    // blank query = no filter (only that something comes back; the shared database has other events)
    expect((await names("   ")).length).toBeGreaterThan(0);
  }, 60_000);

  it("limits the answer: 25 by default, at most 50, at least 1", async () => {
    const { ctx } = await setup();
    const taken: number[] = [];
    const spying: ServiceContext = {
      ...ctx,
      prisma: asPrisma(replacing(prisma, {
        eventSpec: replacing(prisma.eventSpec, {
          findMany: (args: { take: number }) => {
            taken.push(args.take);
            return prisma.eventSpec.findMany(args as never);
          },
        }),
      })),
    };
    const base = { tenantId: TENANT, excludeEventId: "none", query: stamp() };
    unwrap(await listExternalEventCandidates(spying, base));
    unwrap(await listExternalEventCandidates(spying, { ...base, limit: 10 }));
    unwrap(await listExternalEventCandidates(spying, { ...base, limit: 500 }));
    unwrap(await listExternalEventCandidates(spying, { ...base, limit: 0 }));
    expect(taken).toEqual([25, 10, 50, 1]);
  });

  it("returns the first events by name when more match than the limit", async () => {
    const { ctx } = await setup();
    const a = await product(ctx, "extsrc");
    for (const name of ["c", "a", "b"]) {
      const e = await createEvent(a, TENANT, `${name}-${a.s}`);
      await publish(ctx, e.id, { major: 1, minor: 0, sequence: 1, kind: "INITIAL", spec: resolved([], []) });
    }
    const found = unwrap(await listExternalEventCandidates(ctx, { tenantId: TENANT, excludeEventId: "none", query: a.s, limit: 2 }));
    expect(found.map((c) => c.eventName)).toEqual([`a-${a.s}`, `b-${a.s}`]);
  }, 60_000);

  it("rejects malformed input before any query", async () => {
    const { ctx } = await setup();
    const bad = async (input: unknown) => failureOf(await listExternalEventCandidates(ctx, input as never))?.code;
    expect(await bad({ tenantId: "", excludeEventId: "e" })).toBe("VALIDATION_ERROR");
    expect(await bad({ tenantId: TENANT, excludeEventId: 7 })).toBe("VALIDATION_ERROR");
    expect(await bad({ tenantId: TENANT, excludeEventId: "e", query: { contains: "x" } })).toBe("VALIDATION_ERROR");
    expect(await bad({ tenantId: TENANT, excludeEventId: "e", limit: "many" })).toBe("VALIDATION_ERROR");
    expect(await bad({ tenantId: TENANT, excludeEventId: "e", limit: Number.NaN })).toBe("VALIDATION_ERROR");
    expect(await bad(null)).toBe("VALIDATION_ERROR");
  });
});

describe("requireOwnedEvent", () => {
  it("returns the id of an event of the product, and refuses another product's or tenant's, an unknown id and a malformed one", async () => {
    const { ctx } = await setup();
    const a = await product(ctx, "extsrc");
    const b = await product(ctx, "extuse");
    const mine = await createEvent(a, TENANT, `mine-${a.s}`);
    const sibling = await createEvent(b, TENANT, `sibling-${a.s}`);
    const owner = { level: "PRODUCT" as const, productId: a.product.id };
    expect(unwrap(await requireOwnedEvent(ctx, mine.id, owner))).toBe(mine.id);
    expect(failureOf(await requireOwnedEvent(ctx, sibling.id, owner))?.code).toBe("FORBIDDEN");
    expect(failureOf(await requireOwnedEvent(ctx, "no-such-event", owner))?.code).toBe("NOT_FOUND");
    expect(failureOf(await requireOwnedEvent(ctx, 7, owner))?.code).toBe("VALIDATION_ERROR");
    expect(failureOf(await requireOwnedEvent(ctx, "", owner))?.code).toBe("VALIDATION_ERROR");
    expect(failureOf(await requireOwnedEvent(ctx, mine.id, { level: "PRODUCT", productId: "no-such-product" }))?.code).toBe("NOT_FOUND");

    const foreign = await createForeignTenantFixture(prisma, ctx);
    try {
      const theirs = await createEvent(foreign, foreign.tenant.id, `theirs-${foreign.s}`);
      const denied = failureOf(await requireOwnedEvent(ctx, theirs.id, owner));
      expect(denied?.code).toBe("FORBIDDEN");
      expect(JSON.stringify(denied)).not.toContain(`theirs-${foreign.s}`);
    } finally {
      await foreign.cleanup();
    }
  }, 60_000);
});

describe("listExternalEventVersions", () => {
  it("lists the versions that carry a resolved spec, newest first", async () => {
    const { ctx } = await setup();
    const a = await product(ctx, "extsrc");
    const orders = await createEvent(a, TENANT, `orders-${a.s}`);
    await publish(ctx, orders.id, { major: 1, minor: 0, sequence: 1, kind: "INITIAL", spec: null, latest: false });
    const v11 = await publish(ctx, orders.id, { major: 1, minor: 1, sequence: 2, spec: resolved(ORDERS, []), latest: false });
    const v12 = await publish(ctx, orders.id, { major: 1, minor: 2, sequence: 3, spec: resolved(ORDERS, []), latest: false });
    const v20 = await publish(ctx, orders.id, { major: 2, minor: 0, sequence: 4, kind: "MAJOR", spec: resolved(ORDERS, []) });

    const versions = unwrap(await listExternalEventVersions(ctx, { tenantId: TENANT, eventId: orders.id }));
    expect(versions.map((v) => [v.versionId, v.label])).toEqual([[v20.id, "2.0"], [v12.id, "1.2"], [v11.id, "1.1"]]);
    expect(versions[0].publishedAt).toBe(v20.publishedAt.toISOString());
  });

  it("is an empty list for an event that was never published", async () => {
    const { ctx } = await setup();
    const a = await product(ctx, "extsrc");
    const draft = await createEvent(a, TENANT, `draft-${a.s}`);
    expect(unwrap(await listExternalEventVersions(ctx, { tenantId: TENANT, eventId: draft.id }))).toEqual([]);
  });

  it("answers NOT_FOUND for an unknown event and for another tenant's, without naming it", async () => {
    const { ctx } = await setup();
    const foreign = await createForeignTenantFixture(prisma, ctx);
    try {
      const secret = await createEvent(foreign, foreign.tenant.id, `secret-${foreign.s}`);
      await publish(ctx, secret.id, { major: 1, minor: 0, sequence: 1, kind: "INITIAL", spec: resolved([], []) });
      const theirs = failureOf(await listExternalEventVersions(ctx, { tenantId: TENANT, eventId: secret.id }));
      const unknown = failureOf(await listExternalEventVersions(ctx, { tenantId: TENANT, eventId: "no-such-event" }));
      expect(theirs?.code).toBe("NOT_FOUND");
      expect(unknown?.code).toBe("NOT_FOUND");
      expect(JSON.stringify(theirs)).not.toContain(`secret-${foreign.s}`);
      expect(theirs?.message).toBe(`Event "${secret.id}" not found`);
    } finally {
      await foreign.cleanup();
    }
  }, 60_000);

  it("rejects a blank tenant or event id", async () => {
    const { ctx } = await setup();
    expect(failureOf(await listExternalEventVersions(ctx, { tenantId: "", eventId: "e" }))?.code).toBe("VALIDATION_ERROR");
    expect(failureOf(await listExternalEventVersions(ctx, { tenantId: TENANT, eventId: " " }))?.code).toBe("VALIDATION_ERROR");
  });
});

describe("getExternalVersionItems", () => {
  it("lists the channels and messages of a version with their titles and summaries", async () => {
    const { ctx } = await setup();
    const a = await product(ctx, "extsrc");
    const orders = await createEvent(a, TENANT, `orders-${a.s}`);
    const channels: Item[] = [...ORDERS, { id: "refunds", description: "Refund events" }];
    const v = await publish(ctx, orders.id, { major: 1, minor: 3, sequence: 1, spec: resolved(channels, ORDER_MESSAGES) });

    const items = unwrap(await getExternalVersionItems(ctx, { tenantId: TENANT, eventVersionId: v.id }));
    expect(items).toEqual({
      eventName: `orders-${a.s}`, label: "1.3",
      channels: [{ key: "orders", title: "Orders", summary: "All order events" }, { key: "refunds", description: "Refund events" }],
      messages: [{ key: "OrderCreated", title: "Order created", summary: "An order was placed" }, { key: "OrderShipped" }],
    });
  });

  it("skips what is malformed in the stored spec instead of throwing", async () => {
    const { ctx } = await setup();
    const a = await product(ctx, "extsrc");
    const odd = await createEvent(a, TENANT, `odd-${a.s}`);
    const messy = await publish(ctx, odd.id, {
      major: 1, minor: 0, sequence: 1, kind: "INITIAL", latest: false,
      spec: { channels: "oops", messages: [null, 3, { id: 5 }, { name: "no-id" }, { id: "M", title: 9, summary: "ok" }] },
    });
    expect(unwrap(await getExternalVersionItems(ctx, { tenantId: TENANT, eventVersionId: messy.id }))).toEqual({
      eventName: `odd-${a.s}`, label: "1.0", channels: [], messages: [{ key: "M", summary: "ok" }],
    });
    // a JSON value that is not an object, and a version published before document v2 (no resolved spec at all)
    const notObjects: Array<Prisma.InputJsonValue | null> = ["text", [1, 2], null];
    for (const [i, spec] of notObjects.entries()) {
      const e = await createEvent(a, TENANT, `odd${i}-${a.s}`);
      const v = await publish(ctx, e.id, { major: 1, minor: 0, sequence: 1, kind: "INITIAL", spec, latest: false });
      expect(unwrap(await getExternalVersionItems(ctx, { tenantId: TENANT, eventVersionId: v.id }))).toMatchObject({ channels: [], messages: [] });
    }
  }, 60_000);

  it("answers NOT_FOUND for an unknown version and for another tenant's, without naming its event", async () => {
    const { ctx } = await setup();
    const foreign = await createForeignTenantFixture(prisma, ctx);
    try {
      const secret = await createEvent(foreign, foreign.tenant.id, `secret-${foreign.s}`);
      const v = await publish(ctx, secret.id, { major: 1, minor: 0, sequence: 1, kind: "INITIAL", spec: resolved(ORDERS, ORDER_MESSAGES) });
      const theirs = failureOf(await getExternalVersionItems(ctx, { tenantId: TENANT, eventVersionId: v.id }));
      const unknown = failureOf(await getExternalVersionItems(ctx, { tenantId: TENANT, eventVersionId: "no-such-version" }));
      expect(theirs?.code).toBe("NOT_FOUND");
      expect(unknown?.code).toBe("NOT_FOUND");
      expect(JSON.stringify(theirs)).not.toContain(`secret-${foreign.s}`);
      expect(theirs?.message).toBe(`Event version "${v.id}" not found`);
      // the same version is readable from its own tenant
      expect(unwrap(await getExternalVersionItems(ctx, { tenantId: foreign.tenant.id, eventVersionId: v.id })).eventName).toBe(`secret-${foreign.s}`);
    } finally {
      await foreign.cleanup();
    }
  }, 60_000);

  it("rejects a blank version id", async () => {
    const { ctx } = await setup();
    expect(failureOf(await getExternalVersionItems(ctx, { tenantId: TENANT, eventVersionId: "" }))?.code).toBe("VALIDATION_ERROR");
  });
});

describe("getExternalRefStatuses", () => {
  it("is not newer while the referenced version is the latest, then newer (minor), then newer and major, naming a dropped item", async () => {
    const { ctx } = await setup();
    const a = await product(ctx, "extsrc");
    const orders = await createEvent(a, TENANT, `orders-${a.s}`);
    const v10 = await publish(ctx, orders.id, { major: 1, minor: 0, sequence: 1, kind: "INITIAL", spec: resolved(ORDERS, ORDER_MESSAGES) });
    const refs = [
      { eventVersionId: v10.id, kind: "channel" as const, itemKey: "orders" },
      { eventVersionId: v10.id, kind: "message" as const, itemKey: "OrderCreated" },
    ];
    const statuses = async () => unwrap(await getExternalRefStatuses(ctx, { tenantId: TENANT, refs }));

    expect(await statuses()).toEqual([{
      eventVersionId: v10.id, eventId: orders.id, eventName: `orders-${a.s}`, label: "1.0", latestVersionId: v10.id, latestLabel: "1.0",
      newerAvailable: false, newerIsMajor: false, itemsMissingInLatest: [],
    }]);

    const v11 = await publish(ctx, orders.id, { major: 1, minor: 1, sequence: 2, spec: resolved(ORDERS, ORDER_MESSAGES) });
    expect(await statuses()).toEqual([expect.objectContaining({
      eventVersionId: v10.id, label: "1.0", latestVersionId: v11.id, latestLabel: "1.1", newerAvailable: true, newerIsMajor: false, itemsMissingInLatest: [],
    })]);

    // 2.0 drops the OrderCreated message
    const v20 = await publish(ctx, orders.id, { major: 2, minor: 0, sequence: 3, kind: "MAJOR", spec: resolved(ORDERS, [{ id: "OrderShipped" }]) });
    expect(await statuses()).toEqual([expect.objectContaining({
      eventVersionId: v10.id, label: "1.0", latestVersionId: v20.id, latestLabel: "2.0", newerAvailable: true, newerIsMajor: true, itemsMissingInLatest: ["OrderCreated"],
    })]);

    // a reference to the minor version: still newer and major, and its dropped item is named too
    const viaMinor = unwrap(await getExternalRefStatuses(ctx, { tenantId: TENANT, refs: [{ eventVersionId: v11.id, kind: "message", itemKey: "OrderCreated" }] }));
    expect(viaMinor[0]).toMatchObject({ label: "1.1", latestLabel: "2.0", newerIsMajor: true, itemsMissingInLatest: ["OrderCreated"] });
  }, 60_000);

  it("looks a dropped channel up among the channels and a dropped message among the messages", async () => {
    const { ctx } = await setup();
    const a = await product(ctx, "extsrc");
    const orders = await createEvent(a, TENANT, `orders-${a.s}`);
    const v10 = await publish(ctx, orders.id, { major: 1, minor: 0, sequence: 1, kind: "INITIAL", spec: resolved([{ id: "shared" }], []) });
    await publish(ctx, orders.id, { major: 1, minor: 1, sequence: 2, spec: resolved([], [{ id: "shared" }]) });
    const [s] = unwrap(await getExternalRefStatuses(ctx, { tenantId: TENANT, refs: [{ eventVersionId: v10.id, kind: "channel", itemKey: "shared" }] }));
    expect(s).toMatchObject({ newerAvailable: true, newerIsMajor: false, itemsMissingInLatest: ["shared"] });
  });

  it("answers once per referenced version, in the order the versions first appear, across events", async () => {
    const { ctx } = await setup();
    const a = await product(ctx, "extsrc");
    const orders = await createEvent(a, TENANT, `orders-${a.s}`);
    const payments = await createEvent(a, TENANT, `payments-${a.s}`);
    const o = await publish(ctx, orders.id, { major: 1, minor: 0, sequence: 1, kind: "INITIAL", spec: resolved(ORDERS, ORDER_MESSAGES) });
    const p = await publish(ctx, payments.id, { major: 1, minor: 0, sequence: 1, kind: "INITIAL", spec: resolved([{ id: "pay" }], []) });
    const statuses = unwrap(await getExternalRefStatuses(ctx, {
      tenantId: TENANT,
      refs: [
        { eventVersionId: p.id, kind: "channel", itemKey: "pay" },
        { eventVersionId: o.id, kind: "channel", itemKey: "orders" },
        { eventVersionId: p.id, kind: "channel", itemKey: "pay" },
        { eventVersionId: o.id, kind: "message", itemKey: "OrderShipped" },
      ],
    }));
    expect(statuses.map((s) => [s.eventVersionId, s.eventName])).toEqual([[p.id, `payments-${a.s}`], [o.id, `orders-${a.s}`]]);
  });

  it("is an empty answer for no references", async () => {
    const { ctx } = await setup();
    expect(unwrap(await getExternalRefStatuses(ctx, { tenantId: TENANT, refs: [] }))).toEqual([]);
  });

  it("treats a version with no recorded latest as its own latest, and a latest without a usable spec as having dropped everything", async () => {
    const { ctx } = await setup();
    const a = await product(ctx, "extsrc");
    const loose = await createEvent(a, TENANT, `loose-${a.s}`);
    const only = await publish(ctx, loose.id, { major: 1, minor: 0, sequence: 1, kind: "INITIAL", spec: resolved(ORDERS, []), latest: false });
    const [s] = unwrap(await getExternalRefStatuses(ctx, { tenantId: TENANT, refs: [{ eventVersionId: only.id, kind: "channel", itemKey: "orders" }] }));
    expect(s).toMatchObject({ latestVersionId: only.id, latestLabel: "1.0", newerAvailable: false, newerIsMajor: false, itemsMissingInLatest: [] });

    const odd = await createEvent(a, TENANT, `odd-${a.s}`);
    const v10 = await publish(ctx, odd.id, { major: 1, minor: 0, sequence: 1, kind: "INITIAL", spec: resolved(ORDERS, []), latest: false });
    await publish(ctx, odd.id, { major: 1, minor: 1, sequence: 2, spec: "corrupt" });
    const [t] = unwrap(await getExternalRefStatuses(ctx, { tenantId: TENANT, refs: [{ eventVersionId: v10.id, kind: "channel", itemKey: "orders" }] }));
    expect(t).toMatchObject({ latestLabel: "1.1", newerAvailable: true, itemsMissingInLatest: ["orders"] });
  }, 60_000);

  it("answers NOT_FOUND when a reference points at an unknown version or another tenant's, without naming its event", async () => {
    const { ctx } = await setup();
    const a = await product(ctx, "extsrc");
    const orders = await createEvent(a, TENANT, `orders-${a.s}`);
    const mine = await publish(ctx, orders.id, { major: 1, minor: 0, sequence: 1, kind: "INITIAL", spec: resolved(ORDERS, []) });
    const foreign = await createForeignTenantFixture(prisma, ctx);
    try {
      const secret = await createEvent(foreign, foreign.tenant.id, `secret-${foreign.s}`);
      const theirs = await publish(ctx, secret.id, { major: 1, minor: 0, sequence: 1, kind: "INITIAL", spec: resolved(ORDERS, []) });
      const own = { eventVersionId: mine.id, kind: "channel" as const, itemKey: "orders" };
      const foreignRef = { eventVersionId: theirs.id, kind: "channel" as const, itemKey: "orders" };
      const failure = failureOf(await getExternalRefStatuses(ctx, { tenantId: TENANT, refs: [own, foreignRef] }));
      expect(failure?.code).toBe("NOT_FOUND");
      expect(JSON.stringify(failure)).not.toContain(`secret-${foreign.s}`);
      expect(failure?.message).toBe(`Event version "${theirs.id}" not found`);
      expect(failureOf(await getExternalRefStatuses(ctx, { tenantId: TENANT, refs: [{ ...own, eventVersionId: "no-such-version" }] }))?.code).toBe("NOT_FOUND");
      expect(unwrap(await getExternalRefStatuses(ctx, { tenantId: foreign.tenant.id, refs: [foreignRef] }))).toHaveLength(1);
    } finally {
      await foreign.cleanup();
    }
  }, 60_000);

  it("rejects malformed references and too many of them", async () => {
    const { ctx } = await setup();
    const bad = async (refs: unknown) => failureOf(await getExternalRefStatuses(ctx, { tenantId: TENANT, refs } as never))?.code;
    const ok = { eventVersionId: "v", kind: "channel", itemKey: "k" };
    expect(await bad("nope")).toBe("VALIDATION_ERROR");
    expect(await bad([null])).toBe("VALIDATION_ERROR");
    expect(await bad([{ ...ok, eventVersionId: "" }])).toBe("VALIDATION_ERROR");
    expect(await bad([{ ...ok, kind: "operation" }])).toBe("VALIDATION_ERROR");
    expect(await bad([{ ...ok, itemKey: 3 }])).toBe("VALIDATION_ERROR");
    expect(await bad([{ ...ok, itemKey: "" }])).toBe("VALIDATION_ERROR");
    expect(await bad(Array.from({ length: 201 }, () => ok))).toBe("VALIDATION_ERROR");
    expect(failureOf(await getExternalRefStatuses(ctx, { tenantId: "", refs: [] }))?.code).toBe("VALIDATION_ERROR");
  });
});

describe("database failures", () => {
  it("surface as a generic DB_ERROR that carries no driver text, never as a throw", async () => {
    const { ctx } = await setup();
    const lost = () => Promise.reject(new Error("connection lost: host=db.internal table=event_specs"));
    const broken: ServiceContext = {
      ...ctx,
      prisma: asPrisma(replacing(prisma, {
        eventSpec: replacing(prisma.eventSpec, { findMany: lost, findFirst: lost, findUnique: lost }),
        eventSpecVersion: replacing(prisma.eventSpecVersion, { findMany: lost, findFirst: lost, findUnique: lost }),
      })),
    };
    const results = [
      await listExternalEventCandidates(broken, { tenantId: TENANT, excludeEventId: "e" }),
      await listExternalEventVersions(broken, { tenantId: TENANT, eventId: "e" }),
      await getExternalVersionItems(broken, { tenantId: TENANT, eventVersionId: "v" }),
      await getExternalRefStatuses(broken, { tenantId: TENANT, refs: [{ eventVersionId: "v", kind: "channel", itemKey: "k" }] }),
    ];
    for (const r of results) {
      expect(failureOf(r)?.code).toBe("DB_ERROR");
      expect(JSON.stringify(failureOf(r))).not.toContain("db.internal");
    }
  });
});
