import "dotenv/config"; // first: @/lib/db (pulled in by the loader) reads DB_PROVIDER at import time
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";
import { cleanupDomains, cleanupTenantTraits, connectTestDb, createProductScope, TENANT, testContext } from "./helpers";
import { createForeignTenantFixture } from "./foreign-tenant-fixture";

/**
 * `loadEventPage` against the real database. Only the active tenant (reads a cookie) is replaced. Rows are written directly,
 * so no (immutable) audit rows are created.
 */
const h = vi.hoisted(() => ({ tenantId: "" }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: async () => h.tenantId }));

import { loadEventPage } from "@/features/events/event-page/load-event-page";

let prisma: PrismaClient;
let ctx: ServiceContext;
let own: Awaited<ReturnType<typeof createProductScope>>;
let elsewhere: Awaited<ReturnType<typeof createProductScope>>;
let foreign: Awaited<ReturnType<typeof createForeignTenantFixture>>;

let ownEntity: { id: string; name: string };
let mine: { id: string; name: string };
let published: { id: string; name: string };
let legacy: { id: string; name: string };
let sibling: { id: string; name: string };
let siblingProduct: { id: string; name: string; slug: string };
let otherDomain: { id: string; name: string };
let foreignEvent: { id: string };

/** Library traits: the ones the event may use (tenant level, its own domain) and the ones it must never be offered. */
const tenantTraitIds: string[] = [];
let libraryTraits: {
  tenantMessage: { id: string; name: string }; tenantOperation: { id: string; name: string };
  domainMessage: { id: string; name: string }; domainOperation: { id: string; name: string };
  productLevel: { id: string; name: string }; otherDomain: { id: string; name: string };
  foreignTenant: { id: string; name: string }; foreignTenantLevel: { id: string; name: string };
};

const SECRET_TITLE = "Secret title of another product's event";

function richDocument(title: string, entityId: string): EventDocument {
  return {
    ...emptyEventDocument(title, "A described event"),
    channels: [
      { key: "orders", address: "orders.v1", protocol: "kafka", serverKeys: [], format: "avro", messageKeys: ["OrderCreated", "OrderPaid"] },
      { key: "payments", address: null, protocol: "kafka", serverKeys: [], format: "json-schema", formatDialect: "2020-12", messageKeys: [] },
    ],
    messages: [
      { key: "OrderCreated", payload: { entityId, entityVersionId: null }, traitKeys: [] },
      { key: "OrderPaid", payload: { entityId, entityVersionId: null }, traitKeys: [] },
    ],
    operations: [{ key: "publishOrders", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: [] }],
  };
}

/** A stored document from before event documents v2: catalog ids, no `documentVersion`. */
const legacyDocument = (title: string) => ({
  info: { title },
  servers: [],
  operations: [{ key: "op", action: "send", channelId: "some-channel-id", messageVersionIds: ["some-message-version-id"], traitIds: [] }],
});

async function createEvent(at: { tenantId: string; domainId: string; productId: string }, name: string, document: object) {
  return prisma.eventSpec.create({ data: { name, ...at, document } });
}

const route = (eventId: string, extra: { tab?: string; section?: string; item?: string } = {}) =>
  loadEventPage({ domainSlug: own.domain.slug, productSlug: own.product.slug, eventId, ...extra });

beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
  h.tenantId = TENANT;
  try {
    own = await createProductScope(prisma, ctx, "lep");
    elsewhere = await createProductScope(prisma, ctx, "leo");
    const at = { tenantId: TENANT, domainId: own.domain.id, productId: own.product.id };
    ownEntity = await own.entity(`Payload${own.s}`);

    mine = await createEvent(at, `event-mine-${own.s}`, richDocument(`Mine ${own.s}`, ownEntity.id));
    published = await createEvent(at, `event-published-${own.s}`, richDocument(`Published ${own.s}`, ownEntity.id));
    const version = await prisma.eventSpecVersion.create({
      data: {
        eventSpecId: published.id, major: 1, minor: 2, sequence: 1, document: {}, sourceDocument: {}, frozenChannels: [], frozenTraits: [],
        messageVersionIds: [], changeKind: "INITIAL", publishedById: ctx.userId,
      },
    });
    await prisma.eventSpec.update({ where: { id: published.id }, data: { latestVersionId: version.id, hasUnpublishedChanges: false } });
    legacy = await createEvent(at, `event-legacy-${own.s}`, legacyDocument(SECRET_TITLE));

    siblingProduct = await prisma.product.create({ data: { domainId: own.domain.id, name: `sibling ${own.s}`, slug: `lep-sib-${own.s}` } });
    sibling = await createEvent({ ...at, productId: siblingProduct.id }, `event-sibling-${own.s}`, richDocument(SECRET_TITLE, ownEntity.id));
    otherDomain = await createEvent(
      { tenantId: TENANT, domainId: elsewhere.domain.id, productId: elsewhere.product.id }, `event-elsewhere-${own.s}`, richDocument(SECRET_TITLE, ownEntity.id)
    );

    foreign = await createForeignTenantFixture(prisma, ctx);
    foreignEvent = await createEvent(
      { tenantId: foreign.tenant.id, domainId: foreign.domain.id, productId: foreign.product.id }, `event-foreign-${foreign.s}`, richDocument(SECRET_TITLE, foreign.entity.id)
    );

    const trait = (name: string, kind: "MESSAGE" | "OPERATION", place: { tenantId: string; domainId?: string; productId?: string }) =>
      prisma.trait.create({ data: { name: `${name}-${own.s}`, kind, ...place }, select: { id: true, name: true } });
    const tenantMessage = await trait("TenantMsg", "MESSAGE", { tenantId: TENANT });
    const tenantOperation = await trait("TenantOp", "OPERATION", { tenantId: TENANT });
    tenantTraitIds.push(tenantMessage.id, tenantOperation.id);
    libraryTraits = {
      tenantMessage, tenantOperation,
      domainMessage: await trait("DomainMsg", "MESSAGE", { tenantId: TENANT, domainId: own.domain.id }),
      domainOperation: await trait("DomainOp", "OPERATION", { tenantId: TENANT, domainId: own.domain.id }),
      productLevel: await trait("ProductMsg", "MESSAGE", { tenantId: TENANT, domainId: own.domain.id, productId: own.product.id }),
      otherDomain: await trait("ElsewhereMsg", "MESSAGE", { tenantId: TENANT, domainId: elsewhere.domain.id }),
      // `foreign.trait` is the fixture's tenant-level trait; this one sits in the foreign tenant's own domain.
      foreignTenant: { id: foreign.trait.id, name: foreign.trait.name },
      foreignTenantLevel: await trait("ForeignDomainMsg", "MESSAGE", { tenantId: foreign.tenant.id, domainId: foreign.domain.id }),
    };
  } catch (e) {
    await foreign?.cleanup().catch(() => undefined);
    await cleanupTenantTraits(prisma, tenantTraitIds).catch(() => undefined);
    await cleanupDomains(prisma, [own?.domain.id, elsewhere?.domain.id]);
    await prisma.$disconnect();
    throw e;
  }
}, 60_000);

afterAll(async () => {
  try {
    await foreign?.cleanup();
  } finally {
    try {
      await cleanupTenantTraits(prisma, tenantTraitIds);
    } finally {
      try {
        await cleanupDomains(prisma, [own?.domain.id, elsewhere?.domain.id]);
      } finally {
        await prisma.$disconnect();
      }
    }
  }
});

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => consoleError.mockRestore());

