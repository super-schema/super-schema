import "dotenv/config"; // first: @/lib/db (pulled in by the loader) reads DB_PROVIDER at import time
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";

// The route's tenant comes from the cookie-backed `getActiveTenantId`; the tests switch it per case.
const h = vi.hoisted(() => ({ tenantId: "" }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: async () => h.tenantId }));

import { loadMessagePage } from "@/features/events/messages/load-message-page";
import { cleanupDomains, connectTestDb, createProductScope, TENANT, testContext } from "./helpers";
import { createForeignTenantFixture } from "./foreign-tenant-fixture";

let prisma: PrismaClient;
let ctx: ServiceContext;
type Own = Awaited<ReturnType<typeof createProductScope>>;
type Foreign = Awaited<ReturnType<typeof createForeignTenantFixture>>;
let own: Own;
let other: Own;
let foreign: Foreign;
let ownSeed: Awaited<ReturnType<typeof seedMessage>>;
let otherSeed: Awaited<ReturnType<typeof seedMessage>>;

/** A draft message with a published 1.0 (rows written directly: no publish audit rows). */
async function seedMessage(scope: Own, spec: object) {
  const name = `Msg${scope.s}`;
  const entity = await scope.entity(`Payload${scope.s}`);
  const entityVersion = await prisma.entityVersion.create({
    data: {
      entityId: entity.id, major: 1, minor: 0, sequence: 1, resolvedSource: entity.typespecSource ?? "", fieldSnapshot: [],
      changeKind: "INITIAL", publishedById: ctx.userId,
    },
  });
  await prisma.entity.update({ where: { id: entity.id }, data: { latestVersionId: entityVersion.id } });
  const message = await prisma.message.create({
    data: {
      name, spec, payloadEntityId: entity.id, payloadEntityVersionId: entityVersion.id,
      tenantId: TENANT, domainId: scope.domain.id, productId: scope.product.id,
    },
  });
  const resolvedSpec = {
    name, spec: { traitIds: [] },
    payload: { entityId: entity.id, entityName: entity.name, entityVersionId: entityVersion.id, label: "1.0", major: 1 },
    headers: null, key: null,
  };
  const version = await prisma.messageVersion.create({
    data: {
      messageId: message.id, major: 1, minor: 0, sequence: 1, resolvedSpec, payloadEntityVersionId: entityVersion.id,
      changeKind: "INITIAL", publishedById: ctx.userId,
    },
  });
  await prisma.message.update({ where: { id: message.id }, data: { latestVersionId: version.id, hasUnpublishedChanges: true } });
  return { name, entity, message, version, resolvedSpec };
}

async function cleanup() {
  await cleanupDomains(prisma, [own?.domain.id, other?.domain.id]);
  await foreign?.cleanup();
}

beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
  try {
    own = await createProductScope(prisma, ctx, "mp");
    other = await createProductScope(prisma, ctx, "mq");
    ownSeed = await seedMessage(own, { summary: "own draft", traitIds: [] });
    otherSeed = await seedMessage(other, { summary: "secret draft of another product", traitIds: [] });
    foreign = await createForeignTenantFixture(prisma, ctx);
  } catch (e) {
    await cleanup();
    throw e;
  }
}, 60_000);
afterAll(async () => {
  try {
    await cleanup();
  } finally {
    await prisma.$disconnect();
  }
}, 60_000);
beforeEach(() => {
  h.tenantId = TENANT;
});

const ownRoute = () => ({ domainSlug: own.domain.slug, productSlug: own.product.slug });

