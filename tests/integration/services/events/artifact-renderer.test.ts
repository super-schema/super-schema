import "dotenv/config"; // before any import that reaches @/lib/db, which reads DB_PROVIDER when first evaluated
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { JsonObject } from "@/lib/event-specs/types";
import type { ServiceContext } from "@/types/service-context";
import { createArtifactRenderer } from "@/services/events/artifact-renderer";
import { publishEntity } from "@/services/entity-version.service";
import { cleanupDomains, connectTestDb, createProductScope, testContext, unwrap } from "./helpers";

let prisma: PrismaClient;
let ctx: ServiceContext;
let domainId: string | undefined;
let scope: Awaited<ReturnType<typeof createProductScope>>;
let addressVersionId: string;
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

beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
  scope = await createProductScope(prisma, ctx);
  domainId = scope.domain.id;

  const address = await scope.publishedEntity("Address", [{ name: "street", type: "string" }]);
  addressVersionId = address.version.id;

  // typespecSource null → publish regenerates the source from the rows with the generator's governance overlay
  // (`@Enterprise.dataClassification` on the PII field, `@TypeSpec.OpenAPI.extension("x-tags", …)` on the model).
  const order = await scope.entity("Order", [
    { name: "id", type: "string" },
    { name: "email", type: "string" },
    { name: "total", type: "int32" },
    { name: "address", type: "reference", ref: { id: address.entity.id, name: "Address" } },
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
    const subject = { kind: "version" as const, entityVersionId: orderVersionId };

    const avro = unwrap(await renderer.render(subject, "avro"));
    expect(avro.artifact).toMatchObject({ format: "avro", schema: { type: "record", name: "Order" } });
    expect(JSON.stringify(avro.artifact.schema)).toContain('"name":"Address"');

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

    const draft = await scope.entity("Customer", [{ name: "name", type: "string" }]);
    const draftAvro = unwrap(await renderer.render({ kind: "draft", entityId: draft.id }, "avro"));
    expect(draftAvro.artifact.schema).toMatchObject({ name: "Customer" });
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
    const subject = { kind: "version" as const, entityVersionId: version.id };
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
      const r = await renderer.render({ kind: "version", entityVersionId: version.id }, format);
      expect(!r.success && r.error.code).toBe("ARTIFACT_RENDER_FAILED");
      expect(!r.success && r.error.message).toContain("Lonely@1.0 → " + format);
      expect(!r.success && r.error.message).toContain("Ghost");
    }
  }, 180_000);
});
