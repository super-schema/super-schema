import "dotenv/config"; // first: @/lib/db (pulled in by the loader) reads DB_PROVIDER at import time
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";
import { loadEventsList, type EventListItem } from "@/features/events/event-page/load-events-list";
import { cleanupDomains, connectTestDb, createEventSpecVersion, createProductScope, TENANT, testContext } from "./helpers";
import { createForeignTenantFixture } from "./foreign-tenant-fixture";

/** `loadEventsList` against the real database; rows are written directly (no audit rows). */

let prisma: PrismaClient;
let ctx: ServiceContext;
let own: Awaited<ReturnType<typeof createProductScope>>;
let foreign: Awaited<ReturnType<typeof createForeignTenantFixture>>;

let entityId: string;
let busy: { id: string; name: string };
let quiet: { id: string; name: string };
let published: { id: string; name: string };
let legacy: { id: string; name: string };
let garbage: { id: string; name: string };
let emptyProduct: { id: string; name: string; slug: string };
let siblingProduct: { id: string; name: string; slug: string };
let siblingEvent: { id: string; name: string };
let foreignEvent: { id: string; name: string };

const at = () => ({ tenantId: TENANT, domainId: own.domain.id, productId: own.product.id });
const ids = (items: EventListItem[]) => items.map((i) => i.id);
const list = () => loadEventsList({ tenantId: TENANT, productId: own.product.id, domainSlug: own.domain.slug, productSlug: own.product.slug });

/** 2 channels, 3 messages, 1 operation. */
function busyDocument(title: string): EventDocument {
  const pin = { entityId, entityVersionId: null };
  return {
    ...emptyEventDocument(title),
    channels: [
      { key: "orders", address: "orders.v1", protocol: "kafka", serverKeys: [], format: "avro", messageKeys: ["OrderCreated", "OrderPaid"] },
      { key: "refunds", address: null, protocol: "kafka", serverKeys: [], format: "avro", messageKeys: ["OrderRefunded"] },
    ],
    messages: [
      { key: "OrderCreated", payload: pin, traitKeys: [] },
      { key: "OrderPaid", payload: pin, traitKeys: [] },
      { key: "OrderRefunded", payload: pin, traitKeys: [] },
    ],
    operations: [{ key: "publishOrders", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: [] }],
  };
}

async function createRow(where: { tenantId: string; domainId: string; productId: string }, name: string, document: object) {
  return prisma.eventSpec.create({ data: { name, ...where, document } });
}

beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
  try {
    own = await createProductScope(prisma, ctx, "lel");
    entityId = (await own.entity(`Payload${own.s}`)).id;
    // Names sort by their first letter (the shared suffix is equal), whatever the database collation.
    busy = await createRow(at(), `b-busy-${own.s}`, busyDocument("Busy"));
    quiet = await createRow(at(), `c-quiet-${own.s}`, emptyEventDocument("Quiet"));
    published = await createRow(at(), `a-published-${own.s}`, emptyEventDocument("Published"));
    const version = await createEventSpecVersion(prisma, {
      eventSpecId: published.id, major: 3, minor: 1, sequence: 1, document: {}, sourceDocument: {}, frozenTraits: [],
      changeKind: "INITIAL", publishedById: ctx.userId,
    });
    await prisma.eventSpec.update({ where: { id: published.id }, data: { latestVersionId: version.id, hasUnpublishedChanges: false } });
    // Not v2: a v1 spec (catalog ids, no documentVersion) and a document that is not even an event spec.
    legacy = await createRow(at(), `d-legacy-${own.s}`, { info: { title: "Legacy" }, servers: [], operations: [{ key: "op", action: "send", channelId: "c1", messageVersionIds: [], traitIds: [] }] });
    garbage = await createRow(at(), `e-garbage-${own.s}`, { nonsense: true });

    emptyProduct = await prisma.product.create({ data: { domainId: own.domain.id, name: `empty ${own.s}`, slug: `lel-empty-${own.s}` } });
    siblingProduct = await prisma.product.create({ data: { domainId: own.domain.id, name: `sibling ${own.s}`, slug: `lel-sib-${own.s}` } });
    siblingEvent = await createRow({ ...at(), productId: siblingProduct.id }, `a-sibling-${own.s}`, emptyEventDocument("Sibling"));

    foreign = await createForeignTenantFixture(prisma, ctx);
    foreignEvent = await createRow(
      { tenantId: foreign.tenant.id, domainId: foreign.domain.id, productId: foreign.product.id }, `a-foreign-${foreign.s}`, emptyEventDocument("Foreign")
    );
  } catch (e) {
    await foreign?.cleanup().catch(() => undefined);
    await cleanupDomains(prisma, [own?.domain.id]);
    await prisma.$disconnect();
    throw e;
  }
}, 60_000);