describe("loadEventPage — this product's event", () => {
  it("loads the parsed v2 draft with its route, entity options and crumbs", async () => {
    const data = await route(mine.id);
    expect(data).not.toBeNull();
    expect(data!.event).toMatchObject({
      id: mine.id, name: mine.name, specType: "asyncapi@3.0", latestVersionLabel: null, hasUnpublishedChanges: true,
      tenantId: TENANT, domainId: own.domain.id, productId: own.product.id,
    });
    expect(data!.event.document).toEqual(richDocument(`Mine ${own.s}`, ownEntity.id));
    expect(data).toMatchObject({ productId: own.product.id, domainSlug: own.domain.slug, productSlug: own.product.slug });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("carries the published version label and the unpublished flag of the row", async () => {
    const data = await route(published.id);
    expect(data!.event).toMatchObject({ id: published.id, latestVersionLabel: "1.2", hasUnpublishedChanges: false });
  });

  it("offers the tenant's entities to the payload pins and none of another tenant's", async () => {
    const data = await route(mine.id);
    expect(data!.entityOptions).toContainEqual(expect.objectContaining({ id: ownEntity.id, name: ownEntity.name, ownerLabel: `${own.domain.name} / ${own.product.name}` }));
    expect(data!.entityOptions.map((o) => o.id)).not.toContain(foreign.entity.id);
  });

  it("builds Domains > Domain > Product > Events > event crumbs through assetHref", async () => {
    const data = await route(mine.id);
    const at = `/schemas/${own.domain.slug}`;
    expect(data!.crumbs.map((c) => c.label)).toEqual(["Domains", own.domain.name, own.product.name, "Events", mine.name]);
    expect(data!.crumbs.map((c) => c.href)).toEqual(["/schemas", at, `${at}/${own.product.slug}`, data!.listHref, undefined]);
  });

  it("links back to the product's Events tab", async () => {
    const data = await route(mine.id);
    expect(data!.listHref.startsWith(`/schemas/${own.domain.slug}/${own.product.slug}?tab=events`)).toBe(true);
  });

  it("opens on the design tab, the metadata section and no item by default", async () => {
    expect(await route(mine.id)).toMatchObject({ initialTab: "design", initialSection: "metadata", initialItem: null });
  });

  it("takes the initial tab, section and item from the route", async () => {
    expect(await route(mine.id, { tab: "docs", section: "channels", item: "orders" })).toMatchObject({
      initialTab: "docs", initialSection: "channels", initialItem: "orders",
    });
    expect(await route(mine.id, { section: "operations" })).toMatchObject({ initialTab: "design", initialSection: "operations", initialItem: null });
    expect(await route(mine.id, { section: "traits", item: "idempotent" })).toMatchObject({ initialSection: "traits", initialItem: "idempotent" });
    expect(await route(mine.id, { section: "advanced" })).toMatchObject({ initialSection: "advanced" });
  });

  it("maps the old spec tabs and the slice-1 preview tab onto design and docs and falls back for anything unknown", async () => {
    expect(await route(mine.id, { tab: "editor" })).toMatchObject({ initialTab: "design" });
    expect(await route(mine.id, { tab: "preview" })).toMatchObject({ initialTab: "docs" });
    expect(await route(mine.id, { tab: "document" })).toMatchObject({ initialTab: "docs" });
    expect(await route(mine.id, { tab: "diagnostics" })).toMatchObject({ initialTab: "docs" });
    expect(await route(mine.id, { tab: "nonsense", section: "nonsense", item: "" })).toMatchObject({ initialTab: "design", initialSection: "metadata", initialItem: null });
  });
});

describe("loadEventPage — library traits", () => {
  const idsOf = (data: NonNullable<Awaited<ReturnType<typeof route>>>) => data.libraryTraits.map((t) => t.id);

  it("offers the tenant-level and the event's own domain's traits, message and operation alike, with kind and level", async () => {
    const data = (await route(mine.id))!;
    expect(data.libraryTraits).toContainEqual({ id: libraryTraits.tenantMessage.id, name: libraryTraits.tenantMessage.name, kind: "MESSAGE", level: "Enterprise" });
    expect(data.libraryTraits).toContainEqual({ id: libraryTraits.tenantOperation.id, name: libraryTraits.tenantOperation.name, kind: "OPERATION", level: "Enterprise" });
    expect(data.libraryTraits).toContainEqual({
      id: libraryTraits.domainMessage.id, name: libraryTraits.domainMessage.name, kind: "MESSAGE", level: `Domain · ${own.domain.name}`,
    });
    expect(data.libraryTraits).toContainEqual({
      id: libraryTraits.domainOperation.id, name: libraryTraits.domainOperation.name, kind: "OPERATION", level: `Domain · ${own.domain.name}`,
    });
  });

  it("never offers a product-level trait, another domain's trait, or any trait of another tenant", async () => {
    const data = (await route(mine.id))!;
    const offered = idsOf(data);
    for (const hidden of [libraryTraits.productLevel, libraryTraits.otherDomain, libraryTraits.foreignTenant, libraryTraits.foreignTenantLevel]) {
      expect(offered).not.toContain(hidden.id);
    }
    expect(data.libraryTraits.map((t) => t.name).join("|")).not.toContain("Foreign");
  });

  it("offers the same library to every product of the domain, and another domain's event sees that domain's own traits instead", async () => {
    const siblingData = (await loadEventPage({ domainSlug: own.domain.slug, productSlug: siblingProduct.slug, eventId: sibling.id }))!;
    expect(idsOf(siblingData)).toEqual(expect.arrayContaining([libraryTraits.tenantMessage.id, libraryTraits.domainMessage.id]));
    expect(idsOf(siblingData)).not.toContain(libraryTraits.productLevel.id);
    const elsewhereData = (await loadEventPage({ domainSlug: elsewhere.domain.slug, productSlug: elsewhere.product.slug, eventId: otherDomain.id }))!;
    expect(idsOf(elsewhereData)).toEqual(expect.arrayContaining([libraryTraits.tenantMessage.id, libraryTraits.otherDomain.id]));
    expect(idsOf(elsewhereData)).not.toContain(libraryTraits.domainMessage.id);
  });

  it("lists message traits first, then operation traits, each kind by name", async () => {
    const data = (await route(mine.id))!;
    const mineOnly = data.libraryTraits.filter((t) => t.name.endsWith(`-${own.s}`) && !t.name.startsWith("Product") && !t.name.startsWith("Elsewhere"));
    expect(mineOnly.map((t) => t.kind)).toEqual(["MESSAGE", "MESSAGE", "OPERATION", "OPERATION"]);
    const messageNames = mineOnly.filter((t) => t.kind === "MESSAGE").map((t) => t.name);
    expect(messageNames).toEqual([...messageNames].sort());
  });
});

describe("loadEventPage — nothing of another product, tenant or version of the schema", () => {
  it("is null for another product of the same domain and for a product of another domain", async () => {
    expect(await route(sibling.id)).toBeNull();
    expect(await route(otherDomain.id)).toBeNull();
    // Through its own product's route the sibling's event is of course readable.
    const data = await loadEventPage({ domainSlug: own.domain.slug, productSlug: siblingProduct.slug, eventId: sibling.id });
    expect(data).toMatchObject({ productId: siblingProduct.id, event: { id: sibling.id } });
  });

  it("is null for another tenant's event, through our route and through its own route", async () => {
    expect(await route(foreignEvent.id)).toBeNull();
    // The active tenant is TENANT, so the foreign tenant's own route does not even resolve.
    expect(await loadEventPage({ domainSlug: foreign.domain.slug, productSlug: foreign.product.slug, eventId: foreignEvent.id })).toBeNull();
  });

  it("is null for an unknown or empty id", async () => {
    expect(await route("does-not-exist")).toBeNull();
    expect(await route("")).toBeNull();
  });

  it("is null for a route that does not exist", async () => {
    expect(await loadEventPage({ domainSlug: own.domain.slug, productSlug: "no-such-product", eventId: mine.id })).toBeNull();
    expect(await loadEventPage({ domainSlug: "no-such-domain", productSlug: own.product.slug, eventId: mine.id })).toBeNull();
  });

  it("does not log for a plain 404", async () => {
    await route("does-not-exist");
    await route(sibling.id);
    await route(foreignEvent.id);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("is null for a stored v1 document and logs once, naming the row by id and never by name or title", async () => {
    expect(await route(legacy.id)).toBeNull();
    expect(consoleError).toHaveBeenCalledTimes(1);
    const line = String(consoleError.mock.calls[0][0]);
    expect(line).toContain("[loadEventPage]");
    expect(line).toContain(legacy.id);
    expect(line).not.toContain(legacy.name);
    expect(line).not.toContain(SECRET_TITLE);
  });
});
