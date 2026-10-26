import "dotenv/config"; // first: @/lib/db (pulled in by the loader) reads DB_PROVIDER at import time
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import type { Prisma } from "@/generated/prisma/client";
import { BUNDLED_TRAITS, propertySummary } from "@/lib/events/bundled-traits";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";
import { cleanupDomains, cleanupTenantTraits, connectTestDb, createEventSpecVersion, createProductScope, TENANT, testContext } from "./helpers";
import { createForeignTenantFixture } from "./foreign-tenant-fixture";

/**
 * `loadEventPage` against the real database. Only the active tenant (reads a cookie) is replaced. Rows are written directly,
 * so no (immutable) audit rows are created.
 */
const h = vi.hoisted(() => ({ tenantId: "" }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: async () => h.tenantId }));
// The caller is a platform administrator (the route scope reads the principal): these suites are about the rows the loaders return, not about who may ask.
vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/access/principal", () => {
  const admin = { userId: "admin-1", email: "admin@example.test", assignments: [{ role: "ADMIN", scope: { kind: "GLOBAL" } }], isGlobalAdmin: true };
  return { getPrincipal: async () => admin, loadPrincipalById: async () => admin };
});

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
  otherDomain: { id: string; name: string };
  foreignTenant: { id: string; name: string }; foreignTenantLevel: { id: string; name: string };
  /** A tenant-level trait stored exactly like a built-in one (marker + inline CloudEvents headers), and a custom domain trait with inline headers. */
  tenantBuiltIn: { id: string; name: string }; domainInline: { id: string; name: string };
};
const CLOUDEVENTS = BUNDLED_TRAITS.find((t) => t.id === "cloudevents@1.0")!;
// Stored like the real built-in (marker + inline headers) but with a marker of its own: the shared tenant must never hold a second row
// that claims to be `cloudevents@1.0`, or `ensureBundledTraits` would take it for the real one.
const BUILT_IN_SPEC = { ...structuredClone(CLOUDEVENTS.spec), "x-bundled": "test-built-in@1" };
const INLINE_SPEC = { summary: "Tenant routing", headers: { type: "object", required: ["tenant"], properties: { tenant: { type: "string", description: "Owning tenant" }, retries: { type: "integer" } } } };

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

const route = (eventId: string, extra: { tab?: string; section?: string; item?: string; version?: string } = {}) =>
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
    const version = await createEventSpecVersion(prisma, {
      eventSpecId: published.id, major: 1, minor: 2, sequence: 1, document: {}, sourceDocument: {}, frozenTraits: [],
      changeKind: "INITIAL", publishedById: ctx.userId,
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

    const trait = (name: string, kind: "MESSAGE" | "OPERATION", place: { tenantId: string; domainId?: string; productId?: string }, spec?: object) =>
      prisma.trait.create({ data: { name: `${name}-${own.s}`, kind, ...place, ...(spec && { spec: spec as Prisma.InputJsonValue }) }, select: { id: true, name: true } });
    const tenantMessage = await trait("TenantMsg", "MESSAGE", { tenantId: TENANT });
    const tenantOperation = await trait("TenantOp", "OPERATION", { tenantId: TENANT });
    const tenantBuiltIn = await trait("BuiltIn", "MESSAGE", { tenantId: TENANT }, BUILT_IN_SPEC);
    tenantTraitIds.push(tenantMessage.id, tenantOperation.id, tenantBuiltIn.id);
    libraryTraits = {
      tenantBuiltIn,
      domainInline: await trait("Inline", "MESSAGE", { tenantId: TENANT, domainId: own.domain.id }, INLINE_SPEC),
      tenantMessage, tenantOperation,
      domainMessage: await trait("DomainMsg", "MESSAGE", { tenantId: TENANT, domainId: own.domain.id }),
      domainOperation: await trait("DomainOp", "OPERATION", { tenantId: TENANT, domainId: own.domain.id }),
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
    // The Versions and Used by tabs, and the version the Versions tab opens on (an unknown label is the tab's own error, not a 404).
    expect(await route(mine.id)).toMatchObject({ initialVersion: null });
    expect(await route(mine.id, { tab: "versions", version: "1.1" })).toMatchObject({ initialTab: "versions", initialVersion: "1.1" });
    expect(await route(mine.id, { tab: "used-by" })).toMatchObject({ initialTab: "used-by", initialVersion: null });
    expect(await route(mine.id, { version: "" })).toMatchObject({ initialVersion: null });
  });
});

