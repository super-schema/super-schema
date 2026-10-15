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
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
});
afterAll(async () => prisma.$disconnect());

describe.sequential("artifact renderer — real @typespec emitters", () => {
  it("renders Avro, inlined JSON Schema and root-first Protobuf for a pinned version with a referenced entity; drafts too", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const address = await sc.publishedEntity("Address", [{ name: "street", type: "string" }]);
      const order = await sc.publishedEntity("Order", [
        { name: "id", type: "string" },
        { name: "total", type: "int32" },
        { name: "address", type: "reference", ref: { id: address.entity.id, name: "Address" } },
      ]);
      const renderer = createArtifactRenderer({ db: prisma });
      const subject = { kind: "version" as const, entityVersionId: order.version.id };

      const avro = unwrap(await renderer.render(subject, "avro"));
      expect(avro.artifact).toMatchObject({ format: "avro", schema: { type: "record", name: "Order" } });
      expect(JSON.stringify(avro.artifact.schema)).toContain('"name":"Address"');

      const json = unwrap(await renderer.render(subject, "json-schema"));
      const schema = json.artifact.schema as JsonObject;
      expect(json.artifact.dialect).toBe("2020-12");
      expect((schema.properties as JsonObject).address).toEqual({ $ref: "#/$defs/Address" });
      expect(Object.keys(schema.$defs as JsonObject)).toEqual(["Address"]);
      expect(JSON.stringify(schema)).not.toMatch(/"\$ref":"[^#]/);

      const proto = unwrap(await renderer.render(subject, "protobuf"));
      const text = proto.artifact.schema as string;
      expect(text).toContain("// @RootNode\nmessage Order");
      expect(text.indexOf("message Order")).toBeLessThan(text.indexOf("message Address"));

      const draft = await sc.entity("Customer", [{ name: "name", type: "string" }]);
      const draftAvro = unwrap(await renderer.render({ kind: "draft", entityId: draft.id }, "avro"));
      expect(draftAvro.artifact.schema).toMatchObject({ name: "Customer" });
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 180_000);

  it("renders every format from a frozen source that still carries legacy @tag lines, with decimal / timestamp / reference fields", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const address = await sc.publishedEntity("Address", [{ name: "street", type: "string" }]);
      const order = await sc.entity("Order", [
        { name: "id", type: "string" },
        { name: "total", type: "decimal" },
        { name: "placedAt", type: "utcDateTime" },
        { name: "address", type: "reference", ref: { id: address.entity.id, name: "Address" } },
      ]);
      // Pre-Track-F text: model- and field-level `@tag(...)` lines are invalid for the real compiler.
      await prisma.entity.update({
        where: { id: order.id },
        data: {
          typespecSource:
            '@tag("sales")\nmodel Order {\n  id: string;\n  total: decimal;\n  placedAt: utcDateTime;\n  @tag("classification:PII")\n  address: Address;\n}\n',
        },
      });
      const version = unwrap(await publishEntity(order.id, {}, ctx));
      const frozen = await prisma.entityVersion.findUniqueOrThrow({ where: { id: version.id }, select: { resolvedSource: true } });
      expect(frozen.resolvedSource).toContain('@tag("sales")');

      const renderer = createArtifactRenderer({ db: prisma });
      const subject = { kind: "version" as const, entityVersionId: version.id };
      const avro = unwrap(await renderer.render(subject, "avro"));
      expect(avro.artifact.schema).toMatchObject({ name: "Order" });

      const json = unwrap(await renderer.render(subject, "json-schema"));
      const schema = json.artifact.schema as JsonObject;
      expect((schema.properties as JsonObject).address).toEqual({ $ref: "#/$defs/Address" });
      expect(JSON.stringify(schema)).not.toMatch(/"\$ref":"[^#]/);

      const text = unwrap(await renderer.render(subject, "protobuf")).artifact.schema as string;
      expect(text).toContain("// @RootNode\nmessage Order");
      expect(text).toContain("google.protobuf.Timestamp placedAt");
      expect(text).toContain("message Address");
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 180_000);

  it("fails with a clear diagnostic when the source references a model that is not in the pinned closure", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const lonely = await sc.entity("Lonely", [{ name: "id", type: "string" }]);
      // The reference is by bare name only (no `referencedEntityId`), so publish pins nothing for it.
      await prisma.entity.update({
        where: { id: lonely.id },
        data: { typespecSource: "model Lonely {\n  id: string;\n  ghost: Ghost;\n}\n" },
      });
      const published = unwrap(await publishEntity(lonely.id, {}, ctx));
      const renderer = createArtifactRenderer({ db: prisma });
      for (const format of ["avro", "json-schema", "protobuf"] as const) {
        const r = await renderer.render({ kind: "version", entityVersionId: published.id }, format);
        expect(!r.success && r.error.code).toBe("ARTIFACT_RENDER_FAILED");
        expect(!r.success && r.error.message).toContain(`Lonely@${published.label} → ${format}`);
        expect(!r.success && r.error.message).toContain("Ghost");
      }
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  }, 180_000);
});
