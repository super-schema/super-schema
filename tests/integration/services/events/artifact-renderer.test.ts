import "dotenv/config"; // before any import that reaches @/lib/db, which reads DB_PROVIDER when first evaluated
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { JsonObject } from "@/lib/event-specs/types";
import type { ServiceContext } from "@/types/service-context";
import { levelNamespace } from "@/lib/events/version-source";
import { createArtifactRenderer } from "@/services/events/artifact-renderer";
import { publishEntity } from "@/services/entity-version.service";
import { cleanupDomains, connectTestDb, createProductScope, TENANT, testContext, unwrap } from "./helpers";

let prisma: PrismaClient;
let ctx: ServiceContext;
let domainId: string | undefined;
let scope: Awaited<ReturnType<typeof createProductScope>>;
let addressVersionId: string;
let addressEntityId: string;
let orderVersionId: string;

/**
 * Fixtures are shared by every test. `publishEntity` writes an immutable PUBLISH_VERSION audit row into the shared dev DB on
 * each call, so the suite publishes exactly twice (Address, Order) — those two exercise the real publish → render path with the
 * generator's real Story 16.6 output. Every other version row (legacy `@tag` text, unresolvable reference) is inserted directly:
 * the renderer reads only `resolvedSource`, `fieldSnapshot` and the FIELD pins.
 */
async function insertVersion(entityId: string, resolvedSource: string, fields: string[], pinnedVersionIds: string[] = []) {
  const version = await prisma.entityVersion.create({
    data: {
      entityId, major: 1, minor: 0, sequence: 1, resolvedSource, changeKind: "INITIAL", publishedById: ctx.userId,
      fieldSnapshot: fields.map((name, i) => ({ name, fieldNumber: i + 1 })),
    },
  });
  for (const toId of pinnedVersionIds) {
    await prisma.schemaReference.create({
      data: { fromKind: "ENTITY_VERSION", fromId: version.id, role: "FIELD", toKind: "ENTITY_VERSION", toId },
    });
  }
  return version;
}

/** The level-derived namespace of a version's entity, from the real slugs (spec §4.4). */
async function levelNamespaceOf(versionId: string): Promise<string> {
  const row = await prisma.entityVersion.findUniqueOrThrow({
    where: { id: versionId },
    select: { entity: { select: { tenant: { select: { slug: true } }, domain: { select: { slug: true } }, product: { select: { slug: true } } } } },
  });
  const { tenant, domain, product } = row.entity;
  return levelNamespace({ tenantSlug: tenant.slug, domainSlug: domain?.slug ?? null, productSlug: product?.slug ?? null });
}

beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
  scope = await createProductScope(prisma, ctx);
  domainId = scope.domain.id;

  const address = await scope.publishedEntity("Address", [{ name: "street", type: "string" }]);
  addressVersionId = address.version.id;
  addressEntityId = address.entity.id;

  // typespecSource null → publish regenerates the source from the rows with the generator's governance overlay
  // (`@Enterprise.dataClassification` on the PII field, `@TypeSpec.OpenAPI.extension("x-tags", …)` on the model).
  const order = await scope.entity("Order", [
    { name: "id", type: "string" },
    { name: "email", type: "string" },
    { name: "total", type: "int32" },
    // by name only, like every real creation path: publish pins the target by resolving the name in the entity's line
    { name: "address", type: "reference", ref: { id: address.entity.id, name: "Address", nameOnly: true } },
    { name: "shipping", type: "reference", ref: { id: address.entity.id, name: "Address", nameOnly: true } },
  ]);
  await prisma.field.updateMany({ where: { entityId: order.id, name: "email" }, data: { classification: "PII" } });
  await prisma.entity.update({ where: { id: order.id }, data: { typespecSource: null, metadata: { tags: ["sales", "core"] } } });
  orderVersionId = unwrap(await publishEntity(order.id, {}, ctx)).id;
}, 180_000);

afterAll(async () => {
  await cleanupDomains(prisma, [domainId]);
  await prisma.$disconnect();
});

