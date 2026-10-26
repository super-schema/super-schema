import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { loadReferenceStaleness, previewPublish, publishEntity } from "@/services/entity-version.service";
import { readReferencedVersions } from "@/lib/entity-versioning/referenced-versions";
import { markEntityDraftChanged } from "@/lib/entity-versioning/draft-state";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

// Task 8 against a real PostgreSQL: publish judges an entity against its real reference closure (real compile, real rows), records the
// version of every referenced entity it used in the version's `compatReport`, blocks naming the entity, and reports staleness.

let prisma: PrismaClient;
let ctx: ServiceContext;
const TENANT = "tenant_default";

beforeAll(async () => {
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  const user = await prisma.user.findFirstOrThrow();
  ctx = { userId: user.id, userRole: "AUTHOR", assignments: [{ role: "ADMIN", scope: { kind: "GLOBAL" } }], prisma };
});
afterAll(async () => prisma.$disconnect());

function unwrap<T>(r: Result<T>): T {
  if (!r.success) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data;
}

/** A fresh domain + product; entities and fields created through the helpers live under it. */
async function scope() {
  const s = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const domainName = `ref-${s}`;
  const domain = await prisma.domain.create({ data: { name: domainName, slug: `ref-${s}`, tenantId: TENANT } });
  const product = await prisma.product.create({ data: { domainId: domain.id, name: "P", slug: `p-${s}` } });
  const entity = (name: string) =>
    prisma.entity.create({
      data: { name, slug: `${name.toLowerCase()}-${s}`, tenantId: TENANT, domainId: domain.id, productId: product.id, ownerId: ctx.userId },
    });
  const field = (entityId: string, name: string, opts: { type?: string; sortOrder?: number; decorators?: Record<string, string> } = {}) =>
    prisma.field.create({
      data: { entityId, name, slug: name, type: opts.type ?? "string", nullable: true, sortOrder: opts.sortOrder ?? 0, decorators: opts.decorators ?? {} },
    });
  /** A reference field pointing at `target` by id and qualified name, optionally pinning a published version. */
  const reference = (entityId: string, name: string, target: { id: string; name: string }, pin?: string) =>
    field(entityId, name, {
      type: "reference",
      sortOrder: 1,
      decorators: {
        referencedEntityId: target.id,
        referencedEntityName: target.name,
        referencedQualifiedName: `${domainName}/P/${target.name}`,
        ...(pin ? { referencedEntityVersion: pin } : {}),
      },
    });
  return { domainId: domain.id, domainName, entity, field, reference };
}

async function cleanup(domainId: string | undefined) {
  if (!domainId) return;
  const versions = await prisma.entityVersion.findMany({ where: { entity: { domainId } }, select: { id: true } });
  await prisma.schemaReference.deleteMany({ where: { fromKind: "ENTITY_VERSION", fromId: { in: versions.map((v) => v.id) } } });
  await prisma.domain.deleteMany({ where: { id: domainId } });
}

/** Edits the entity the way the field editor does (flags the draft changed AND the stored source stale), so the next publish is a new version. */
async function addField(sc: Awaited<ReturnType<typeof scope>>, entityId: string, name: string) {
  await sc.field(entityId, name, { sortOrder: 5 });
  await markEntityDraftChanged(prisma, entityId);
}

const recordedOf = async (entityId: string) => {
  const row = await prisma.entityVersion.findFirstOrThrow({ where: { entityId }, orderBy: { sequence: "desc" } });
  return { compatReport: row.compatReport, recorded: readReferencedVersions(row.compatReport) };
};