describe("loadEventPage — library traits", () => {
  const idsOf = (data: NonNullable<Awaited<ReturnType<typeof route>>>) => data.libraryTraits.map((t) => t.id);

  it("offers the tenant-level and the event's own domain's traits, message and operation alike, with kind and level", async () => {
    const data = (await route(mine.id))!;
    // a trait with no stored spec carries an empty definition: no properties, not built in
    const plain = { spec: {}, bundled: false, properties: [] };
    expect(data.libraryTraits).toContainEqual({ id: libraryTraits.tenantMessage.id, name: libraryTraits.tenantMessage.name, kind: "MESSAGE", level: "Enterprise", ...plain });
    expect(data.libraryTraits).toContainEqual({ id: libraryTraits.tenantOperation.id, name: libraryTraits.tenantOperation.name, kind: "OPERATION", level: "Enterprise", ...plain });
    expect(data.libraryTraits).toContainEqual({
      id: libraryTraits.domainMessage.id, name: libraryTraits.domainMessage.name, kind: "MESSAGE", level: `Domain · ${own.domain.name}`, ...plain,
    });
    expect(data.libraryTraits).toContainEqual({
      id: libraryTraits.domainOperation.id, name: libraryTraits.domainOperation.name, kind: "OPERATION", level: `Domain · ${own.domain.name}`, ...plain,
    });
  });

  it("carries each trait's stored definition: the spec, the built-in flag and the property rows (so the builder can show them locked)", async () => {
    const data = (await route(mine.id))!;
    const builtIn = data.libraryTraits.find((t) => t.id === libraryTraits.tenantBuiltIn.id)!;
    expect(builtIn).toMatchObject({ kind: "MESSAGE", level: "Enterprise", bundled: true });
    expect(builtIn.spec).toEqual(BUILT_IN_SPEC); // the marker and the inline headers survive the database round trip
    expect([...(builtIn.properties ?? [])].map((p) => p.name).sort()).toEqual(propertySummary(BUILT_IN_SPEC).map((p) => p.name).sort());
    expect(builtIn.properties).toHaveLength(8);
    // required properties lead, in the order of `required`; the database does not keep the order of the others
    expect(builtIn.properties?.slice(0, 4).map((p) => [p.name, p.required])).toEqual([["specversion", true], ["id", true], ["source", true], ["type", true]]);
    expect(builtIn.properties?.slice(4).every((p) => !p.required)).toBe(true);
    expect(builtIn.properties?.[0]).toMatchObject({ name: "specversion", type: "string", description: expect.stringContaining("1.0") });

    const inline = data.libraryTraits.find((t) => t.id === libraryTraits.domainInline.id)!;
    expect(inline).toMatchObject({ kind: "MESSAGE", level: `Domain · ${own.domain.name}`, bundled: false, spec: INLINE_SPEC });
    expect(inline.properties).toEqual([
      { name: "tenant", type: "string", required: true, description: "Owning tenant" },
      { name: "retries", type: "integer", required: false },
    ]);
  });

  it("never offers another domain's trait, or any trait of another tenant", async () => {
    const data = (await route(mine.id))!;
    const offered = idsOf(data);
    for (const hidden of [libraryTraits.otherDomain, libraryTraits.foreignTenant, libraryTraits.foreignTenantLevel]) {
      expect(offered).not.toContain(hidden.id);
    }
    expect(data.libraryTraits.map((t) => t.name).join("|")).not.toContain("Foreign");
  });

  it("offers the same library to every product of the domain, and another domain's event sees that domain's own traits instead", async () => {
    const siblingData = (await loadEventPage({ domainSlug: own.domain.slug, productSlug: siblingProduct.slug, eventId: sibling.id }))!;
    expect(idsOf(siblingData)).toEqual(expect.arrayContaining([libraryTraits.tenantMessage.id, libraryTraits.domainMessage.id]));
    const elsewhereData = (await loadEventPage({ domainSlug: elsewhere.domain.slug, productSlug: elsewhere.product.slug, eventId: otherDomain.id }))!;
    expect(idsOf(elsewhereData)).toEqual(expect.arrayContaining([libraryTraits.tenantMessage.id, libraryTraits.otherDomain.id]));
    expect(idsOf(elsewhereData)).not.toContain(libraryTraits.domainMessage.id);
  });

  it("lists message traits first, then operation traits, each kind by name", async () => {
    const data = (await route(mine.id))!;
    const mineOnly = data.libraryTraits.filter((t) => t.name.endsWith(`-${own.s}`) && !t.name.startsWith("Product") && !t.name.startsWith("Elsewhere"));
    expect(mineOnly.map((t) => t.kind)).toEqual(["MESSAGE", "MESSAGE", "MESSAGE", "MESSAGE", "OPERATION", "OPERATION"]);
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
