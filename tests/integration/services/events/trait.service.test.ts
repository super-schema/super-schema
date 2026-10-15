import "dotenv/config"; // first: @/lib/db (pulled in by the service via withAudit) reads DB_PROVIDER at import time
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { createTrait, deleteTrait, updateTrait } from "@/services/events/trait.service";
import { cleanupDomains, cleanupTenantTraits, connectTestDb, createProductScope, TENANT, testContext, unwrap } from "./helpers";

let prisma: PrismaClient;
let ctx: ServiceContext;
beforeAll(async () => {
  prisma = connectTestDb();
  ctx = await testContext(prisma);
});
afterAll(async () => prisma.$disconnect());

describe("trait service", () => {
  it("creates tenant / domain traits, pins MESSAGE headers (default latest) and mirrors the pin in SchemaReference", async () => {
    let domainId: string | undefined;
    const tenantTraits: string[] = [];
    try {
      const sc = await createProductScope(prisma, ctx);
      domainId = sc.domain.id;
      const headers = await sc.publishedEntity("CloudEventsHeaders");

      const tenantTrait = unwrap(
        await createTrait({ level: "TENANT", tenantId: TENANT }, { name: `CloudEvents-${sc.s}`, kind: "MESSAGE", headers: { entityId: headers.entity.id } }, ctx)
      );
      tenantTraits.push(tenantTrait.id);
      expect(tenantTrait).toMatchObject({ domainId: null, productId: null, headers: { entityId: headers.entity.id, entityVersionId: headers.version.id } });
      const refs = await prisma.schemaReference.findMany({ where: { fromKind: "TRAIT", fromId: tenantTrait.id } });
      expect(refs.map((r) => [r.role, r.toKind, r.toId, r.isDraft])).toEqual([["HEADERS", "ENTITY_VERSION", headers.version.id, false]]);

      const tenantOwner = { level: "TENANT" as const, tenantId: TENANT };
      const cleared = unwrap(await updateTrait(tenantTrait.id, { name: tenantTrait.name, spec: { summary: "CE" }, headers: null }, tenantOwner, ctx));
      expect(cleared).toMatchObject({ headers: null, spec: { summary: "CE" } });
      expect(await prisma.schemaReference.count({ where: { fromKind: "TRAIT", fromId: tenantTrait.id } })).toBe(0);

      const op = unwrap(await createTrait({ level: "DOMAIN", domainId: sc.domain.id }, { name: `Retry-${sc.s}`, kind: "OPERATION", spec: { summary: "r" } }, ctx));
      expect(op).toMatchObject({ kind: "OPERATION", domainId: sc.domain.id, productId: null });
      const badHeaders = await createTrait({ level: "DOMAIN", domainId: sc.domain.id }, { name: `Bad-${sc.s}`, kind: "OPERATION", headers: { entityId: headers.entity.id } }, ctx);
      expect(!badHeaders.success && badHeaders.error.code).toBe("VALIDATION_ERROR");

      const wrongOwner = await deleteTrait(op.id, tenantOwner, ctx);
      expect(!wrongOwner.success && wrongOwner.error.code).toBe("FORBIDDEN");
      expect(unwrap(await deleteTrait(op.id, { level: "DOMAIN", domainId: sc.domain.id }, ctx))).toEqual({ id: op.id });
    } finally {
      await cleanupTenantTraits(prisma, tenantTraits);
      await cleanupDomains(prisma, [domainId]);
    }
  });
});