afterAll(async () => {
  try {
    await foreign?.cleanup();
  } finally {
    try {
      await cleanupDomains(prisma, [own?.domain.id]);
    } finally {
      await prisma.$disconnect();
    }
  }
});

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => consoleError.mockRestore());

describe("loadEventsList", () => {
  it("lists only this product's v2 events, sorted by name", async () => {
    expect((await list()).map((i) => i.name)).toEqual([published.name, busy.name, quiet.name]);
  });

  it("returns exactly the list item shape, with counts read from the document and the canonical link", async () => {
    const byId = new Map((await list()).map((i) => [i.id, i]));
    const base = `/schemas/${own.domain.slug}/${own.product.slug}/events`;
    expect(byId.get(busy.id)).toEqual({
      id: busy.id, name: busy.name, specType: "asyncapi@3.0", versionLabel: null, hasUnpublishedChanges: true,
      channels: 2, messages: 3, operations: 1, href: `${base}/${busy.id}`,
    });
    expect(byId.get(quiet.id)).toEqual({
      id: quiet.id, name: quiet.name, specType: "asyncapi@3.0", versionLabel: null, hasUnpublishedChanges: true,
      channels: 0, messages: 0, operations: 0, href: `${base}/${quiet.id}`,
    });
  });

  it("carries the published version label and the unpublished flag", async () => {
    const item = (await list()).find((i) => i.id === published.id);
    expect(item).toMatchObject({ versionLabel: "3.1", hasUnpublishedChanges: false });
  });

  it("silently skips legacy v1 rows and rows whose document is not an event document", async () => {
    const items = await list();
    expect(ids(items)).not.toContain(legacy.id);
    expect(ids(items)).not.toContain(garbage.id);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("never lists another product's or another tenant's events", async () => {
    expect(ids(await list())).not.toContain(siblingEvent.id);
    expect(ids(await list())).not.toContain(foreignEvent.id);
    expect(ids(await loadEventsList({ tenantId: TENANT, productId: siblingProduct.id, domainSlug: own.domain.slug, productSlug: siblingProduct.slug }))).toEqual([siblingEvent.id]);
  });

  it("is empty for a product with no events", async () => {
    expect(await loadEventsList({ tenantId: TENANT, productId: emptyProduct.id, domainSlug: own.domain.slug, productSlug: emptyProduct.slug })).toEqual([]);
  });

  it("surfaces nothing for a forged product id of another tenant, or a forged tenant id", async () => {
    expect(await loadEventsList({ tenantId: TENANT, productId: foreign.product.id, domainSlug: "x", productSlug: "y" })).toEqual([]);
    expect(await loadEventsList({ tenantId: foreign.tenant.id, productId: own.product.id, domainSlug: "x", productSlug: "y" })).toEqual([]);
    // The foreign tenant's own list still works.
    expect(ids(await loadEventsList({ tenantId: foreign.tenant.id, productId: foreign.product.id, domainSlug: foreign.domain.slug, productSlug: foreign.product.slug }))).toEqual([foreignEvent.id]);
  });
});
