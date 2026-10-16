import "dotenv/config"; // first: @/lib/db (pulled in by the services) reads DB_PROVIDER at import time
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { MAX_EVENT_REFERRERS } from "@/services/events/event-guards";
import { findUsages } from "@/services/events/usage.service";
import { createForeignTenantFixture } from "./foreign-tenant-fixture";
import { cleanupDomains, connectTestDb, createEventSpecVersion, createProductScope, TENANT, testContext, unwrap } from "./helpers";

let prisma: PrismaClient;
let ctx: ServiceContext;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
});
afterAll(async () => prisma.$disconnect());

type Scope = Awaited<ReturnType<typeof createProductScope>>;

const doc = (name: string) => ({ documentVersion: 2, info: { title: name } });

/** An event row under a domain / product (draft only). */
function seedEvent(sc: { domain: { id: string }; product: { id: string } }, name: string, tenantId = TENANT) {
  return prisma.eventSpec.create({ data: { name, document: doc(name), tenantId, domainId: sc.domain.id, productId: sc.product.id } });
}

/**
 * A published version row, inserted directly: these tests do not depend on the publish service (it is built in parallel),
 * only on the rows it writes — an immutable version and `schema_references` edges.
 */
function seedVersion(eventSpecId: string, major: number, minor: number, sequence: number) {
  return createEventSpecVersion(prisma, {
    eventSpecId, major, minor, sequence, document: {}, sourceDocument: {}, frozenTraits: [],
    resolvedSpec: { documentVersion: 2 }, changeKind: "INITIAL", publishedById: ctx.userId,
  });
}

/** An external reference: `from` (a draft event, or a published version) points at a published version of another event. */
function seedEdge(from: { kind: "EVENT_SPEC" | "EVENT_SPEC_VERSION"; id: string }, toVersionId: string) {
  return prisma.schemaReference.create({
    data: { fromKind: from.kind, fromId: from.id, role: "MESSAGE", toKind: "EVENT_SPEC_VERSION", toId: toVersionId, isDraft: from.kind === "EVENT_SPEC" },
  });
}

/** The target event of every test: published as v1.0 and v1.1. */
async function seedTarget(sc: Scope, name = `target-${sc.s}`) {
  const event = await seedEvent(sc, name);
  const v10 = await seedVersion(event.id, 1, 0, 1);
  const v11 = await seedVersion(event.id, 1, 1, 2);
  return { event, v10, v11 };
}

const summary = (rows: Array<{ label: string; isDraft: boolean; target: string }>) => rows.map((u) => [u.label, u.isDraft, u.target]);
const eventHref = (sc: Scope, eventId: string) => `/schemas/${sc.domain.slug}/${sc.product.slug}/events/${eventId}`;

