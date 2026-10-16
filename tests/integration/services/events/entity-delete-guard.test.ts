import "dotenv/config"; // first: @/lib/db (pulled in by the services) reads DB_PROVIDER at import time
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";

const { access } = vi.hoisted(() => ({ access: { userId: "" } }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { id: access.userId } })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// The actions scope every by-id row to the active tenant, which comes from a request cookie: pin it to the default tenant the fixtures use.
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: async () => "tenant_default" }));

import { deleteEntityAction } from "@/app/(dashboard)/schemas/[domainSlug]/actions";
import { deleteEntity } from "@/services/entity.service";
import { createForeignTenantFixture } from "./foreign-tenant-fixture";
import { cleanupDomains, connectTestDb, createProductScope, testContext } from "./helpers";

let prisma: PrismaClient;
let ctx: ServiceContext;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
  access.userId = ctx.userId;
});
afterAll(async () => prisma.$disconnect());

type Scope = Awaited<ReturnType<typeof createProductScope>>;

function failure<T>(r: { success: boolean; data?: T; error?: { code: string; message: string; details?: object; suggestedFix?: string } }) {
  if (r.success || !r.error) throw new Error("expected a failure");
  return r.error;
}

// ── entity -> entity FIELD pins (A-I1 / B-I3) ────────────────────────────────────────────────────

/** An entity with directly inserted published versions (no publish audit rows). */
async function entityWithVersions(sc: Scope, name: string, labels: Array<[number, number]> = [[1, 0]]) {
  const entity = await sc.entity(name);
  const versions = [];
  let sequence = 1;
  for (const [major, minor] of labels) {
    versions.push(
      await prisma.entityVersion.create({
        data: {
          entityId: entity.id, major, minor, sequence: sequence++, resolvedSource: entity.typespecSource ?? "", fieldSnapshot: [],
          changeKind: "INITIAL", publishedById: ctx.userId,
        },
      })
    );
  }
  return { entity, versions };
}

/** The edge a publish writes for a reference field: ENTITY_VERSION (referrer) -> ENTITY_VERSION (referenced), role FIELD. */
const fieldEdge = (fromId: string, toId: string) =>
  prisma.schemaReference.create({ data: { fromKind: "ENTITY_VERSION", fromId, role: "FIELD", toKind: "ENTITY_VERSION", toId, isDraft: false } });

const entityExists = async (id: string) => (await prisma.entity.count({ where: { id } })) === 1;

