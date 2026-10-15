import "dotenv/config"; // first: @/lib/db (pulled in by the loader) reads DB_PROVIDER at import time
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { cleanupDomains, connectTestDb, createProductScope, TENANT, testContext } from "./helpers";
import { createForeignTenantFixture } from "./foreign-tenant-fixture";

/**
 * `loadEventSpecPage` against the real database. Only the active tenant (reads a cookie) is replaced. Rows are written
 * directly, so no (immutable) publish audit rows are created.
 */
const h = vi.hoisted(() => ({ tenantId: "" }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: async () => h.tenantId }));

import { loadEventSpecPage } from "@/features/events/event-specs/load-event-spec-page";

let prisma: PrismaClient;
let ctx: ServiceContext;
let own: Awaited<ReturnType<typeof createProductScope>>;
let elsewhere: Awaited<ReturnType<typeof createProductScope>>;
let foreign: Awaited<ReturnType<typeof createForeignTenantFixture>>;

let mine: { id: string; name: string };
let sibling: { id: string; name: string };
let siblingProduct: { id: string; name: string; slug: string };
let otherDomain: { id: string; name: string };
let foreignSpec: { id: string };
let ownChannel: { id: string };
let ownDraft: { id: string };
let operationTrait: { id: string };

/** What another product's draft must never show: ids it references, its title and its unpublished flag. */
const SECRET = "secret-channel-id-from-the-draft";
const SECRET_TITLE = "Secret draft title";

async function createSpec(
  at: { tenantId: string; domainId: string; productId: string },
  name: string,
  versions: Array<{ major: number; minor: number }> = [],
  document: object = { info: { title: name }, servers: [], operations: [] }
) {
  const spec = await prisma.eventSpec.create({ data: { name, ...at, document } });
  let last: string | undefined;
  for (const [i, v] of versions.entries()) {
    const row = await prisma.eventSpecVersion.create({
      data: {
        eventSpecId: spec.id, ...v, sequence: i + 1, changeKind: i === 0 ? "INITIAL" : "MAJOR", publishedById: ctx.userId,
        document: { asyncapi: "3.0.0", info: { title: name, version: `${v.major}.${v.minor}` } },
        sourceDocument: { info: { title: name }, servers: [], operations: [] },
        frozenChannels: [], frozenTraits: [], messageVersionIds: [], compatReport: { reasons: [], diagnostics: [] },
      },
    });
    last = row.id;
  }
  if (last) await prisma.eventSpec.update({ where: { id: spec.id }, data: { latestVersionId: last } });
  return spec;
}

const route = (specId: string, extra: { version?: string; tab?: string } = {}) =>
  loadEventSpecPage({ domainSlug: own.domain.slug, productSlug: own.product.slug, specId, ...extra });

beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
  h.tenantId = TENANT;
  try {
    own = await createProductScope(prisma, ctx, "lsp");
    elsewhere = await createProductScope(prisma, ctx, "lso");
    const at = { tenantId: TENANT, domainId: own.domain.id, productId: own.product.id };
    mine = await createSpec(at, `spec-mine-${own.s}`, [{ major: 1, minor: 0 }, { major: 2, minor: 0 }]);

    siblingProduct = await prisma.product.create({ data: { domainId: own.domain.id, name: `sibling ${own.s}`, slug: `lsp-sib-${own.s}` } });
    const secretDraft = {
      info: { title: SECRET_TITLE },
      servers: [],
      operations: [{ key: "op", action: "send", channelId: SECRET, messageVersionIds: [SECRET], traitIds: [SECRET] }],
    };
    sibling = await createSpec({ ...at, productId: siblingProduct.id }, `spec-sibling-${own.s}`, [{ major: 1, minor: 0 }], secretDraft);
    otherDomain = await createSpec({ tenantId: TENANT, domainId: elsewhere.domain.id, productId: elsewhere.product.id }, `spec-elsewhere-${own.s}`, [{ major: 1, minor: 0 }], secretDraft);
    // Edits after the last publish: the flag a stranger must not see.
    await prisma.eventSpec.updateMany({ where: { id: { in: [sibling.id, otherDomain.id] } }, data: { hasUnpublishedChanges: true } });

    const entity = await own.entity(`Payload${own.s}`);
    ownDraft = await prisma.message.create({ data: { name: `Draft-${own.s}`, payloadEntityId: entity.id, ...at } });
    ownChannel = await prisma.channel.create({ data: { name: `ch-${own.s}`, address: "lsp.orders", protocol: "kafka", format: "avro", ...at } });
    operationTrait = await prisma.trait.create({ data: { name: `OpTrait-${own.s}`, kind: "OPERATION", ...at } });

    foreign = await createForeignTenantFixture(prisma, ctx);
    foreignSpec = await createSpec({ tenantId: foreign.tenant.id, domainId: foreign.domain.id, productId: foreign.product.id }, `spec-foreign-${foreign.s}`, [{ major: 1, minor: 0 }]);
  } catch (e) {
    await foreign?.cleanup().catch(() => undefined);
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
      await cleanupDomains(prisma, [own?.domain.id, elsewhere?.domain.id]);
    } finally {
      await prisma.$disconnect();
    }
  }
});