describe("publish against the real reference closure (PostgreSQL)", () => {
  it("records the version of every referenced entity it used, transitively, in the version's compatReport", async () => {
    let domainId: string | undefined;
    try {
      const sc = await scope();
      domainId = sc.domainId;
      const address = await sc.entity("Address");
      await sc.field(address.id, "street");
      const customer = await sc.entity("Customer");
      await sc.field(customer.id, "name");
      await sc.reference(customer.id, "address", address);
      const order = await sc.entity("Order");
      await sc.field(order.id, "id");
      await sc.reference(order.id, "buyer", customer);

      // Order cannot publish yet: Customer is only a draft, and the message names it.
      const blocked = await publishEntity(order.id, {}, ctx);
      expect(!blocked.success && blocked.error.code).toBe("PUBLISH_BLOCKED");
      expect(!blocked.success && blocked.error.message).toContain("Publish Customer first");

      // Customer cannot publish until Address is.
      const customerBlocked = await publishEntity(customer.id, {}, ctx);
      expect(!customerBlocked.success && customerBlocked.error.message).toContain("Publish Address first");

      unwrap(await publishEntity(address.id, {}, ctx));
      unwrap(await publishEntity(customer.id, {}, ctx));
      const orderV = unwrap(await publishEntity(order.id, {}, ctx));
      expect(orderV.label).toBe("1.0");

      const { compatReport, recorded } = await recordedOf(order.id);
      expect(compatReport).toEqual({
        referencedVersions: [
          { ref: { entityId: customer.id, domain: sc.domainName, product: "P", entity: "Customer" }, version: "1.0", pinned: false },
          { ref: { entityId: address.id, domain: sc.domainName, product: "P", entity: "Address" }, version: "1.0", pinned: false },
        ],
      });
      expect(recorded).toHaveLength(2);
      // What is frozen is still Order's own text.
      const frozen = await prisma.entityVersion.findUniqueOrThrow({ where: { id: orderV.id } });
      expect(frozen.resolvedSource).toContain("model Order");
      expect(frozen.resolvedSource).not.toContain("SuperSchemaClosure");
    } finally {
      await cleanup(domainId);
    }
  });

  it("an entity that references nothing records an empty list", async () => {
    let domainId: string | undefined;
    try {
      const sc = await scope();
      domainId = sc.domainId;
      const solo = await sc.entity("Solo");
      await sc.field(solo.id, "id");
      unwrap(await publishEntity(solo.id, {}, ctx));
      expect((await recordedOf(solo.id)).compatReport).toEqual({ referencedVersions: [] });
    } finally {
      await cleanup(domainId);
    }
  });

  it("reports staleness for an unpinned reference once the referenced entity publishes a newer version, and never for a pinned one", async () => {
    let domainId: string | undefined;
    try {
      const sc = await scope();
      domainId = sc.domainId;
      const customer = await sc.entity("Customer");
      await sc.field(customer.id, "name");
      unwrap(await publishEntity(customer.id, {}, ctx)); // 1.0
      const loose = await sc.entity("Loose");
      await sc.field(loose.id, "id");
      await sc.reference(loose.id, "buyer", customer);
      const pinned = await sc.entity("Pinned");
      await sc.field(pinned.id, "id");
      await sc.reference(pinned.id, "buyer", customer, "1.0");
      unwrap(await publishEntity(loose.id, {}, ctx));
      unwrap(await publishEntity(pinned.id, {}, ctx));
      expect(unwrap(await loadReferenceStaleness(prisma, loose.id))).toEqual([]);

      await addField(sc, customer.id, "email");
      expect(unwrap(await publishEntity(customer.id, {}, ctx)).label).toBe("1.1");

      expect(unwrap(await loadReferenceStaleness(prisma, loose.id))).toEqual([
        { ref: { entityId: customer.id, domain: sc.domainName, product: "P", entity: "Customer" }, recorded: "1.0", latest: "1.1" },
      ]);
      expect(unwrap(await loadReferenceStaleness(prisma, pinned.id))).toEqual([]);
      expect((await recordedOf(pinned.id)).recorded[0]).toMatchObject({ version: "1.0", pinned: true });

      // Publishing Loose again picks up 1.1 and clears the staleness.
      await addField(sc, loose.id, "note");
      unwrap(await publishEntity(loose.id, {}, ctx));
      expect((await recordedOf(loose.id)).recorded[0]).toMatchObject({ version: "1.1", pinned: false });
      expect(unwrap(await loadReferenceStaleness(prisma, loose.id))).toEqual([]);
    } finally {
      await cleanup(domainId);
    }
  });

  it("the SchemaReference edges of a pinned and an unpinned reference point at the versions the publish recorded", async () => {
    let domainId: string | undefined;
    try {
      const sc = await scope();
      domainId = sc.domainId;
      const customer = await sc.entity("Customer");
      await sc.field(customer.id, "name");
      const customer10 = unwrap(await publishEntity(customer.id, {}, ctx));
      const pinned = await sc.entity("Pinned");
      await sc.field(pinned.id, "id");
      await sc.reference(pinned.id, "buyer", customer, "1.0");
      const loose = await sc.entity("Loose");
      await sc.field(loose.id, "id");
      await sc.reference(loose.id, "buyer", customer);
      const pinnedV = unwrap(await publishEntity(pinned.id, {}, ctx));

      await addField(sc, customer.id, "email");
      const customer11 = unwrap(await publishEntity(customer.id, {}, ctx));
      expect(customer11.label).toBe("1.1");
      const looseV = unwrap(await publishEntity(loose.id, {}, ctx));
      // Republishing the pinned entity (its own edit) must keep pointing at the pinned 1.0, not at the now-latest 1.1.
      await addField(sc, pinned.id, "note");
      const pinnedV2 = unwrap(await publishEntity(pinned.id, {}, ctx));

      const edgesOf = async (fromId: string) => (await prisma.schemaReference.findMany({ where: { fromKind: "ENTITY_VERSION", fromId } })).map((e) => e.toId);
      expect(await edgesOf(pinnedV.id)).toEqual([customer10.id]);
      expect(await edgesOf(pinnedV2.id)).toEqual([customer10.id]);
      expect(await edgesOf(looseV.id)).toEqual([customer11.id]);

      // Each edge names the version the same publish recorded for that entity.
      for (const [entityId, version] of [[pinned.id, pinnedV2], [loose.id, looseV]] as const) {
        const [toId] = await edgesOf(version.id);
        const target = await prisma.entityVersion.findUniqueOrThrow({ where: { id: toId } });
        expect((await recordedOf(entityId)).recorded.map((r) => `${r.ref.entityId}@${r.version}`)).toEqual([`${target.entityId}@${target.major}.${target.minor}`]);
      }
    } finally {
      await cleanup(domainId);
    }
  });

  it("a pin whose version does not exist blocks the publish and the preview, naming the field and the version", async () => {
    let domainId: string | undefined;
    try {
      const sc = await scope();
      domainId = sc.domainId;
      const customer = await sc.entity("Customer");
      await sc.field(customer.id, "name");
      unwrap(await publishEntity(customer.id, {}, ctx));
      const order = await sc.entity("Order");
      await sc.field(order.id, "id");
      await sc.reference(order.id, "buyer", customer, "9.9");

      const blocked = await publishEntity(order.id, {}, ctx);
      expect(!blocked.success && blocked.error.code).toBe("PUBLISH_BLOCKED");
      expect(!blocked.success && blocked.error.message).toContain('"buyer"');
      expect(!blocked.success && blocked.error.message).toContain("9.9");
      expect(unwrap(await previewPublish(order.id, ctx)).blockers.map((b) => b.kind)).toContain("CLOSURE_BLOCKED");
      expect(await prisma.entityVersion.count({ where: { entityId: order.id } })).toBe(0);
    } finally {
      await cleanup(domainId);
    }
  });
});