describe("entity delete guard: published versions of other entities that reference it", () => {
  it("blocks the service delete, names the referrer + versions, keeps everything, and frees it once the referrer is gone", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx, "epin");
      domainId = sc.domain.id;
      const money = await entityWithVersions(sc, "Money", [[1, 0], [2, 0]]);
      const order = await entityWithVersions(sc, "Order", [[1, 0], [1, 1]]);
      await fieldEdge(order.versions[0].id, money.versions[1].id); // Order 1.0 pins Money 2.0
      await fieldEdge(order.versions[1].id, money.versions[1].id); // Order 1.1 too

      const blocked = failure(await deleteEntity(money.entity.id, ctx));
      expect(blocked.code).toBe("IN_USE");
      expect(blocked.message).toBe('Entity "Money" cannot be deleted: it is referenced by published versions of Entity "Order" (v1.0, v1.1).');
      expect(blocked.suggestedFix).toContain('delete the referencing entities first ("Order"');
      expect(blocked.details).toEqual({ traits: [], entities: [{ id: order.entity.id, name: "Order", versions: ["1.0", "1.1"] }] });
      // Nothing was deleted: not the entity, not its versions, not the dangling-edge candidates.
      expect(await entityExists(money.entity.id)).toBe(true);
      expect(await prisma.entityVersion.count({ where: { entityId: money.entity.id } })).toBe(2);
      expect(await prisma.schemaReference.count({ where: { toKind: "ENTITY_VERSION", toId: money.versions[1].id } })).toBe(2);
      expect(await prisma.auditLog.count({ where: { entityType: "Entity", action: "DELETE", entityId: money.entity.id } })).toBe(0);

      // The referrer itself is not referenced, so it can go; its edges go with its versions (H1 trigger) ...
      expect((await deleteEntity(order.entity.id, ctx)).success).toBe(true);
      expect(await prisma.schemaReference.count({ where: { toKind: "ENTITY_VERSION", toId: money.versions[1].id } })).toBe(0);
      // ... and now the referenced entity can be deleted too.
      expect((await deleteEntity(money.entity.id, ctx)).success).toBe(true);
      expect(await entityExists(money.entity.id)).toBe(false);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 60_000);

  it("blocks deleteEntityAction the same way (before the delete, with the remedy in the text) and deletes after the referrer is removed", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx, "epin");
      domainId = sc.domain.id;
      const money = await entityWithVersions(sc, "Money");
      const order = await entityWithVersions(sc, "Order");
      await fieldEdge(order.versions[0].id, money.versions[0].id);

      const blocked = await deleteEntityAction(money.entity.id);
      expect(blocked).toEqual({ error: expect.stringContaining('Entity "Money" cannot be deleted: it is referenced by published versions of Entity "Order" (v1.0).') });
      expect((blocked as { error: string }).error).toContain("Published versions cannot be changed");
      expect(await entityExists(money.entity.id)).toBe(true);
      expect(await prisma.auditLog.count({ where: { entityType: "Entity", action: "DELETE", entityId: money.entity.id } })).toBe(0);

      expect(await deleteEntityAction(order.entity.id)).toEqual({ success: true });
      expect(await deleteEntityAction(money.entity.id)).toEqual({ success: true });
      expect(await entityExists(money.entity.id)).toBe(false);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 60_000);

  it("does not block on a recursive entity: its own versions referencing each other go away with it", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx, "epin");
      domainId = sc.domain.id;
      const tree = await entityWithVersions(sc, "Tree", [[1, 0], [2, 0]]);
      await fieldEdge(tree.versions[1].id, tree.versions[0].id); // Tree 2.0 -> Tree 1.0
      await fieldEdge(tree.versions[1].id, tree.versions[1].id); // and itself

      expect((await deleteEntity(tree.entity.id, ctx)).success).toBe(true);
      expect(await entityExists(tree.entity.id)).toBe(false);

      const again = await entityWithVersions(sc, "Tree2", [[1, 0], [2, 0]]);
      await fieldEdge(again.versions[1].id, again.versions[0].id);
      expect(await deleteEntityAction(again.entity.id)).toEqual({ success: true });
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 60_000);

  it("a referrer in another product or domain of the same tenant blocks too", async () => {
    const domains: string[] = [];
    try {
      const owner = await createProductScope(prisma, ctx, "epin");
      const consumer = await createProductScope(prisma, ctx, "epin");
      domains.push(owner.domain.id, consumer.domain.id);
      const money = await entityWithVersions(owner, "Money");
      const cart = await entityWithVersions(consumer, "Cart");
      await fieldEdge(cart.versions[0].id, money.versions[0].id);

      const blocked = failure(await deleteEntity(money.entity.id, ctx));
      expect(blocked.code).toBe("IN_USE");
      expect(blocked.message).toContain('Entity "Cart" (v1.0)');
    } finally {
      await cleanupDomains(prisma, domains);
    }
  }, 60_000);

  it("never names another tenant's entity: a corrupt cross-tenant edge neither blocks nor leaks, a same-tenant one is named alone", async () => {
    const domains: string[] = [];
    let foreign: Awaited<ReturnType<typeof createForeignTenantFixture>> | undefined;
    try {
      const sc = await createProductScope(prisma, ctx, "epin");
      domains.push(sc.domain.id);
      foreign = await createForeignTenantFixture(prisma, ctx);
      const money = await entityWithVersions(sc, "Money");
      const order = await entityWithVersions(sc, "Order");
      await fieldEdge(foreign.version.id, money.versions[0].id); // the foreign tenant's "Foreign" entity pins Money
      await fieldEdge(order.versions[0].id, money.versions[0].id);

      const blocked = failure(await deleteEntity(money.entity.id, ctx));
      expect(blocked.message).toContain('Entity "Order" (v1.0)');
      expect(blocked.message).not.toContain("Foreign");
      expect(JSON.stringify(blocked.details)).not.toContain(foreign.entity.id);
      const viaAction = (await deleteEntityAction(money.entity.id)) as { error: string };
      expect(viaAction.error).not.toContain("Foreign");

      // Only the foreign edge left: nothing of this tenant references it, so it is not blocked (and nothing is named).
      expect((await deleteEntity(order.entity.id, ctx)).success).toBe(true);
      expect((await deleteEntity(money.entity.id, ctx)).success).toBe(true);
    } finally {
      await foreign?.cleanup();
      await cleanupDomains(prisma, domains);
    }
  }, 60_000);

  it("deletes an entity nothing references (the guard does not over-block), including one that only references others", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx, "epin");
      domainId = sc.domain.id;
      const money = await entityWithVersions(sc, "Money");
      const order = await entityWithVersions(sc, "Order");
      await fieldEdge(order.versions[0].id, money.versions[0].id);
      const lonely = await entityWithVersions(sc, "Lonely");
      const unversioned = await sc.entity("Draft");

      expect((await deleteEntity(order.entity.id, ctx)).success).toBe(true); // references Money, nothing references Order
      expect((await deleteEntity(lonely.entity.id, ctx)).success).toBe(true);
      expect(await deleteEntityAction(unversioned.id)).toEqual({ success: true });
      expect((await deleteEntity(money.entity.id, ctx)).success).toBe(true);
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 60_000);
});
