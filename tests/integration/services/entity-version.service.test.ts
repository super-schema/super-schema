import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  previewPublish,
  publishEntity,
  listEntityVersions,
  getEntityVersion,
  getLatestPublishedVersion,
} from "@/services/entity-version.service";
import { markEntityDraftChanged } from "@/lib/entity-versioning/draft-state";
import { updateEntity } from "@/services/entity.service";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

let prisma: PrismaClient;
let ctx: ServiceContext;
const TENANT = "tenant_default";

beforeAll(async () => {
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  const user = await prisma.user.findFirstOrThrow();
  ctx = { userId: user.id, userRole: "AUTHOR", prisma };
});
afterAll(async () => prisma.$disconnect());

function unwrap<T>(r: Result<T>): T {
  if (!r.success) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data;
}

/** A fresh domain + product; entities/fields created through the helpers live under it. */
async function scope() {
  const s = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const domain = await prisma.domain.create({ data: { name: `ev-${s}`, slug: `ev-${s}`, tenantId: TENANT } });
  const product = await prisma.product.create({ data: { domainId: domain.id, name: "P", slug: `p-${s}` } });
  const entity = (name: string) =>
    prisma.entity.create({
      data: {
        name, slug: `${name.toLowerCase()}-${s}`, tenantId: TENANT, domainId: domain.id, productId: product.id,
        ownerId: ctx.userId, typespecSource: `model ${name} { id: string; }`,
      },
    });
  const field = (
    entityId: string,
    name: string,
    opts: { nullable?: boolean; type?: string; sortOrder?: number; decorators?: Record<string, string> } = {}
  ) =>
    prisma.field.create({
      data: {
        entityId, name, slug: name, type: opts.type ?? "string", nullable: opts.nullable ?? true,
        sortOrder: opts.sortOrder ?? 0, decorators: opts.decorators ?? {},
      },
    });
  return { domainId: domain.id, entity, field };
}

async function cleanup(domainId: string | undefined) {
  if (!domainId) return;
  const versions = await prisma.entityVersion.findMany({ where: { entity: { domainId } }, select: { id: true } });
  await prisma.schemaReference.deleteMany({ where: { fromKind: "ENTITY_VERSION", fromId: { in: versions.map((v) => v.id) } } });
  // Deleting the domain cascades its entities and their versions. The PUBLISH_VERSION rows that
  // publishEntity appends to audit_log are immutable by design (trigger) and are not removed.
  await prisma.domain.deleteMany({ where: { id: domainId } });
}

