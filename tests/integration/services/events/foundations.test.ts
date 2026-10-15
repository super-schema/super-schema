import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { pinEdges, replaceReferences } from "@/services/events/schema-references";
import { resolvePin } from "@/services/events/pins";
import { cleanupDomains, connectTestDb, createProductScope, TENANT, testContext } from "./helpers";

let prisma: PrismaClient;
let ctx: ServiceContext;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
});
afterAll(async () => prisma.$disconnect());

describe("events foundations (DB)", () => {
  it("resolvePin defaults to the latest published version, keeps null, rejects foreign versions", async () => {
    let domainId: string | undefined;
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const order = await sc.publishedEntity("Order");
      const draftOnly = await sc.entity("Draft");

      expect(await resolvePin(prisma, TENANT, { entityId: order.entity.id }, "Payload")).toEqual({
        success: true, data: { entityId: order.entity.id, entityVersionId: order.version.id },
      });
      expect(await resolvePin(prisma, TENANT, { entityId: draftOnly.id }, "Payload")).toEqual({
        success: true, data: { entityId: draftOnly.id, entityVersionId: null },
      });
      expect(await resolvePin(prisma, TENANT, { entityId: order.entity.id, entityVersionId: null }, "Payload")).toMatchObject({
        success: true, data: { entityVersionId: null },
      });
      const foreign = await resolvePin(prisma, TENANT, { entityId: draftOnly.id, entityVersionId: order.version.id }, "Payload");
      expect(!foreign.success && foreign.error.message).toMatch(/is not a published version of Draft/);
      const missing = await resolvePin(prisma, TENANT, { entityId: "nope" }, "Headers");
      expect(!missing.success && missing.error.code).toBe("VALIDATION_ERROR");
    } finally {
      await cleanupDomains(prisma, [domainId]);
    }
  });

  it("replaceReferences rewrites all edges from one record", async () => {
    const fromId = `test-${Date.now()}`;
    try {
      await prisma.$transaction((tx) =>
        replaceReferences(tx, { kind: "MESSAGE", id: fromId }, pinEdges({ payload: "v1", headers: null, key: "v2" }), true)
      );
      let rows = await prisma.schemaReference.findMany({ where: { fromId }, orderBy: { role: "asc" } });
      expect(rows.map((r) => [r.role, r.toId, r.isDraft])).toEqual([["PAYLOAD", "v1", true], ["KEY", "v2", true]]);
      await prisma.$transaction((tx) => replaceReferences(tx, { kind: "MESSAGE", id: fromId }, pinEdges({ payload: "v3" }), true));
      rows = await prisma.schemaReference.findMany({ where: { fromId } });
      expect(rows.map((r) => r.toId)).toEqual(["v3"]);
    } finally {
      await prisma.schemaReference.deleteMany({ where: { fromId } });
    }
  });
});