/** Spec §10 / R66: the page loader is the only scoping layer in front of the unscoped by-id reads. */
describe("loadMessagePage", () => {
  it("loads the draft of a message of the route's product with its versions, pickers and breadcrumbs", async () => {
    const data = await loadMessagePage({ ...ownRoute(), messageId: ownSeed.message.id });
    expect(data).not.toBeNull();
    expect(data!.message).toMatchObject({ id: ownSeed.message.id, name: ownSeed.name, spec: { summary: "own draft", traitIds: [] }, latestVersionLabel: "1.0", hasUnpublishedChanges: true });
    expect(data!.productId).toBe(own.product.id);
    expect(data!.viewing).toBeNull();
    expect(data!.owner ?? null).toBeNull();
    expect(data!.versions.map((v) => v.label)).toEqual(["1.0"]);
    expect(data!.entityOptions.map((e) => e.id)).toContain(ownSeed.entity.id);
    expect(data!.listHref).toBe(`/schemas/${own.domain.slug}/${own.product.slug}?tab=events&section=messages`);
    expect(data!.crumbs.map((c) => c.label)).toEqual(["Domains", own.domain.name, own.product.name, "Messages", ownSeed.name]);
  });

  it("opens a published version read-only (label or vLabel) and skips the draft pickers", async () => {
    for (const version of ["1.0", "v1.0"]) {
      const data = await loadMessagePage({ ...ownRoute(), messageId: ownSeed.message.id, version });
      expect(data!.viewing).toEqual({ label: "1.0", resolvedSpec: ownSeed.resolvedSpec });
      expect(data!.entityOptions).toEqual([]);
      expect(data!.traitOptions).toEqual([]);
      expect(data!.owner ?? null).toBeNull();
    }
  });

  it("is a 404 for an unknown or malformed version, an unknown message and an unknown route", async () => {
    for (const version of ["2.0", "1.7", "abc", "0.1", "1.0.0"]) {
      expect(await loadMessagePage({ ...ownRoute(), messageId: ownSeed.message.id, version }), version).toBeNull();
    }
    expect(await loadMessagePage({ ...ownRoute(), messageId: "no-such-message" })).toBeNull();
    expect(await loadMessagePage({ domainSlug: own.domain.slug, productSlug: "no-such-product", messageId: ownSeed.message.id })).toBeNull();
    expect(await loadMessagePage({ domainSlug: "no-such-domain", productSlug: own.product.slug, messageId: ownSeed.message.id })).toBeNull();
  });

  it("serves another product's PUBLISHED version read-only, with the owner named and its draft withheld", async () => {
    const data = await loadMessagePage({ ...ownRoute(), messageId: otherSeed.message.id, version: "1.0" });
    expect(data).not.toBeNull();
    expect(data!.viewing).toEqual({ label: "1.0", resolvedSpec: otherSeed.resolvedSpec });
    expect(data!.owner).toEqual({
      label: `${other.domain.name} / ${other.product.name}`,
      href: `/schemas/${other.domain.slug}/${other.product.slug}/messages/${otherSeed.message.id}?version=1.0`,
    });
    expect(data!.versions.map((v) => v.label)).toEqual(["1.0"]);
    expect(data!.crumbs.map((c) => c.label)).toEqual(["Domains", other.domain.name, other.product.name, "Messages", otherSeed.name]);
    expect(data!.entityOptions).toEqual([]);
    // Nothing of the foreign draft reaches the page props (they are serialized to the browser).
    expect(data!.message).toMatchObject({ id: otherSeed.message.id, name: otherSeed.name, spec: { traitIds: [] }, headers: null, key: null, hasUnpublishedChanges: false });
    expect(JSON.stringify(data)).not.toContain("secret draft");
    // The route's own product stays the mutation owner; nothing here ever targets the other product.
    expect(data!.productId).toBe(own.product.id);
  });

  it("never serves another product's draft, or an unknown version of it", async () => {
    expect(await loadMessagePage({ ...ownRoute(), messageId: otherSeed.message.id })).toBeNull();
    expect(await loadMessagePage({ ...ownRoute(), messageId: otherSeed.message.id, version: "9.9" })).toBeNull();
    expect(await loadMessagePage({ ...ownRoute(), messageId: otherSeed.message.id, version: "nope" })).toBeNull();
  });

  it("treats another tenant's message exactly like a missing one, draft or published", async () => {
    const id = foreign.message.id;
    expect(await loadMessagePage({ ...ownRoute(), messageId: id })).toBeNull();
    expect(await loadMessagePage({ ...ownRoute(), messageId: id, version: "1.0" })).toBeNull();
    // ...and the other way round: the foreign tenant's own route cannot read this tenant's message either.
    h.tenantId = foreign.tenant.id;
    const foreignRoute = { domainSlug: foreign.domain.slug, productSlug: foreign.product.slug };
    expect(await loadMessagePage({ ...foreignRoute, messageId: ownSeed.message.id })).toBeNull();
    expect(await loadMessagePage({ ...foreignRoute, messageId: ownSeed.message.id, version: "1.0" })).toBeNull();
    expect(await loadMessagePage({ ...foreignRoute, messageId: otherSeed.message.id, version: "1.0" })).toBeNull();
    // sanity: its own message does load there
    expect((await loadMessagePage({ ...foreignRoute, messageId: id }))?.message.id).toBe(id);
  });

  it("does not resolve this tenant's route slugs from another tenant's session", async () => {
    h.tenantId = foreign.tenant.id;
    expect(await loadMessagePage({ ...ownRoute(), messageId: ownSeed.message.id })).toBeNull();
  });
});