describe("loadEventSpecPage — this product's spec", () => {
  it("loads the draft with its route, crumbs, pickers and version list", async () => {
    const data = await route(mine.id);
    expect(data).not.toBeNull();
    expect(data!.spec).toMatchObject({ id: mine.id, name: mine.name, productId: own.product.id, tenantId: TENANT, latestVersionLabel: "2.0" });
    expect(data).toMatchObject({ productId: own.product.id, domainSlug: own.domain.slug, productSlug: own.product.slug, viewingVersion: null, initialTab: "editor", owner: null });
    expect(data!.versions.map((v) => v.label)).toEqual(["2.0", "1.0"]);
    expect(data!.crumbs.map((c) => c.label)).toEqual(["Domains", own.domain.name, own.product.name, "Event Specs", mine.name]);
    expect(data!.crumbs[3].href).toBe(`/schemas/${own.domain.slug}/${own.product.slug}?tab=events&section=specs`);
    expect(data!.channelOptions.map((c) => c.id)).toContain(ownChannel.id);
    expect(data!.messageOptions).toContainEqual(expect.objectContaining({ id: ownDraft.id, draft: true, own: true }));
    expect(data!.operationTraits.map((t) => t.id)).toEqual([operationTrait.id]);
  });

  it("never offers another tenant's channels, messages or traits to the pickers", async () => {
    const data = await route(mine.id);
    expect(data!.channelOptions.map((c) => c.id)).not.toContain(foreign.channel.id);
    expect(data!.messageOptions.map((m) => m.id)).not.toContain(foreign.messageVersion.id);
    expect(data!.messageOptions.map((m) => m.messageId)).not.toContain(foreign.message.id);
    expect(data!.operationTraits.map((t) => t.id)).not.toContain(foreign.trait.id);
  });

  it("opens a published version read-only (never on the editor) without loading the editor's pickers", async () => {
    const byLabel = await route(mine.id, { version: "1.0", tab: "editor" });
    expect(byLabel).toMatchObject({ viewingVersion: "1.0", initialTab: "document", owner: null, channelOptions: [], messageOptions: [], operationTraits: [] });
    expect(byLabel!.spec.document.info.title).toBe(mine.name);
    expect(await route(mine.id, { version: "v2.0", tab: "preview" })).toMatchObject({ viewingVersion: "2.0", initialTab: "preview" });
    expect(await route(mine.id, { version: "01.00" })).toMatchObject({ viewingVersion: "1.0" });
  });

  it("answers null for an unknown, draft-named or other spec's version", async () => {
    expect(await route(mine.id, { version: "9.9" })).toBeNull();
    expect(await route(mine.id, { version: "draft" })).toBeNull();
    expect(await route(mine.id, { version: "0.1" })).toBeNull();
  });

  it("falls back to the editor for an unknown ?tab=", async () => {
    expect(await route(mine.id, { tab: "nonsense" })).toMatchObject({ initialTab: "editor" });
    expect(await route(mine.id, { tab: "diagnostics" })).toMatchObject({ initialTab: "diagnostics" });
  });
});