describe("findUsages for an event", () => {
  it("lists another event's published version that references any version of this event", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const target = await seedTarget(sc);
      // Two consumers, each published version pins a different version of the target: both are "uses of this event".
      const first = await seedEvent(sc, `first-${sc.s}`);
      const second = await seedEvent(sc, `second-${sc.s}`);
      const firstVersion = await seedVersion(first.id, 2, 0, 1);
      const secondVersion = await seedVersion(second.id, 1, 3, 1);
      await seedEdge({ kind: "EVENT_SPEC_VERSION", id: firstVersion.id }, target.v10.id);
      await seedEdge({ kind: "EVENT_SPEC_VERSION", id: secondVersion.id }, target.v11.id);

      const uses = unwrap(await findUsages({ kind: "event", eventId: target.event.id }, ctx, TENANT));
      expect(summary(uses).sort()).toEqual(
        [
          [`Event ${first.name} v2.0`, false, `${target.event.name} v1.0`],
          [`Event ${second.name} v1.3`, false, `${target.event.name} v1.1`],
        ].sort(),
      );
      expect(uses.map((u) => u.fromKind)).toEqual(["EVENT_SPEC_VERSION", "EVENT_SPEC_VERSION"]);
      expect(uses.map((u) => u.role)).toEqual(["MESSAGE", "MESSAGE"]);
      const byLabel = Object.fromEntries(uses.map((u) => [u.label, u.href]));
      expect(byLabel[`Event ${first.name} v2.0`]).toBe(eventHref(sc, first.id));
      expect(byLabel[`Event ${second.name} v1.3`]).toBe(eventHref(sc, second.id));
      expect(uses.truncated).toBe(false);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("lists an event that is referenced only by another event's draft, flagged as a draft", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const target = await seedTarget(sc);
      const consumer = await seedEvent(sc, `drafty-${sc.s}`);
      await seedEdge({ kind: "EVENT_SPEC", id: consumer.id }, target.v10.id);

      const uses = unwrap(await findUsages({ kind: "event", eventId: target.event.id }, ctx, TENANT));
      expect(summary(uses)).toEqual([[`Event ${consumer.name} (draft)`, true, `${target.event.name} v1.0`]]);
      expect(uses[0]).toMatchObject({ fromKind: "EVENT_SPEC", role: "MESSAGE", href: eventHref(sc, consumer.id) });
      expect(uses.truncated).toBe(false);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("lists published uses before drafts, and an event holding the reference both ways once per edge", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const target = await seedTarget(sc);
      const consumer = await seedEvent(sc, `both-${sc.s}`);
      // The draft edge is written first on purpose: the published one must still come first.
      await seedEdge({ kind: "EVENT_SPEC", id: consumer.id }, target.v11.id);
      const version = await seedVersion(consumer.id, 1, 0, 1);
      await seedEdge({ kind: "EVENT_SPEC_VERSION", id: version.id }, target.v10.id);

      const uses = unwrap(await findUsages({ kind: "event", eventId: target.event.id }, ctx, TENANT));
      expect(summary(uses)).toEqual([
        [`Event ${consumer.name} v1.0`, false, `${target.event.name} v1.0`],
        [`Event ${consumer.name} (draft)`, true, `${target.event.name} v1.1`],
      ]);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("links a referrer in another product of the tenant to its own product", async () => {
    const domainIds: Array<string | undefined> = [];
    try {
      const sc = await createProductScope(prisma, ctx);
      const other = await createProductScope(prisma, ctx, "con");
      domainIds.push(sc.domain.id, other.domain.id);
      const target = await seedTarget(sc);
      const consumer = await seedEvent(other, `elsewhere-${other.s}`);
      await seedEdge({ kind: "EVENT_SPEC", id: consumer.id }, target.v10.id);

      const uses = unwrap(await findUsages({ kind: "event", eventId: target.event.id }, ctx, TENANT));
      expect(summary(uses)).toEqual([[`Event ${consumer.name} (draft)`, true, `${target.event.name} v1.0`]]);
      expect(uses[0].href).toBe(eventHref(other, consumer.id));
    } finally {
      await cleanupDomains(prisma, domainIds);
    }
  });

  it("does not list the event itself, whether its draft or one of its own versions holds the reference", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const target = await seedTarget(sc);
      const consumer = await seedEvent(sc, `real-${sc.s}`);
      await seedEdge({ kind: "EVENT_SPEC", id: consumer.id }, target.v10.id);
      // The event's own draft and its own v1.1 both point at its v1.0 (the server rejects this; the lookup must not rely on that).
      await seedEdge({ kind: "EVENT_SPEC", id: target.event.id }, target.v10.id);
      await seedEdge({ kind: "EVENT_SPEC_VERSION", id: target.v11.id }, target.v10.id);

      const uses = unwrap(await findUsages({ kind: "event", eventId: target.event.id }, ctx, TENANT));
      expect(summary(uses)).toEqual([[`Event ${consumer.name} (draft)`, true, `${target.event.name} v1.0`]]);
      expect(JSON.stringify(uses)).not.toContain(target.v11.id);
      expect(uses.truncated).toBe(false);

      // With only its own edges left, nothing uses the event.
      await prisma.schemaReference.deleteMany({ where: { fromKind: "EVENT_SPEC", fromId: consumer.id } });
      expect(unwrap(await findUsages({ kind: "event", eventId: target.event.id }, ctx, TENANT))).toEqual([]);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("is tenant-scoped: a foreign event's reference is never listed and a foreign subject is NOT_FOUND", async () => {
    let domainId: string | undefined;
    let foreign: Awaited<ReturnType<typeof createForeignTenantFixture>> | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      foreign = await createForeignTenantFixture(prisma, ctx);
      const target = await seedTarget(sc);
      const mine = await seedEvent(sc, `mine-${sc.s}`);
      await seedEdge({ kind: "EVENT_SPEC", id: mine.id }, target.v10.id);

      // Edges written across the tenant boundary (impossible through the services): a draft and a published version.
      const foreignScope = { domain: foreign.domain, product: foreign.product };
      const foreignDraft = await seedEvent(foreignScope, `foreign-draft-${foreign.s}`, foreign.tenant.id);
      const foreignEvent = await seedEvent(foreignScope, `foreign-pub-${foreign.s}`, foreign.tenant.id);
      const foreignVersion = await seedVersion(foreignEvent.id, 1, 0, 1);
      await seedEdge({ kind: "EVENT_SPEC", id: foreignDraft.id }, target.v10.id);
      await seedEdge({ kind: "EVENT_SPEC_VERSION", id: foreignVersion.id }, target.v11.id);

      const uses = unwrap(await findUsages({ kind: "event", eventId: target.event.id }, ctx, TENANT));
      expect(summary(uses)).toEqual([[`Event ${mine.name} (draft)`, true, `${target.event.name} v1.0`]]);
      // Dropped, not rendered as a "(deleted)" ghost: the foreign ids and names never reach the caller.
      for (const secret of [foreignDraft.id, foreignDraft.name, foreignEvent.id, foreignEvent.name, foreignVersion.id]) {
        expect(JSON.stringify(uses)).not.toContain(secret);
      }

      // A subject of another tenant looks exactly like a missing one, from either side.
      const foreignSubject = await findUsages({ kind: "event", eventId: foreignEvent.id }, ctx, TENANT);
      expect(!foreignSubject.success && foreignSubject.error.code).toBe("NOT_FOUND");
      const fromTheOtherSide = await findUsages({ kind: "event", eventId: target.event.id }, ctx, foreign.tenant.id);
      expect(!fromTheOtherSide.success && fromTheOtherSide.error.code).toBe("NOT_FOUND");
      const missing = await findUsages({ kind: "event", eventId: "nope" }, ctx, TENANT);
      expect(!missing.success && missing.error.code).toBe("NOT_FOUND");

      // Control: the foreign tenant's own lookup of its own event works (the scope is the tenant, not a hard-coded one).
      const foreignTarget = await seedEvent(foreignScope, `foreign-target-${foreign.s}`, foreign.tenant.id);
      const foreignTargetVersion = await seedVersion(foreignTarget.id, 1, 0, 1);
      await seedEdge({ kind: "EVENT_SPEC", id: foreignDraft.id }, foreignTargetVersion.id);
      expect(summary(unwrap(await findUsages({ kind: "event", eventId: foreignTarget.id }, ctx, foreign.tenant.id)))).toEqual([
        [`Event ${foreignDraft.name} (draft)`, true, `${foreignTarget.name} v1.0`],
      ]);
    } finally {
      await cleanupDomains(prisma, [domainId]);
      await foreign?.cleanup();
    }
  }, 60_000);

  it("bounds the list at MAX_EVENT_REFERRERS and flags it truncated only when more existed", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const target = await seedTarget(sc);
      const seedReferrers = async (count: number, from: number) => {
        const ids = Array.from({ length: count }, () => randomUUID());
        await prisma.eventSpec.createMany({
          data: ids.map((id, i) => ({ id, name: `ref-${String(from + i).padStart(3, "0")}-${sc.s}`, document: doc("r"), tenantId: TENANT, domainId: sc.domain.id, productId: sc.product.id })),
        });
        await prisma.schemaReference.createMany({
          data: ids.map((id) => ({ fromKind: "EVENT_SPEC" as const, fromId: id, role: "MESSAGE" as const, toKind: "EVENT_SPEC_VERSION" as const, toId: target.v10.id, isDraft: true })),
        });
      };
      const lookup = async () => unwrap(await findUsages({ kind: "event", eventId: target.event.id }, ctx, TENANT));

      // Exactly at the cap: everything is listed and nothing is hidden.
      await seedReferrers(MAX_EVENT_REFERRERS, 0);
      const atCap = await lookup();
      expect(atCap).toHaveLength(MAX_EVENT_REFERRERS);
      expect(atCap.truncated).toBe(false);

      // Ten more (60 referrers): the list stays bounded and says there is more.
      await seedReferrers(10, MAX_EVENT_REFERRERS);
      const over = await lookup();
      expect(over).toHaveLength(MAX_EVENT_REFERRERS);
      expect(over.truncated).toBe(true);
      expect(over.every((u) => u.isDraft && u.label.startsWith("Event ref-"))).toBe(true);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 60_000);

  it("flags the list truncated when the edge scan limit is hit, still bounded", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const target = await seedTarget(sc);
      const ids = Array.from({ length: 230 }, () => randomUUID());
      await prisma.eventSpec.createMany({
        data: ids.map((id, i) => ({ id, name: `scan-${String(i).padStart(3, "0")}-${sc.s}`, document: doc("r"), tenantId: TENANT, domainId: sc.domain.id, productId: sc.product.id })),
      });
      await prisma.schemaReference.createMany({
        data: ids.map((id) => ({ fromKind: "EVENT_SPEC" as const, fromId: id, role: "MESSAGE" as const, toKind: "EVENT_SPEC_VERSION" as const, toId: target.v11.id, isDraft: true })),
      });

      const uses = unwrap(await findUsages({ kind: "event", eventId: target.event.id }, ctx, TENANT));
      expect(uses).toHaveLength(MAX_EVENT_REFERRERS);
      expect(uses.truncated).toBe(true);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 60_000);

  it("returns an empty list for an event nobody references, including one that was never published", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const target = await seedTarget(sc);
      const none = unwrap(await findUsages({ kind: "event", eventId: target.event.id }, ctx, TENANT));
      expect(none).toEqual([]);
      expect(none.truncated).toBe(false);

      // No versions at all: nothing can reference it.
      const draftOnly = await seedEvent(sc, `draft-only-${sc.s}`);
      const never = unwrap(await findUsages({ kind: "event", eventId: draftOnly.id }, ctx, TENANT));
      expect(never).toEqual([]);
      expect(never.truncated).toBe(false);

      // An edge to some other event's version is not a use of this one.
      const other = await seedTarget(sc, `other-${sc.s}`);
      const consumer = await seedEvent(sc, `consumer-${sc.s}`);
      await seedEdge({ kind: "EVENT_SPEC", id: consumer.id }, other.v10.id);
      expect(unwrap(await findUsages({ kind: "event", eventId: target.event.id }, ctx, TENANT))).toEqual([]);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("tolerates a ghost referrer (source row gone) as plain text, like the entity lookup", async () => {
    let domainId: string | undefined;
    let ghostId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const target = await seedTarget(sc);
      ghostId = `gone-${sc.s}`;
      await seedEdge({ kind: "EVENT_SPEC_VERSION", id: ghostId }, target.v10.id);

      const uses = unwrap(await findUsages({ kind: "event", eventId: target.event.id }, ctx, TENANT));
      expect(summary(uses)).toEqual([[`Event version gone-${sc.s} (deleted)`, false, `${target.event.name} v1.0`]]);
      expect(uses[0].href).toBeNull();
    } finally {
      // cleanupDomains only removes edges of rows under the domain: this ghost is ours to delete.
      if (ghostId) await prisma.schemaReference.deleteMany({ where: { fromId: ghostId } });
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("rejects a malformed event subject without touching the database, and maps a database failure to DB_ERROR", async () => {
    for (const bad of [{ kind: "event" }, { kind: "event", eventId: "" }, { kind: "event", entityId: "e1" }]) {
      const r = await findUsages(bad as never, ctx, TENANT);
      expect(!r.success && r.error.code).toBe("VALIDATION_ERROR");
    }
    const noTenant = await findUsages({ kind: "event", eventId: "e1" }, ctx, "");
    expect(!noTenant.success && noTenant.error.code).toBe("VALIDATION_ERROR");

    const broken = { ...ctx, prisma: { eventSpec: { findFirst: () => Promise.reject(new Error("connection lost")) } } as unknown as PrismaClient };
    const r = await findUsages({ kind: "event", eventId: "e1" }, broken, TENANT);
    expect(!r.success && r.error.code).toBe("DB_ERROR");
  });
});