describe.sequential("artifact renderer — real @typespec emitters", () => {
  it("renders Avro, inlined JSON Schema and root-first Protobuf for a published, classified + tagged version with a referenced entity; drafts too", async () => {
    const frozen = await prisma.entityVersion.findUniqueOrThrow({ where: { id: orderVersionId }, select: { resolvedSource: true } });
    // The fixture is only meaningful if the frozen text really carries the overlay the renderer must project away.
    expect(frozen.resolvedSource).toContain("@Enterprise.dataClassification(Enterprise.DataClassification.PII)");
    expect(frozen.resolvedSource).toContain('@TypeSpec.OpenAPI.extension("x-tags", #["sales", "core"])');

    const renderer = createArtifactRenderer({ db: prisma });
    const subject = { kind: "version" as const, entityVersionId: orderVersionId, tenantId: TENANT };

    const avro = unwrap(await renderer.render(subject, "avro"));
    expect(avro.artifact).toMatchObject({ format: "avro", schema: { type: "record", name: "Order" } });
    // Level-derived namespace (spec §4.4), and the doubly used reference: the record is declared once (first use), the
    // second use refers to it by its full name.
    const avroSchema = avro.artifact.schema as { namespace: string; fields: Array<{ name: string; type: unknown }> };
    expect(avroSchema.namespace).toBe(`com.superschema.${(await levelNamespaceOf(orderVersionId)).toLowerCase()}`);
    const byName = Object.fromEntries(avroSchema.fields.map((f) => [f.name, f.type]));
    expect(byName.address).toMatchObject({ type: "record", name: "Address", fields: [{ name: "street", type: "string" }] });
    expect(byName.shipping).toBe(`${avroSchema.namespace}.Address`);
    expect(JSON.stringify(avro.artifact.schema).match(/"name":"Address"/g)).toHaveLength(1);

    const json = unwrap(await renderer.render(subject, "json-schema"));
    const schema = json.artifact.schema as JsonObject;
    expect(json.artifact.dialect).toBe("2020-12");
    expect((schema.properties as JsonObject).address).toEqual({ $ref: "#/$defs/Address" });
    // Only the referenced entity: no governance-library enums (DataClassification, AvroLogicalType, …) leak into $defs.
    expect(Object.keys(schema.$defs as JsonObject)).toEqual(["Address"]);
    expect(JSON.stringify(schema)).not.toMatch(/"\$ref":"[^#]/);
    expect(JSON.stringify(schema)).not.toMatch(/DataClassification|x-tags|x-classification/);

    const proto = unwrap(await renderer.render(subject, "protobuf"));
    const text = proto.artifact.schema as string;
    expect(text).toContain("// @RootNode\nmessage Order");
    expect(text.indexOf("message Order")).toBeLessThan(text.indexOf("message Address"));
    expect(text).toContain("string email = 2;");
    expect(text).toContain("Address address = 4;");
    expect(text).toContain("Address shipping = 5;");
    expect(text.match(/^message Address /gm)).toHaveLength(1);

    // A draft (never published) whose reference carries only `referencedEntityName` resolves in the entity's line.
    const draft = await scope.entity("Customer", [
      { name: "name", type: "string" },
      { name: "home", type: "reference", ref: { id: addressEntityId, name: "Address", nameOnly: true } },
    ]);
    const draftAvro = unwrap(await renderer.render({ kind: "draft", entityId: draft.id, tenantId: TENANT }, "avro"));
    expect(draftAvro.artifact.schema).toMatchObject({ name: "Customer", fields: [{ name: "name" }, { name: "home", type: { name: "Address" } }] });

    // …and a by-name reference that matches nothing in the line is a clear diagnostic, not a tsp "unknown identifier"
    const dangling = await scope.entity("Dangling", [{ name: "ghost", type: "reference", ref: { id: "none", name: "Ghost", nameOnly: true } }]);
    const unresolved = await renderer.render({ kind: "draft", entityId: dangling.id, tenantId: TENANT }, "avro");
    expect(!unresolved.success && unresolved.error.code).toBe("UNRESOLVED_REFERENCE");
    expect(!unresolved.success && unresolved.error.message).toContain("Ghost");
  }, 180_000);

  it("renders every format from a version frozen before Story 16.6 (legacy @tag lines, x-classification) with decimal / timestamp / reference fields", async () => {
    const legacy = await scope.entity("Legacy", [{ name: "id", type: "string" }]);
    const version = await insertVersion(
      legacy.id,
      [
        '@tag("sales")',
        "model Legacy {",
        "  id: string;",
        "  total: decimal;",
        "  placedAt: utcDateTime;",
        '  @tag("classification:PII")',
        "  ssn: string;",
        '  @TypeSpec.OpenAPI.extension("x-classification", "CUSTOM")',
        "  note?: string;",
        "  address: Address;",
        "}",
        "",
      ].join("\n"),
      ["id", "total", "placedAt", "ssn", "note", "address"],
      [addressVersionId]
    );

    const renderer = createArtifactRenderer({ db: prisma });
    const subject = { kind: "version" as const, entityVersionId: version.id, tenantId: TENANT };
    const avro = unwrap(await renderer.render(subject, "avro"));
    expect(avro.artifact.schema).toMatchObject({ name: "Legacy" });

    const json = unwrap(await renderer.render(subject, "json-schema"));
    const schema = json.artifact.schema as JsonObject;
    expect((schema.properties as JsonObject).address).toEqual({ $ref: "#/$defs/Address" });
    expect(Object.keys(schema.$defs as JsonObject)).toEqual(["Address"]);
    expect(JSON.stringify(schema)).not.toMatch(/"\$ref":"[^#]/);

    const text = unwrap(await renderer.render(subject, "protobuf")).artifact.schema as string;
    expect(text).toContain("// @RootNode\nmessage Legacy");
    expect(text).toContain("google.protobuf.Timestamp placedAt");
    expect(text).toContain("message Address");
  }, 180_000);

  it("fails with a clear diagnostic when the source references a model that is not in the pinned closure", async () => {
    const lonely = await scope.entity("Lonely", [{ name: "id", type: "string" }]);
    // Referenced by bare name only (no pin), so the program has no declaration for it.
    const version = await insertVersion(lonely.id, "model Lonely {\n  id: string;\n  ghost: Ghost;\n}\n", ["id", "ghost"]);
    const renderer = createArtifactRenderer({ db: prisma });
    for (const format of ["avro", "json-schema", "protobuf"] as const) {
      const r = await renderer.render({ kind: "version", entityVersionId: version.id, tenantId: TENANT }, format);
      expect(!r.success && r.error.code).toBe("ARTIFACT_RENDER_FAILED");
      expect(!r.success && r.error.message).toContain("Lonely@1.0 → " + format);
      expect(!r.success && r.error.message).toContain("Ghost");
    }
  }, 180_000);
});