describe("loadEventSpecPage — another product of the tenant (R76)", () => {
  it("is a 404 without ?version: its draft is never readable from here (same domain or another domain)", async () => {
    expect(await route(sibling.id)).toBeNull();
    expect(await route(otherDomain.id)).toBeNull();
    expect(await route(sibling.id, { tab: "document" })).toBeNull();
  });

  it("is readable as a published version, read-only, with the draft replaced by a stub", async () => {
    const data = await route(sibling.id, { version: "1.0" });
    expect(data).not.toBeNull();
    expect(data).toMatchObject({
      viewingVersion: "1.0", initialTab: "document", channelOptions: [], messageOptions: [], operationTraits: [],
      // The route's own product stays the caller (it is what any draft call would pass); nothing here can edit.
      productId: own.product.id, domainSlug: own.domain.slug, productSlug: own.product.slug,
    });
    expect(data!.spec).toEqual({
      id: sibling.id, name: sibling.name, specType: "asyncapi@3.0", latestVersionLabel: "1.0",
      document: { info: { title: sibling.name }, servers: [], operations: [] },
      hasUnpublishedChanges: false, tenantId: TENANT, domainId: null, productId: null,
    });
    expect(data!.versions.map((v) => v.label)).toEqual(["1.0"]);
    // Nothing of the draft survives serialization: not its title, not the ids it references, not its flag.
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(SECRET_TITLE);
    expect(serialized).not.toContain(siblingProduct.id);
  });

  it("names the owning product in the crumbs and links to the canonical page", async () => {
    const data = await route(sibling.id, { version: "1.0" });
    expect(data!.owner).toEqual({
      label: `${own.domain.name} / ${siblingProduct.name}`,
      href: `/schemas/${own.domain.slug}/${siblingProduct.slug}/specs/${sibling.id}?version=1.0`,
    });
    expect(data!.crumbs.map((c) => c.label)).toEqual(["Domains", own.domain.name, siblingProduct.name, "Event Specs", sibling.name]);
    expect(data!.crumbs[3].href).toBe(`/schemas/${own.domain.slug}/${siblingProduct.slug}?tab=events&section=specs`);

    const crossDomain = await route(otherDomain.id, { version: "1.0" });
    expect(crossDomain!.owner!.href).toBe(`/schemas/${elsewhere.domain.slug}/${elsewhere.product.slug}/specs/${otherDomain.id}?version=1.0`);
    expect(JSON.stringify(crossDomain)).not.toContain(SECRET);
  });

  it("is a 404 for a version that does not exist on that spec", async () => {
    expect(await route(sibling.id, { version: "2.0" })).toBeNull();
    expect(await route(sibling.id, { version: "draft" })).toBeNull();
  });

  it("the owning product's own route still opens the draft", async () => {
    const data = await loadEventSpecPage({ domainSlug: own.domain.slug, productSlug: siblingProduct.slug, specId: sibling.id });
    expect(data).toMatchObject({ owner: null, viewingVersion: null, initialTab: "editor", productId: siblingProduct.id });
    expect(data!.spec.document.info.title).toBe(SECRET_TITLE);
  });
});

describe("loadEventSpecPage — nothing outside the tenant, and no oracle", () => {
  it("answers null for another tenant's spec and for an unknown id, with and without a valid version", async () => {
    for (const version of [undefined, "1.0"]) {
      expect(await route(foreignSpec.id, { version })).toBeNull();
      expect(await route("does-not-exist", { version })).toBeNull();
      // Through the foreign tenant's own route while the active tenant is TENANT, the route itself does not resolve.
      expect(await loadEventSpecPage({ domainSlug: foreign.domain.slug, productSlug: foreign.product.slug, specId: foreignSpec.id, version })).toBeNull();
    }
  });

  it("answers null for a route that does not exist, without reading the spec", async () => {
    expect(await loadEventSpecPage({ domainSlug: own.domain.slug, productSlug: "no-such-product", specId: mine.id })).toBeNull();
    expect(await loadEventSpecPage({ domainSlug: "no-such-domain", productSlug: own.product.slug, specId: mine.id })).toBeNull();
  });

  // A label beyond the database's integer range, or hundreds of digits long, must not reach the driver (500 / existence oracle).
  const MALFORMED = ["99999999999.0", "1.99999999999", `${"9".repeat(400)}.0`, `1.${"9".repeat(400)}`, "2147483648.0", "1.2147483648", "abc", "1", "1.0.0", "-1.0", "1.-1", " 1.0", "1.0 ", "1e3.0"];

  it.each(MALFORMED)("answers the same null for the malformed version %#, whichever spec it is asked of", async (version) => {
    const label = version.length > 40 ? version.slice(0, 12) + "…" : version;
    const answers = await Promise.all([mine.id, sibling.id, otherDomain.id, foreignSpec.id, "does-not-exist"].map((id) => route(id, { version })));
    expect(answers, `label ${label}`).toEqual([null, null, null, null, null]);
  });

  it("accepts the largest label the database can store", async () => {
    // 2147483647 is the integer maximum: valid, but no such version exists, so still the same 404 (not an error).
    expect(await route(mine.id, { version: "2147483647.2147483647" })).toBeNull();
  });
});