describe("entity version service", () => {
  it("publishes 1.0, then the suggested MINOR, enforces MAJOR on breaking changes, and allows raising", async () => {
    let domainId: string | undefined;
    try {
      const sc = await scope();
      domainId = sc.domainId;
      const customer = await sc.entity("Customer");
      await sc.field(customer.id, "id", { nullable: false });

      const first = unwrap(await publishEntity(customer.id, {}, ctx));
      expect(first).toMatchObject({ label: "1.0", changeKind: "INITIAL", sequence: 1 });
      expect(await prisma.entity.findUniqueOrThrow({ where: { id: customer.id } })).toMatchObject({
        latestVersionId: first.id, hasUnpublishedChanges: false, version: 1,
      });

      const again = await publishEntity(customer.id, {}, ctx);
      expect(!again.success && again.error.code).toBe("PUBLISH_BLOCKED");

      await sc.field(customer.id, "email", { sortOrder: 1 });
      await markEntityDraftChanged(prisma, customer.id);
      expect(unwrap(await previewPublish(customer.id, ctx)).suggestedBump).toBe("MINOR");
      expect(unwrap(await publishEntity(customer.id, { changeSummary: "add email" }, ctx))).toMatchObject({
        label: "1.1", changeKind: "MINOR", sequence: 2, changeSummary: "add email",
      });

      await prisma.field.deleteMany({ where: { entityId: customer.id, name: "email" } });
      await markEntityDraftChanged(prisma, customer.id);
      const low = await publishEntity(customer.id, { bump: "MINOR" }, ctx);
      expect(!low.success && low.error.code).toBe("BUMP_TOO_LOW");
      expect(unwrap(await publishEntity(customer.id, {}, ctx))).toMatchObject({ label: "2.0", changeKind: "MAJOR", sequence: 3 });

      await prisma.entity.update({ where: { id: customer.id }, data: { description: "docs", hasUnpublishedChanges: true } });
      expect(unwrap(await publishEntity(customer.id, { bump: "MAJOR" }, ctx)).label).toBe("3.0");
      expect((await prisma.entity.findUniqueOrThrow({ where: { id: customer.id } })).version).toBe(4);
    } finally {
      await cleanup(domainId);
    }
  });

  it("blocks until referenced entities are published, then pins their latest version", async () => {
    let domainId: string | undefined;
    try {
      const sc = await scope();
      domainId = sc.domainId;
      const buyer = await sc.entity("Buyer");
      await sc.field(buyer.id, "id", { nullable: false });
      const order = await sc.entity("Order");
      await sc.field(order.id, "buyer", {
        type: "reference",
        decorators: { referencedEntityId: buyer.id, referencedEntityName: "Buyer" },
      });

      const blocked = await publishEntity(order.id, {}, ctx);
      expect(blocked.success).toBe(false);
      if (!blocked.success) expect(blocked.error).toMatchObject({ code: "PUBLISH_BLOCKED", message: "Publish Buyer first" });

      const buyerV = unwrap(await publishEntity(buyer.id, {}, ctx));
      const orderV = unwrap(await publishEntity(order.id, {}, ctx));
      const refs = await prisma.schemaReference.findMany({ where: { fromKind: "ENTITY_VERSION", fromId: orderV.id } });
      expect(refs).toEqual([
        expect.objectContaining({ role: "FIELD", toKind: "ENTITY_VERSION", toId: buyerV.id, isDraft: false }),
      ]);
    } finally {
      await cleanup(domainId);
    }
  });

  it("resolves a by-name reference in the line: blocks until B is published, then pins it", async () => {
    let domainId: string | undefined;
    try {
      const sc = await scope();
      domainId = sc.domainId;
      const seller = await sc.entity("Seller");
      await sc.field(seller.id, "id", { nullable: false });
      const listing = await sc.entity("Listing");
      // Every reference-creating path (type picker, wizard, importers, TypeSpec save) stores only the name.
      await sc.field(listing.id, "seller", { type: "reference", decorators: { referencedEntityName: "seller" } });
      await sc.field(listing.id, "ghost", { type: "reference", decorators: { referencedEntityName: "Ghost" }, sortOrder: 1 });

      const blocked = await publishEntity(listing.id, {}, ctx);
      expect(blocked.success).toBe(false);
      if (!blocked.success) expect(blocked.error).toMatchObject({ code: "PUBLISH_BLOCKED", message: "Publish Seller first" });
      const preview = unwrap(await previewPublish(listing.id, ctx));
      expect(preview.warnings.map((w) => w.entityName)).toEqual(["Ghost"]);

      const sellerV = unwrap(await publishEntity(seller.id, {}, ctx));
      const listingV = unwrap(await publishEntity(listing.id, {}, ctx));
      const refs = await prisma.schemaReference.findMany({ where: { fromKind: "ENTITY_VERSION", fromId: listingV.id } });
      expect(refs).toEqual([
        expect.objectContaining({ role: "FIELD", toKind: "ENTITY_VERSION", toId: sellerV.id, isDraft: false }),
      ]);
    } finally {
      await cleanup(domainId);
    }
  });

  it("creates exactly one version under concurrent publishes", async () => {
    let domainId: string | undefined;
    try {
      const sc = await scope();
      domainId = sc.domainId;
      const race = await sc.entity("Race");
      await sc.field(race.id, "id", { nullable: false });

      const results = await Promise.all([publishEntity(race.id, {}, ctx), publishEntity(race.id, {}, ctx)]);
      expect(results.filter((r) => r.success)).toHaveLength(1);
      const failed = results.find((r) => !r.success);
      expect(failed?.success).toBe(false);
      if (failed && !failed.success) expect(["PUBLISH_BLOCKED", "CONFLICT"]).toContain(failed.error.code);
      expect(await prisma.entityVersion.count({ where: { entityId: race.id } })).toBe(1);
    } finally {
      await cleanup(domainId);
    }
  });

  it("reads versions newest first, by label, and the latest one", async () => {
    let domainId: string | undefined;
    try {
      const sc = await scope();
      domainId = sc.domainId;
      const reader = await sc.entity("Reader");
      await sc.field(reader.id, "id", { nullable: false });
      const v10 = unwrap(await publishEntity(reader.id, {}, ctx));
      await sc.field(reader.id, "note", { sortOrder: 1 });
      // A field-editor edit: flags the draft changed AND the stored source stale (R42).
      await markEntityDraftChanged(prisma, reader.id);
      const v11 = unwrap(await publishEntity(reader.id, {}, ctx));

      expect(unwrap(await listEntityVersions(reader.id, ctx)).map((v) => v.label)).toEqual(["1.1", "1.0"]);
      expect(unwrap(await getEntityVersion(reader.id, "1.0", ctx))).toMatchObject({ id: v10.id, changeKind: "INITIAL" });
      expect(unwrap(await getEntityVersion(reader.id, "v1.1", ctx)).id).toBe(v11.id);
      const frozen = unwrap(await getEntityVersion(reader.id, "1.1", ctx));
      expect((frozen.fieldSnapshot as Array<{ name: string }>).map((f) => f.name)).toEqual(["id", "note"]);
      // R42: 1.1 freezes the regenerated source, which has the field-editor edit (the stored source did not)...
      expect(frozen.resolvedSource).toContain("note");
      // ...it was written back to the entity with the stale marker cleared...
      const afterPublish = await prisma.entity.findUniqueOrThrow({ where: { id: reader.id } });
      expect(afterPublish.typespecSource).toBe(frozen.resolvedSource);
      expect((afterPublish.metadata as Record<string, unknown> | null)?.sourceStale).toBeUndefined();
      // ...and the already-published 1.0 stays immutable.
      expect(unwrap(await getEntityVersion(reader.id, "1.0", ctx)).resolvedSource).toBe("model Reader { id: string; }");

      const missing = await getEntityVersion(reader.id, "9.9", ctx);
      expect(!missing.success && missing.error.code).toBe("NOT_FOUND");
      const bad = await getEntityVersion(reader.id, "nope", ctx);
      expect(!bad.success && bad.error.code).toBe("VALIDATION_ERROR");

      expect(unwrap(await getLatestPublishedVersion(reader.id, ctx))?.id).toBe(v11.id);
      const fresh = await sc.entity("Fresh");
      expect(unwrap(await getLatestPublishedVersion(fresh.id, ctx))).toBeNull();
      const unknown = await getLatestPublishedVersion("does-not-exist", ctx);
      expect(!unknown.success && unknown.error.code).toBe("NOT_FOUND");
    } finally {
      await cleanup(domainId);
    }
  });

  it("regenerates a missing or stale source (stubbing reference targets for the gate) and writes it back; a fresh source is left alone", async () => {
    let domainId: string | undefined;
    try {
      const sc = await scope();
      domainId = sc.domainId;

      // Fresh stored source: published as-is, entity.typespecSource untouched.
      const handWritten = await sc.entity("Hand");
      await sc.field(handWritten.id, "id", { nullable: false });
      await prisma.entity.update({ where: { id: handWritten.id }, data: { typespecSource: "@doc(\"hand written\")\nmodel Hand { id: string; }" } });
      const handV = unwrap(await publishEntity(handWritten.id, {}, ctx));
      const handSource = "@doc(\"hand written\")\nmodel Hand { id: string; }";
      expect(unwrap(await getEntityVersion(handWritten.id, handV.label, ctx)).resolvedSource).toBe(handSource);
      expect((await prisma.entity.findUniqueOrThrow({ where: { id: handWritten.id } })).typespecSource).toBe(handSource);

      // No stored source (and a reference target): regenerated, compiled with a stub for Buyer, written back.
      const buyer = await sc.entity("Buyer");
      await sc.field(buyer.id, "id", { nullable: false });
      unwrap(await publishEntity(buyer.id, {}, ctx));
      const order = await sc.entity("Order");
      await sc.field(order.id, "buyer", {
        type: "reference",
        decorators: { referencedEntityId: buyer.id, referencedEntityName: "Buyer" },
      });
      await prisma.entity.update({ where: { id: order.id }, data: { typespecSource: null } });
      const orderV = unwrap(await publishEntity(order.id, {}, ctx));
      const frozen = unwrap(await getEntityVersion(order.id, orderV.label, ctx));
      expect(frozen.resolvedSource).toContain("buyer");
      expect(frozen.resolvedSource).toContain("Buyer");
      expect(frozen.resolvedSource).not.toContain("model Buyer {}"); // gate stubs are never frozen
      const orderRow = await prisma.entity.findUniqueOrThrow({ where: { id: order.id } });
      expect(orderRow.typespecSource).toBe(frozen.resolvedSource);
    } finally {
      await cleanup(domainId);
    }
  });

  it("a rename or description edit made outside the TypeSpec tab reaches the published source (R45)", async () => {
    let domainId: string | undefined;
    try {
      const sc = await scope();
      domainId = sc.domainId;
      const renamer = await sc.entity("Renamer");
      await sc.field(renamer.id, "id", { nullable: false });
      const meta = async () =>
        (await prisma.entity.findUniqueOrThrow({ where: { id: renamer.id } })).metadata as Record<string, unknown> | null;

      // Rename through the real service: the stored source still says `model Renamer`, so it must be marked stale.
      unwrap(await updateEntity(renamer.id, { name: "Renamed" }, ctx));
      expect((await meta())?.sourceStale).toBe(true);

      const v10 = unwrap(await publishEntity(renamer.id, {}, ctx));
      const frozen10 = unwrap(await getEntityVersion(renamer.id, v10.label, ctx));
      expect(frozen10.resolvedSource).toContain("model Renamed");
      expect(frozen10.resolvedSource).not.toContain("Renamer");
      const afterRename = await prisma.entity.findUniqueOrThrow({ where: { id: renamer.id } });
      expect(afterRename.typespecSource).toBe(frozen10.resolvedSource);
      expect((afterRename.metadata as Record<string, unknown> | null)?.sourceStale).toBeUndefined();

      // A description edit marks it stale again, and the next publish renders it as @doc.
      unwrap(await updateEntity(renamer.id, { description: "Orders placed online" }, ctx));
      expect(await prisma.entity.findUniqueOrThrow({ where: { id: renamer.id } })).toMatchObject({
        hasUnpublishedChanges: true,
        metadata: { sourceStale: true },
      });
      const v11 = unwrap(await publishEntity(renamer.id, {}, ctx));
      expect(unwrap(await getEntityVersion(renamer.id, v11.label, ctx)).resolvedSource).toContain("Orders placed online");
      // The already-published version keeps the source it was published with.
      expect(unwrap(await getEntityVersion(renamer.id, v10.label, ctx)).resolvedSource).not.toContain("Orders placed online");
    } finally {
      await cleanup(domainId);
    }
  });

  it("publishes an entity with model tags or a classified field: the gate strips the generator's @tag lines for the compiler only (R46)", async () => {
    let domainId: string | undefined;
    try {
      const sc = await scope();
      domainId = sc.domainId;

      // (a) entity tags -> `@tag("sales")` on the model; stale source.
      const tagged = await sc.entity("Tagged");
      await sc.field(tagged.id, "id", { nullable: false });
      await prisma.entity.update({ where: { id: tagged.id }, data: { metadata: { tags: ["sales"], sourceStale: true } } });
      const taggedV = unwrap(await publishEntity(tagged.id, {}, ctx));
      const taggedFrozen = unwrap(await getEntityVersion(tagged.id, taggedV.label, ctx));
      expect(taggedFrozen.resolvedSource).toContain('@tag("sales")'); // frozen text is the generator's, not the stripped one
      expect((await prisma.entity.findUniqueOrThrow({ where: { id: tagged.id } })).typespecSource).toBe(taggedFrozen.resolvedSource);

      // (b) PII-classified field -> `@tag("classification:PII")` on the field; missing source.
      const classified = await sc.entity("Classified");
      await sc.field(classified.id, "id", { nullable: false });
      await prisma.field.create({
        data: { entityId: classified.id, name: "email", slug: "email", type: "string", nullable: true, sortOrder: 1, classification: "PII", decorators: {} },
      });
      await prisma.entity.update({ where: { id: classified.id }, data: { typespecSource: null } });
      const classifiedV = unwrap(await publishEntity(classified.id, {}, ctx));
      const classifiedFrozen = unwrap(await getEntityVersion(classified.id, classifiedV.label, ctx));
      expect(classifiedFrozen.resolvedSource).toContain('@tag("classification:PII")');
      expect(classifiedFrozen.resolvedSource).toContain("email");
    } finally {
      await cleanup(domainId);
    }
  });

  it("blocks the publish with the compiler diagnostics when the regenerated source does not compile, and writes nothing", async () => {
    let domainId: string | undefined;
    try {
      const sc = await scope();
      domainId = sc.domainId;
      const broken = await sc.entity("Broken");
      await sc.field(broken.id, "id", { nullable: false });
      // An array whose element type is not a valid TypeSpec type generates `not a type[]`.
      await prisma.field.create({
        data: {
          entityId: broken.id, name: "things", slug: "things", type: "array", nullable: true, sortOrder: 1,
          decorators: { arrayElementType: "not a type!" },
        },
      });
      await markEntityDraftChanged(prisma, broken.id);

      const res = await publishEntity(broken.id, {}, ctx);
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.code).toBe("PUBLISH_BLOCKED");
        expect(res.error.message).toContain("does not compile");
        expect((res.error.details as { diagnostics: unknown[] }).diagnostics.length).toBeGreaterThan(0);
      }
      expect(await prisma.entityVersion.count({ where: { entityId: broken.id } })).toBe(0);
      const row = await prisma.entity.findUniqueOrThrow({ where: { id: broken.id } });
      expect(row).toMatchObject({ latestVersionId: null, hasUnpublishedChanges: true, typespecSource: "model Broken { id: string; }" });
      expect((row.metadata as Record<string, unknown>).sourceStale).toBe(true);
    } finally {
      await cleanup(domainId);
    }
  });
});
